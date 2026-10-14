"""
acm/conjunctions.py
-------------------
Predictive conjunction screening and the Conjunction Data Message (CDM) registry.

screen():  1. broad phase – propagate copies of every object over the look-ahead horizon
              with the engine's CCD at a coarse warning radius (default 5 km);
           2. refinement – for each candidate pair, propagate just that pair to shortly
              before first contact and sample a 10-minute window at 2 s with linear CCD
              to obtain the true TCA, miss distance, relative speed and approach angle.

annotate_pc():  adds probability of collision (Pc) and encounter-plane geometry to each
              prediction (acm/collision_probability.py); risk is then graded on Pc and miss.

CDMRegistry tracks each predicted encounter from detection to resolution:
    ACTIVE -> MITIGATED (avoidance burns scheduled) -> CLEARED (no longer predicted)
           -> RESOLVED (TCA passed safely) | COLLIDED
"""
import math
from typing import Callable, Dict, List, Optional, Sequence

import numpy as np

from satellite_api.acm.brain import COLLISION_THRESHOLD_KM
from satellite_api.acm.collision_probability import assess
from satellite_api.config import CONFIG
from satellite_api.realworld.cdm_ingest import covariances_for, external_summary, lookup
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


# Pc grading (NASA CARA practice: maneuver consideration at ~1e-4, monitoring from ~1e-6).
WARNING_PC = 1e-6


def risk_level(miss_km: float, pc: Optional[float] = None, pc_max: Optional[float] = None,
               diluted: bool = False) -> str:
    """Risk tier from miss distance and, when available, probability of collision.

    A diluted Pc (the covariance is so large that the Pc is low because of uncertainty, not distance)
    is not evidence of safety: if its maximum over covariance scaling reaches the maneuver threshold,
    the event is at least a WARNING, so it is watched and re-screened instead of being dismissed."""
    if miss_km < CRITICAL_KM or (pc is not None and pc >= CONFIG.pcManeuverThreshold):
        return "CRITICAL"
    if miss_km < WARNING_KM or (pc is not None and pc >= WARNING_PC):
        return "WARNING"
    if diluted and pc_max is not None and pc_max >= CONFIG.pcManeuverThreshold:
        return "WARNING"
    return "WATCH"


def needs_action(cdm: dict) -> bool:
    """Whether an encounter is inside the autopilot's evasion trigger (miss radius or Pc)."""
    pc = cdm.get("pc")
    return cdm["miss_distance_km"] <= EVASION_TRIGGER_KM or (pc is not None and pc >= CONFIG.pcManeuverThreshold)


def annotate_pc(predictions: List[dict], now_ts: float, external_index: Optional[dict] = None,
                element_ages_s: Optional[Dict[str, float]] = None) -> List[dict]:
    """Adds Pc + encounter-plane geometry from the TCA states that screen()/the SGP4 refiner
    attach as `_state_sat`/`_state_obj`, then drops those internal fields.

    `external_index` (ExternalCDMStore.index()): when an external CDM describes the same encounter,
    its Pc/miss are attached for comparison and, if it carries both covariances, Pc is computed
    from those measured covariances instead of the model.
    `element_ages_s` (live catalog mode): object id -> age of its element set, which the model
    covariance grows over (catalog error grows from the element epoch, not from now)."""
    for p in predictions:
        a, b = p.pop("_state_sat", None), p.pop("_state_obj", None)
        rec = lookup(external_index, p["satellite_id"], p["object_id"], p["tca_ts"]) if external_index else None
        cov_sat = cov_obj = None
        if rec is not None:
            p["external"] = external_summary(rec)
            cov_sat, cov_obj = covariances_for(rec)
        if a is None or b is None:
            continue
        p.update(assess(a, b, p["miss_distance_km"], p["tca_ts"] - now_ts,
                        obj_is_owned=p["object_type"] == "SATELLITE", hbr_m=CONFIG.hardBodyRadiusM,
                        covariance_scale=CONFIG.covarianceScale, pc_threshold=CONFIG.pcManeuverThreshold,
                        cov_sat_rtn=cov_sat, cov_obj_rtn=cov_obj,
                        covariance_source=f"CDM {rec['originator']} {rec['message_id']}" if rec else None,
                        obj_element_age_s=(element_ages_s or {}).get(p["object_id"], 0.0)))
    return predictions


RISK_RANK = {"WATCH": 0, "WARNING": 1, "CRITICAL": 2}

PC_HISTORY_LEN = 24
PC_TREND_FACTOR = 3.0     # Pc changes by more than 3x between screenings -> rising / falling


