"""
acm/conjunctions.py
-------------------
Predictive conjunction screening and the Conjunction Data Message (CDM) registry.

screen():  1. broad phase – propagate copies of every object over the look-ahead horizon
              with the engine's CCD at a coarse warning radius (default 5 km);
           2. refinement – for each candidate pair, propagate just that pair to shortly
              before first contact and sample a 10-minute window at 2 s with linear CCD
              to obtain the true TCA, miss distance, relative speed and approach angle.

CDMRegistry tracks each predicted encounter from detection to resolution:
    ACTIVE -> MITIGATED (avoidance burns scheduled) -> CLEARED (no longer predicted)
           -> RESOLVED (TCA passed safely) | COLLIDED
"""
import math
from typing import Callable, Dict, List, Optional, Sequence

import numpy as np

from satellite_api.acm.brain import COLLISION_THRESHOLD_KM
from satellite_api.physics_engine import process_conjunctions, propagate_states
from satellite_api.timeutils import iso_z

CRITICAL_KM = 0.1
WARNING_KM = 1.0
REFINE_LEAD_S = 60.0
REFINE_WINDOW_S = 600.0
REFINE_STEP_S = 2.0
MATCH_TCA_S = 300.0
MAX_CDMS = 2000
# Matches AutonomousBrain's own evasion-trigger radius (brain.py): only conjunctions
# this close are ever actually considered by the burn that link_mitigation credits.
EVASION_TRIGGER_KM = COLLISION_THRESHOLD_KM * 1.5


def risk_level(miss_km: float) -> str:
    if miss_km < CRITICAL_KM:
        return "CRITICAL"
    if miss_km < WARNING_KM:
        return "WARNING"
    return "WATCH"


RISK_RANK = {"WATCH": 0, "WARNING": 1, "CRITICAL": 2}


def _approach_angle_deg(r_sat: np.ndarray, v_sat: np.ndarray, v_rel: np.ndarray) -> float:
    """Direction the object comes from in the satellite's local T-N plane (0° = from ahead, 90° = from +N)."""
    r_hat = r_sat / np.linalg.norm(r_sat)
    n_vec = np.cross(r_sat, v_sat)
    n_hat = n_vec / np.linalg.norm(n_vec)
    t_hat = np.cross(n_hat, r_hat)
    incoming = -v_rel
    return (math.degrees(math.atan2(float(incoming @ n_hat), float(incoming @ t_hat))) + 360.0) % 360.0


