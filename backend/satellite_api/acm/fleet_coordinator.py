"""
acm/fleet_coordinator.py
-------------------------
Fleet-wide reasoning layer sitting between AutonomousBrain.plan_evasion() (which plans
each satellite independently) and acm.scheduler's per-satellite validation/queueing.
Operates on the flat List[ManeuverPlan] produced for one planning cycle.

Scores every planned satellite (risk x fuel-remaining x drift x TCA-proximity) for
audit/priority visibility, and re-times ONLY ManeuverPlan.category == STATION_KEEPING
pairs that cluster within CONFIG.fleetStaggerWindowS of each other, spacing them by
CONFIG.fleetStaggerGapS in priority order (highest score = earliest slot = smallest/no
delay). EVASION and EOL plans are never touched - safety-critical, TCA-anchored timing
must not be re-derived here.

Why staggering can't break acm.scheduler.evaluate_sequence's validation:
  * cooldown check only rejects a burn that is too EARLY (burn.ts < next_available_ts);
    a delay-only shift can only help it pass, never fail it.
  * fuel/thrust checks depend only on delta-v magnitude, untouched by timing.
  * the ground-station LOS check is evaluated at uplink time (now_ts), not at burn
    execution time, so pushing a burn later introduces no new LOS failure mode.
"""
from dataclasses import dataclass, field
from typing import Dict, List, Sequence, Tuple

import numpy as np

from satellite_api.acm.brain import Conjunction, ManeuverPlan, STATION_KEEPING
from satellite_api.config import CONFIG


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


@dataclass
class CoordinationNote:
    sat_idx: int
    message: str
    data: dict


@dataclass
class FleetCoordinationResult:
    plans: List[ManeuverPlan]
    priority_scores: Dict[int, float]      # sat_idx -> score, every satellite planned this cycle
    staggered_count: int
    notes: List[CoordinationNote] = field(default_factory=list)


def priority_score(*, risk_component: float, fuel_kg: float, drift_ratio: float, tca_urgency: float) -> float:
    """Deterministic, explainable score: higher = more urgent = earlier slot when contended."""
    fuel_urgency = 1.0 - _clamp01(fuel_kg / CONFIG.initialFuel)
    return (CONFIG.fleetPriorityRiskWeight * _clamp01(risk_component)
            + CONFIG.fleetPriorityFuelWeight * fuel_urgency
            + CONFIG.fleetPriorityDriftWeight * _clamp01(drift_ratio)
            + CONFIG.fleetPriorityTcaWeight * _clamp01(tca_urgency))


def _score_inputs(sat_idx: int, drift_km: np.ndarray, fuels: Sequence[float],
                   conjunctions: List[Conjunction]) -> Tuple[float, float, float, float]:
    sat_conjs = [c for c in conjunctions if c.sat_idx == sat_idx]
    risk_component = max((c.risk_score for c in sat_conjs), default=0.0)
    tca_urgency = max(0.0, 1.0 - min(c.tca_seconds for c in sat_conjs) / CONFIG.cdmHorizonSeconds) if sat_conjs else 0.0
    drift_ratio = float(drift_km[sat_idx]) / CONFIG.stationKeepingRadius
    return risk_component, float(fuels[sat_idx]), drift_ratio, tca_urgency


def coordinate_fleet(plans: List[ManeuverPlan], *, drift_km: np.ndarray, fuels: Sequence[float],
                      conjunctions: List[Conjunction], now_ts: float,
                      locked_satellites: Dict[int, tuple]) -> FleetCoordinationResult:
    """`locked_satellites` (AutonomousBrain.locked_satellites) is mutated in place so a
    staggered satellite's lock-until timestamp stays consistent with its shifted last burn."""
    sat_idxs = sorted({p.sat_idx for p in plans})
    priority_scores = {
        idx: priority_score(risk_component=r, fuel_kg=f, drift_ratio=d, tca_urgency=t)
        for idx, (r, f, d, t) in ((idx, _score_inputs(idx, drift_km, fuels, conjunctions)) for idx in sat_idxs)
    }

    sk_by_sat: Dict[int, List[ManeuverPlan]] = {}
    for p in plans:
        if p.category == STATION_KEEPING:
            sk_by_sat.setdefault(p.sat_idx, []).append(p)
    for seq in sk_by_sat.values():
        seq.sort(key=lambda p: p.burn_time_offset_s)

    notes: List[CoordinationNote] = []
    staggered_count = 0

    if sk_by_sat:
        ordered_idxs = sorted(sk_by_sat, key=lambda i: sk_by_sat[i][0].burn_time_offset_s)
        clusters: List[List[int]] = []
        for idx in ordered_idxs:
            t1 = sk_by_sat[idx][0].burn_time_offset_s
            if clusters and (t1 - sk_by_sat[clusters[-1][-1]][0].burn_time_offset_s) <= CONFIG.fleetStaggerWindowS:
                clusters[-1].append(idx)
            else:
                clusters.append([idx])

        for cluster in clusters:
            if len(cluster) <= 1:
                continue
            cluster_ranked = sorted(cluster, key=lambda i: priority_scores.get(i, 0.0), reverse=True)
            for rank, idx in enumerate(cluster_ranked):
                delta_t = min(rank * CONFIG.fleetStaggerGapS, CONFIG.fleetStaggerMaxDelayS)
                if delta_t <= 0.0:
                    continue
                for p in sk_by_sat[idx]:
                    p.burn_time_offset_s += delta_t
                if idx in locked_satellites:
                    lock_until, reason = locked_satellites[idx]
                    locked_satellites[idx] = (lock_until + delta_t, reason)
                staggered_count += 1
                notes.append(CoordinationNote(
                    sat_idx=idx,
                    message=f"Station-keeping burn staggered {delta_t:.0f}s to avoid clustering with "
                            f"{len(cluster) - 1} other satellite(s) (priority rank {rank + 1} of {len(cluster)})",
                    data={"delta_t_s": delta_t, "cluster_size": len(cluster), "priority_rank": rank,
                          "priority_score": round(priority_scores.get(idx, 0.0), 4), "decided_at_ts": now_ts},
                ))

    return FleetCoordinationResult(plans=plans, priority_scores=priority_scores,
                                    staggered_count=staggered_count, notes=notes)