def _record_pc(cdm: dict, pc: Optional[float], now_ts: float):
    """Pc of every screening of this event, and its trend. The ESA Collision Avoidance Challenge (Uriot et
    al. 2022) found the latest CDM's risk to be the strongest single forecast of the final risk, so the
    latest Pc stays the decision value; the history shows whether the event is converging or growing."""
    if pc is None:
        return
    history = cdm.setdefault("pc_history", [])
    history.append([round(now_ts, 1), pc])
    del history[:-PC_HISTORY_LEN]
    if len(history) < 2:
        cdm["pc_trend"] = "new"
        return
    prev, last = max(history[-2][1], 1e-300), max(pc, 1e-300)
    cdm["pc_trend"] = ("rising" if last > prev * PC_TREND_FACTOR else
                       "falling" if last * PC_TREND_FACTOR < prev else "stable")


def _pc_text(p: dict) -> str:
    return f", Pc {p['pc']:.1e}" if p.get("pc") is not None else ""


def _approach_angle_deg(r_sat: np.ndarray, v_sat: np.ndarray, v_rel: np.ndarray) -> float:
    """Direction the object comes from in the satellite's local T-N plane (0° = from ahead, 90° = from +N)."""
    r_hat = r_sat / np.linalg.norm(r_sat)
    n_vec = np.cross(r_sat, v_sat)
    n_hat = n_vec / np.linalg.norm(n_vec)
    t_hat = np.cross(n_hat, r_hat)
    incoming = -v_rel
    return (math.degrees(math.atan2(float(incoming @ n_hat), float(incoming @ t_hat))) + 360.0) % 360.0


def _pair_ballistic(ballistic_a, ballistic_b, k: int):
    if ballistic_a is None and ballistic_b is None:
        return None
    a = np.full(k, np.nan) if ballistic_a is None else np.asarray(ballistic_a, dtype=float)
    b = np.full(k, np.nan) if ballistic_b is None else np.asarray(ballistic_b, dtype=float)
    return np.concatenate([a, b])


def closest_approach(A: np.ndarray, B: np.ndarray, window_s: float = REFINE_WINDOW_S,
                     step_s: float = REFINE_STEP_S, ballistic_a=None, ballistic_b=None):
    """Row-wise closest approach of pairs (A[i], B[i]) over the next `window_s`: linear CCD
    between `step_s` samples. Inputs are not modified. Returns (miss_km, t_offset_s, A_at, B_at),
    where A_at/B_at are the states at the sample nearest each pair's TCA. `ballistic_a/b` are
    optional per-row Cd*A/m arrays (NaN = global)."""
    A, B = A.copy(), B.copy()
    k = len(A)
    pair_b = _pair_ballistic(ballistic_a, ballistic_b, k)
    best_d = np.full(k, np.inf)
    best_t = np.zeros(k)
    best_A = A.copy()
    best_B = B.copy()
    for step in range(int(window_s / step_s)):
        p0 = B[:, :3] - A[:, :3]
        pair = np.vstack([A, B])
        propagate_states(pair, step_s, max_step=step_s, ballistic=pair_b)
        A_next, B_next = pair[:k], pair[k:]
        d = (B_next[:, :3] - A_next[:, :3]) - p0
        dd = np.einsum("ij,ij->i", d, d)
        frac = np.where(dd > 1e-12, np.clip(-np.einsum("ij,ij->i", p0, d) / np.maximum(dd, 1e-12), 0.0, 1.0), 0.0)
        closest = np.linalg.norm(p0 + frac[:, None] * d, axis=1)
        better = closest < best_d
        if better.any():
            best_d[better] = closest[better]
            best_t[better] = step * step_s + frac[better] * step_s
            use_next = (frac[better] > 0.5)[:, None]   # nearest sample to the TCA, for velocities/geometry
            best_A[better] = np.where(use_next, A_next[better], A[better])
            best_B[better] = np.where(use_next, B_next[better], B[better])
        A, B = A_next, B_next
    return best_d, best_t, best_A, best_B


REFINE_GPU_MIN_PAIRS = 1


def _refine_on_gpu(k: int, horizon_s: float) -> bool:
    """Refinement is a short serial integration per pair: worth a GPU launch from a few dozen pairs
    (measured 500 x 20k screen: refinement 5.8 s on the CPU vs < 0.1 s on an RTX 3070 Ti)."""
    from satellite_api import physics_engine
    if physics_engine._ENGINE_MODE in ("cpp", "numpy", "cpu"):
        return False
    from satellite_api import gpu_engine
    return gpu_engine.available() and (k >= REFINE_GPU_MIN_PAIRS or physics_engine._ENGINE_MODE == "cuda")