def screen(sat_states: np.ndarray, debris_states: np.ndarray, sat_ids: Sequence[str], debris_ids: Sequence[str],
           start_ts: float, horizon_s: float, warning_km: float = 5.0,
           engine: Callable = process_conjunctions, priority_pairs: Optional[frozenset] = None,
           max_refine: Optional[int] = None) -> List[dict]:
    """Predicts close approaches within `horizon_s` of `start_ts`. Inputs are not modified.

    `max_refine` bounds how many broad-phase candidates get the (more expensive) refinement
    pass, for use when the caller has detected it's falling behind its screening cadence
    (see ConjunctionService.run_cycle): `priority_pairs` (satellite_id, object_id) already
    known to be active risks are always kept; remaining slots go to the closest broad-phase
    misses. Anything dropped this cycle is simply re-detected next cycle - broad phase always
    re-scans everything - so this trades this cycle's completeness for staying within budget,
    never permanently loses a threat.
    """
    n_sat = len(sat_states)
    if n_sat == 0 or horizon_s <= 0:
        return []
    sat0 = np.ascontiguousarray(sat_states, dtype=np.float64)
    deb0 = np.ascontiguousarray(debris_states, dtype=np.float64).reshape(-1, 6)

    _, _, cands = engine(sat0.copy(), deb0.copy(), warning_km, horizon_s)
    cands = np.asarray(cands, dtype=np.float64).reshape(-1, 5)
    if len(cands) == 0:
        return []

    k = len(cands)
    s_idx = cands[:, 0].astype(np.int64)
    t_idx = cands[:, 1].astype(np.int64)
    is_deb = cands[:, 2] > 0.5

    if max_refine is not None and k > max_refine:
        object_ids = [debris_ids[t_idx[i]] if is_deb[i] else sat_ids[t_idx[i]] for i in range(k)]
        if priority_pairs:
            is_priority = np.array([(sat_ids[s_idx[i]], object_ids[i]) in priority_pairs for i in range(k)])
        else:
            is_priority = np.zeros(k, dtype=bool)
        # Primary key last: priority candidates first, then nearest broad-phase miss distance.
        order = np.lexsort((cands[:, 3], ~is_priority))[:max_refine]
        cands, s_idx, t_idx, is_deb = cands[order], s_idx[order], t_idx[order], is_deb[order]
        k = max_refine
    A = sat0[s_idx].copy()
    B = np.empty((k, 6))
    if is_deb.any():
        B[is_deb] = deb0[t_idx[is_deb]]
    if (~is_deb).any():
        B[~is_deb] = sat0[t_idx[~is_deb]]

    # Bring every pair to shortly before its first entry into the warning sphere.
    t_start = np.maximum(0.0, cands[:, 4] - REFINE_LEAD_S)
    order = np.argsort(t_start)
    t_now = 0.0
    for pos, row in enumerate(order):
        dt = t_start[row] - t_now
        if dt > 1e-9:
            rows = order[pos:]
            pair = np.vstack([A[rows], B[rows]])
            propagate_states(pair, dt)
            A[rows], B[rows] = pair[:len(rows)], pair[len(rows):]
            t_now = t_start[row]

    # Fine search with linear CCD between 2 s samples.
    best_d = np.full(k, np.inf)
    best_t = np.zeros(k)
    best_A = A.copy()
    best_B = B.copy()
    steps = int(REFINE_WINDOW_S / REFINE_STEP_S)
    for step in range(steps):
        p0 = B[:, :3] - A[:, :3]
        pair = np.vstack([A, B])
        propagate_states(pair, REFINE_STEP_S, max_step=REFINE_STEP_S)
        A_next, B_next = pair[:k], pair[k:]
        d = (B_next[:, :3] - A_next[:, :3]) - p0
        dd = np.einsum("ij,ij->i", d, d)
        frac = np.where(dd > 1e-12, np.clip(-np.einsum("ij,ij->i", p0, d) / np.maximum(dd, 1e-12), 0.0, 1.0), 0.0)
        closest = np.linalg.norm(p0 + frac[:, None] * d, axis=1)
        better = closest < best_d
        if better.any():
            best_d[better] = closest[better]
            best_t[better] = step * REFINE_STEP_S + frac[better] * REFINE_STEP_S
            use_next = (frac[better] > 0.5)[:, None]   # nearest sample to the TCA, for velocities/geometry
            best_A[better] = np.where(use_next, A_next[better], A[better])
            best_B[better] = np.where(use_next, B_next[better], B[better])
        A, B = A_next, B_next

    results = []
    for i in range(k):
        tca_rel = t_start[i] + best_t[i]
        if best_d[i] > warning_km or tca_rel > horizon_s + REFINE_WINDOW_S:
            continue
        v_rel = best_B[i, 3:] - best_A[i, 3:]
        results.append({
            "satellite_id": sat_ids[s_idx[i]],
            "object_id": debris_ids[t_idx[i]] if is_deb[i] else sat_ids[t_idx[i]],
            "object_type": "DEBRIS" if is_deb[i] else "SATELLITE",
            "tca_ts": start_ts + float(tca_rel),
            "miss_distance_km": float(best_d[i]),
            "relative_velocity_kms": float(np.linalg.norm(v_rel)),
            "approach_angle_deg": _approach_angle_deg(best_A[i, :3], best_A[i, 3:], v_rel),
        })
    return results