def screen(sat_states: np.ndarray, debris_states: np.ndarray, sat_ids: Sequence[str], debris_ids: Sequence[str],
           start_ts: float, horizon_s: float, warning_km: float = 5.0,
           engine: Callable = process_conjunctions, priority_pairs: Optional[frozenset] = None,
           max_refine: Optional[int] = None, sat_ballistic=None, debris_ballistic=None) -> List[dict]:
    """Predicts close approaches within `horizon_s` of `start_ts`. Inputs are not modified.

    `sat_ballistic` / `debris_ballistic`: optional per-object Cd*A/m (NaN = global value).

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

    if sat_ballistic is None and debris_ballistic is None:
        _, _, cands = engine(sat0.copy(), deb0.copy(), warning_km, horizon_s)
    else:
        _, _, cands = engine(sat0.copy(), deb0.copy(), warning_km, horizon_s, sat_ballistic, debris_ballistic)
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
    bal_a = bal_b = None
    if sat_ballistic is not None or debris_ballistic is not None:
        sb = np.full(n_sat, np.nan) if sat_ballistic is None else np.asarray(sat_ballistic, dtype=float)
        db = np.full(len(deb0), np.nan) if debris_ballistic is None else np.asarray(debris_ballistic, dtype=float)
        bal_a = sb[s_idx]
        bal_b = np.where(is_deb, db[np.where(is_deb, t_idx, 0)] if len(db) else np.nan,
                         sb[np.where(is_deb, 0, t_idx)])

    # Bring every pair to shortly before its first entry into the warning sphere, then find the true
    # TCA. Large batches run on the GPU (one thread per pair) when one is available.
    t_start = np.maximum(0.0, cands[:, 4] - REFINE_LEAD_S)
    refined = None
    if _refine_on_gpu(k, horizon_s):
        from satellite_api import gpu_engine
        from satellite_api.physics_engine import _drag, _gpu_failed
        try:   # refine_pairs only reads A and B, so the CPU path below can redo it after a GPU failure
            refined = gpu_engine.refine_pairs(A, B, t_start, _drag, bal_a, bal_b, REFINE_WINDOW_S, REFINE_STEP_S)
        except Exception as e:
            _gpu_failed(e)
    if refined is not None:
        best_d, best_t, best_A, best_B = refined
    else:
        order = np.argsort(t_start)
        t_now = 0.0
        for pos, row in enumerate(order):
            dt = t_start[row] - t_now
            if dt > 1e-9:
                rows = order[pos:]
                pair = np.vstack([A[rows], B[rows]])
                propagate_states(pair, dt, ballistic=None if bal_a is None else np.concatenate([bal_a[rows], bal_b[rows]]))
                A[rows], B[rows] = pair[:len(rows)], pair[len(rows):]
                t_now = t_start[row]

        best_d, best_t, best_A, best_B = closest_approach(A, B, ballistic_a=bal_a, ballistic_b=bal_b)

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
            "_state_sat": best_A[i].copy(), "_state_obj": best_B[i].copy(),
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
            risk = risk_level(p["miss_distance_km"], p.get("pc"), p.get("pc_max"), p.get("pc_diluted", False))
            if match is None:
                self._seq += 1
                cdm = {
                    "cdm_id": f"CDM-{self._seq:05d}", **p, "tca": iso_z(p["tca_ts"]),
                    "risk": risk, "peak_risk": risk, "status": "ACTIVE",
                    "min_predicted_miss_km": p["miss_distance_km"], "initial_miss_km": p["miss_distance_km"],
                    "peak_pc": p.get("pc"), "initial_pc": p.get("pc"),
                    "mitigation_burn_ids": [], "detected_at": iso_z(now_ts), "updated_at": iso_z(now_ts),
                    "final_status_at": None,
                }
                _record_pc(cdm, p.get("pc"), now_ts)
                self.items.append(cdm)
                stats["new"] += 1
                seen.add(cdm["cdm_id"])
                if risk != "WATCH":
                    emit("crit" if risk == "CRITICAL" else "warn", "conjunction",
                         f"{risk.title()} conjunction with {p['object_id']}: {p['miss_distance_km'] * 1000:.0f} m "
                         f"miss{_pc_text(p)} at {iso_z(p['tca_ts'], millis=False)[11:19]} UTC",
                         satellite_id=p["satellite_id"], cdm_id=cdm["cdm_id"])
                continue
            seen.add(match["cdm_id"])
            stats["updated"] += 1
            previous_risk = match["risk"]
            match.update({**p, "tca": iso_z(p["tca_ts"]), "risk": risk, "updated_at": iso_z(now_ts)})
            _record_pc(match, p.get("pc"), now_ts)
            match["min_predicted_miss_km"] = min(match["min_predicted_miss_km"], p["miss_distance_km"])
            if p.get("pc") is not None:
                match["peak_pc"] = max(match.get("peak_pc") or 0.0, p["pc"])
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
            # this satellite, which the burn was never computed to address. Pc-triggered
            # encounters count too: the planner sizes its burn for those as well.
            if cdm["satellite_id"] == sat_id and cdm["tca_ts"] > now_ts and needs_action(cdm):
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