class CDMRegistry:
    OPEN = ("ACTIVE", "MITIGATED")

    def __init__(self):
        self.items: List[dict] = []
        self._seq = 0

    # ── queries ───────────────────────────────────────────────────────────────
    def open(self) -> List[dict]:
        return [c for c in self.items if c["status"] in self.OPEN]

    def for_satellite(self, sat_id: str) -> List[dict]:
        return [c for c in self.open() if c["satellite_id"] == sat_id]

    def list(self, status: Optional[str] = None, satellite_id: Optional[str] = None) -> List[dict]:
        items = self.items
        if status == "open":
            items = self.open()
        elif status:
            items = [c for c in items if c["status"] == status.upper()]
        if satellite_id:
            items = [c for c in items if c["satellite_id"] == satellite_id]
        return sorted(items, key=lambda c: (c["status"] not in self.OPEN, c["tca_ts"]))

    # ── updates ───────────────────────────────────────────────────────────────
    def apply(self, predictions: List[dict], now_ts: float, emit: Callable) -> Dict[str, int]:
        """Merges a screening run into the registry. Returns counts of new/updated/cleared."""
        stats = {"new": 0, "updated": 0, "cleared": 0}
        seen = set()
        for p in predictions:
            if p["tca_ts"] <= now_ts:
                continue
            match = self._match(p)
            risk = risk_level(p["miss_distance_km"])
            if match is None:
                self._seq += 1
                cdm = {
                    "cdm_id": f"CDM-{self._seq:05d}", **p, "tca": iso_z(p["tca_ts"]),
                    "risk": risk, "peak_risk": risk, "status": "ACTIVE",
                    "min_predicted_miss_km": p["miss_distance_km"], "initial_miss_km": p["miss_distance_km"],
                    "mitigation_burn_ids": [], "detected_at": iso_z(now_ts), "updated_at": iso_z(now_ts),
                    "final_status_at": None,
                }
                self.items.append(cdm)
                stats["new"] += 1
                seen.add(cdm["cdm_id"])
                if risk != "WATCH":
                    emit("crit" if risk == "CRITICAL" else "warn", "conjunction",
                         f"{risk.title()} conjunction with {p['object_id']}: {p['miss_distance_km'] * 1000:.0f} m "
                         f"miss at {iso_z(p['tca_ts'], millis=False)[11:19]} UTC",
                         satellite_id=p["satellite_id"], cdm_id=cdm["cdm_id"])
                continue
            seen.add(match["cdm_id"])
            stats["updated"] += 1
            previous_risk = match["risk"]
            match.update({**p, "tca": iso_z(p["tca_ts"]), "risk": risk, "updated_at": iso_z(now_ts)})
            match["min_predicted_miss_km"] = min(match["min_predicted_miss_km"], p["miss_distance_km"])
            if RISK_RANK[risk] > RISK_RANK[match["peak_risk"]]:
                match["peak_risk"] = risk
            if match["status"] == "CLEARED":
                match["status"] = "MITIGATED" if match["mitigation_burn_ids"] else "ACTIVE"
            elif match["status"] == "MITIGATED" and risk == "CRITICAL":
                # The scheduled avoidance burn hasn't (yet) reduced the risk below
                # CRITICAL by the next screen - reopen so the autopilot reconsiders
                # a follow-up burn instead of treating this encounter as handled.
                match["status"] = "ACTIVE"
            if RISK_RANK[risk] > RISK_RANK[previous_risk] and risk != "WATCH":
                emit("crit" if risk == "CRITICAL" else "warn", "conjunction",
                     f"Conjunction with {p['object_id']} escalated to {risk.lower()} "
                     f"({p['miss_distance_km'] * 1000:.0f} m)", satellite_id=p["satellite_id"], cdm_id=match["cdm_id"])
            elif match["mitigation_burn_ids"] and previous_risk != "WATCH" and risk == "WATCH":
                emit("ok", "conjunction", f"Avoidance effective: {p['object_id']} miss now "
                     f"{p['miss_distance_km']:.2f} km", satellite_id=p["satellite_id"], cdm_id=match["cdm_id"])

        for cdm in self.items:
            if cdm["status"] in self.OPEN and cdm["cdm_id"] not in seen and cdm["tca_ts"] > now_ts:
                cdm["status"] = "CLEARED"
                cdm["risk"] = "WATCH"
                cdm["updated_at"] = iso_z(now_ts)
                stats["cleared"] += 1
                emit("ok", "conjunction", f"Conjunction with {cdm['object_id']} cleared (outside "
                     f"{'the warning radius' if not cdm['mitigation_burn_ids'] else 'warning radius after avoidance'})",
                     satellite_id=cdm["satellite_id"], cdm_id=cdm["cdm_id"])
        self._prune()
        return stats

    def resolve(self, now_ts: float, collision_log: List[tuple], emit: Callable) -> int:
        """Closes encounters whose TCA has passed. collision_log: [(ts, sat_id, object_id)]."""
        closed = 0
        for cdm in self.items:
            if cdm["status"] not in ("ACTIVE", "MITIGATED", "CLEARED") or cdm["tca_ts"] > now_ts:
                continue
            collided = any(sid == cdm["satellite_id"] and oid == cdm["object_id"] and abs(ts - cdm["tca_ts"]) <= 180.0
                           for ts, sid, oid in collision_log)
            cdm["status"] = "COLLIDED" if collided else "RESOLVED"
            cdm["final_status_at"] = iso_z(now_ts)
            closed += 1
            if collided:
                emit("crit", "conjunction", f"Conjunction {cdm['cdm_id']} closed: collision with {cdm['object_id']}",
                     satellite_id=cdm["satellite_id"], cdm_id=cdm["cdm_id"])
            elif cdm["mitigation_burn_ids"] and cdm["peak_risk"] != "WATCH":
                emit("ok", "conjunction", f"Collision avoided: passed {cdm['object_id']} safely",
                     satellite_id=cdm["satellite_id"], cdm_id=cdm["cdm_id"])
        return closed

    def link_mitigation(self, sat_id: str, burn_ids: List[str], now_ts: float) -> List[str]:
        linked = []
        for cdm in self.open():
            # Only credit/mitigate the conjunctions actually close enough to have been
            # part of the threat set the evasion burn was sized against (brain.py uses
            # the same EVASION_TRIGGER_KM radius) - not every other open threat for
            # this satellite, which the burn was never computed to address.
            if (cdm["satellite_id"] == sat_id and cdm["tca_ts"] > now_ts
                    and cdm["miss_distance_km"] <= EVASION_TRIGGER_KM):
                cdm["mitigation_burn_ids"] = list(dict.fromkeys(cdm["mitigation_burn_ids"] + burn_ids))
                cdm["status"] = "MITIGATED"
                linked.append(cdm["cdm_id"])
        return linked

    def counts(self) -> dict:
        by_status: Dict[str, int] = {}
        open_by_risk = {"CRITICAL": 0, "WARNING": 0, "WATCH": 0}
        for c in self.items:
            by_status[c["status"]] = by_status.get(c["status"], 0) + 1
            if c["status"] in self.OPEN:
                open_by_risk[c["risk"]] += 1
        avoided = sum(1 for c in self.items if c["status"] == "RESOLVED" and c["mitigation_burn_ids"]
                      and c["peak_risk"] != "WATCH")
        return {"by_status": by_status, "open_by_risk": open_by_risk, "avoided": avoided, "total": len(self.items)}

    def _match(self, p: dict) -> Optional[dict]:
        for c in self.items:
            if (c["satellite_id"] == p["satellite_id"] and c["object_id"] == p["object_id"]
                    and c["status"] in ("ACTIVE", "MITIGATED", "CLEARED")
                    and abs(c["tca_ts"] - p["tca_ts"]) <= MATCH_TCA_S):
                return c
        return None

    def _prune(self):
        if len(self.items) > MAX_CDMS:
            closed = [c for c in self.items if c["status"] in ("RESOLVED", "COLLIDED")]
            drop = {c["cdm_id"] for c in closed[:len(self.items) - MAX_CDMS]}
            self.items = [c for c in self.items if c["cdm_id"] not in drop]
