"""
acm/decision_support.py
-----------------------
Checks and studies that sit between "the planner proposed a maneuver" and "it is uplinked".

verify_sequence():   re-screens a satellite's *post-maneuver* trajectory against every
                     object whose orbit shell it can reach, segment by segment between burns.
                     That shows whether the primary threat is actually cleared and whether
                     the maneuver creates a new (secondary) close approach.

trade_space():       a single-impulse maneuver trade study for one conjunction: miss distance
                     and Pc at TCA over a grid of burn times and Δv magnitudes along one RTN
                     axis, with the propellant each option costs.

rationale_*():       plain-language explanations recorded with every autopilot decision.

All functions take plain arrays (copied from StateManager under its lock) so callers can run
them in a worker thread.
"""
import math
from typing import Dict, Iterable, List, Optional, Sequence

import numpy as np

from satellite_api.acm.collision_probability import assess, rtn_basis
from satellite_api.acm.conjunctions import annotate_pc, closest_approach, needs_action, screen
from satellite_api.config import CONFIG
from satellite_api.physics_engine import MU_EARTH, process_conjunctions, propagate_states

SHELL_MARGIN_KM = 40.0        # radial slack for the orbit-shell prefilter (burn-induced altitude change)
TRADE_WINDOW_S = 600.0        # fine-search window around the nominal TCA
BRIDGE_STEP_S = 5.0           # RK4 step when carrying states between epochs


def _shell(states: np.ndarray):
    """Perigee and apogee radius [km] of each (N, 6) state (osculating two-body elements)."""
    r = np.linalg.norm(states[:, :3], axis=1)
    v2 = np.einsum("ij,ij->i", states[:, 3:], states[:, 3:])
    a = 1.0 / (2.0 / r - v2 / MU_EARTH)
    h = np.linalg.norm(np.cross(states[:, :3], states[:, 3:]), axis=1)
    e = np.sqrt(np.maximum(0.0, 1.0 - h * h / (MU_EARTH * np.where(a > 0, a, np.inf))))
    bound = a > 0
    rp = np.where(bound, a * (1 - e), r)
    ra = np.where(bound, a * (1 + e), np.inf)
    return rp, ra


def _carry(states: np.ndarray, dt: float) -> None:
    """Propagates rows in place. Uses the engine entry point (C++ when built) with a zero
    threshold - the row slices are contiguous views, so the engine writes straight through."""
    if dt <= 0 or len(states) == 0:
        return
    if len(states) > 1:
        process_conjunctions(states[:1], states[1:], 0.0, dt)
    else:
        propagate_states(states, dt)


def verify_sequence(sat_state: np.ndarray, sat_id: str, burns: Sequence[dict], objects: np.ndarray,
                    object_ids: Sequence[str], object_types: Sequence[str], start_ts: float, horizon_s: float,
                    threat_ids: Iterable[str] = ()) -> dict:
    """Screens the post-maneuver trajectory of one satellite.

    burns: [{"offset_s", "dv_eci_kms": (x, y, z)}] relative to `start_ts`.
    Returns {"primary": [...], "secondary": [...], "clean": bool, "objects_screened": n}, where
    `primary` are predictions against `threat_ids` and `secondary` against anything else; each
    prediction carries miss, TCA and Pc. "clean" means no prediction needs action.
    """
    threat_ids = set(threat_ids)
    burns = sorted(burns, key=lambda b: b["offset_s"])
    sat = np.asarray(sat_state, dtype=float).reshape(1, 6).copy()
    objs = np.asarray(objects, dtype=float).reshape(-1, 6)

    # Orbit-shell prefilter: an object can only come within the warning radius if the radial
    # ranges overlap. The satellite's range is taken after its first burn, with margin.
    if len(objs) and burns:
        probe = sat.copy()
        _carry(probe, burns[0]["offset_s"])
        probe[0, 3:] += burns[0]["dv_eci_kms"]
        rp_s, ra_s = _shell(np.vstack([sat, probe]))
        lo, hi = rp_s.min() - SHELL_MARGIN_KM - CONFIG.cdmWarningKm, ra_s.max() + SHELL_MARGIN_KM + CONFIG.cdmWarningKm
        rp_o, ra_o = _shell(objs)
        keep = (ra_o >= lo) & (rp_o <= hi)
        objs = objs[keep]
        object_ids = [o for o, k in zip(object_ids, keep) if k]
        object_types = [t for t, k in zip(object_types, keep) if k]

    combined = np.vstack([sat, objs]) if len(objs) else sat.copy()
    predictions: List[dict] = []
    t = 0.0
    epochs = [b["offset_s"] for b in burns] + [horizon_s]
    for k, epoch in enumerate(epochs):
        if k == 0:
            _carry(combined, epoch - t)          # the pre-burn arc was screened by the normal cycle
        else:
            seg = epoch - t
            if seg > 0 and len(combined) > 1:
                found = screen(combined[:1], combined[1:], [sat_id], list(object_ids), start_ts + t, seg,
                               CONFIG.cdmWarningKm)
                for p in found:
                    p["object_type"] = object_types[object_ids.index(p["object_id"])]
                predictions.extend(found)
            _carry(combined, seg)
        t = epoch
        if k < len(burns):
            combined[0, 3:] += burns[k]["dv_eci_kms"]

    annotate_pc(predictions, start_ts)
    # One row per object: its closest predicted approach.
    by_obj: Dict[str, dict] = {}
    for p in predictions:
        if p["object_id"] not in by_obj or p["miss_distance_km"] < by_obj[p["object_id"]]["miss_distance_km"]:
            by_obj[p["object_id"]] = p
    rows = [{"object_id": p["object_id"], "object_type": p["object_type"], "tca_ts": p["tca_ts"],
             "miss_distance_km": p["miss_distance_km"], "pc": p.get("pc"), "needs_action": needs_action(p)}
            for p in sorted(by_obj.values(), key=lambda p: p["miss_distance_km"])]
    primary = [r for r in rows if r["object_id"] in threat_ids]
    secondary = [r for r in rows if r["object_id"] not in threat_ids]
    return {
        "primary": primary,
        "secondary": secondary,
        "clean": not any(r["needs_action"] for r in rows),
        "objects_screened": len(objs),
    }


def trade_space(sat_state: np.ndarray, obj_state: np.ndarray, tca_offset_s: float, obj_is_owned: bool,
                axis: str = "T", n_times: int = 8, n_dv: int = 11, max_dv_mps: Optional[float] = None,
                fuel_kg: float = 50.0) -> dict:
    """Miss distance and Pc at TCA for single impulsive burns on a (burn time x Δv) grid."""
    axis_idx = {"R": 0, "T": 1, "N": 2}[axis.upper()]
    max_dv = (CONFIG.maxDeltaV if max_dv_mps is None else max_dv_mps) / 2.0
    dvs = np.linspace(-max_dv, max_dv, n_dv)
    latest = max(15.0, tca_offset_s - 120.0)
    offsets = np.unique(np.round(np.linspace(15.0, latest, n_times), 1))

    combos = [(t, dv) for t in offsets for dv in dvs]
    k = len(combos)
    A = np.repeat(np.asarray(sat_state, dtype=float).reshape(1, 6), k, axis=0)
    B = np.repeat(np.asarray(obj_state, dtype=float).reshape(1, 6), k, axis=0)
    burn_t = np.array([c[0] for c in combos])
    burn_dv = np.array([c[1] for c in combos]) / 1000.0

    # Carry every copy forward, applying each burn in RTN at its own epoch.
    t = 0.0
    for epoch in offsets:
        pair = np.vstack([A, B])
        propagate_states(pair, epoch - t, max_step=BRIDGE_STEP_S)
        A, B = pair[:k], pair[k:]
        t = epoch
        rows = np.nonzero(burn_t == epoch)[0]
        for i in rows:
            A[i, 3:] += rtn_basis(A[i, :3], A[i, 3:])[:, axis_idx] * burn_dv[i]
    start = max(t, tca_offset_s - TRADE_WINDOW_S / 2)
    pair = np.vstack([A, B])
    propagate_states(pair, start - t, max_step=BRIDGE_STEP_S)
    A, B = pair[:k], pair[k:]
    miss, t_rel, A_at, B_at = closest_approach(A, B, TRADE_WINDOW_S, 2.0)

    grid = []
    for i, (bt, dv) in enumerate(combos):
        tca_i = start + float(t_rel[i])
        res = assess(A_at[i], B_at[i], float(miss[i]), tca_i, obj_is_owned,
                     hbr_m=CONFIG.hardBodyRadiusM, covariance_scale=CONFIG.covarianceScale)
        mass = CONFIG.dryMass + fuel_kg
        grid.append({
            "burn_offset_s": float(bt), "dv_mps": round(float(dv), 4),
            "miss_km": float(miss[i]), "pc": res["pc"], "tca_offset_s": tca_i,
            "fuel_kg": mass * (1.0 - math.exp(-abs(dv) / (300.0 * 9.80665))),
        })
    return {"axis": axis.upper(), "burn_offsets_s": offsets.tolist(), "dv_mps": [round(float(d), 4) for d in dvs],
            "grid": grid, "pc_threshold": CONFIG.pcManeuverThreshold}


# ── rationale text ─────────────────────────────────────────────────────────────
def _fmt_pc(pc) -> str:
    return "n/a" if pc is None else f"{pc:.1e}"


def _fmt_dur(seconds: float) -> str:
    seconds = max(0.0, seconds)
    return f"{seconds / 3600:.1f} h" if seconds >= 5400 else f"{seconds / 60:.0f} min"


def rationale_evasion(threats: List[dict], candidate: dict, rejected: List[dict], fuel_kg: float) -> str:
    worst = threats[0]
    parts = [
        f"{len(threats)} threat(s); worst {worst['object_id']} with {worst['miss_distance_km'] * 1000:.0f} m miss, "
        f"Pc {_fmt_pc(worst.get('pc'))}, TCA in {_fmt_dur(worst['tca_s'])}"
        f"{' (Pc above ' + _fmt_pc(CONFIG.pcManeuverThreshold) + ' threshold)' if (worst.get('pc') or 0) >= CONFIG.pcManeuverThreshold else ''}.",
        f"Chose {candidate['label']}: {candidate['total_dv_mps']:.2f} m/s over {candidate['n_burns']} burn(s), "
        f"{fuel_kg:.3f} kg, burning {_fmt_dur(candidate['first_burn_s'])} before TCA.",
    ]
    check = candidate.get("verification")
    if check:
        prim = check["primary"]
        if prim:
            best = prim[0]
            parts.append(f"Post-maneuver screen: {best['object_id']} miss {best['miss_distance_km'] * 1000:.0f} m, "
                         f"Pc {_fmt_pc(best.get('pc'))}.")
        else:
            parts.append(f"Post-maneuver screen: primary threat(s) beyond the {CONFIG.cdmWarningKm:g} km warning radius.")
        sec = [s for s in check["secondary"] if s["needs_action"]]
        parts.append(f"{len(sec)} secondary conjunction(s) need action." if sec
                     else f"No secondary conjunctions created ({check['objects_screened']} objects re-screened).")
    if rejected:
        parts.append("Rejected: " + "; ".join(f"{r['label']} ({r['why']})" for r in rejected) + ".")
    return " ".join(parts)


def rationale_station_keeping(drift_km: float, dv_mps: float, fuel_kg: float) -> str:
    return (f"Drift {drift_km:.2f} km from its slot exceeds 60% of the {CONFIG.stationKeepingRadius:g} km box; "
            f"two-burn phasing correction of {dv_mps:.2f} m/s total ({fuel_kg:.3f} kg) returns it before it exits.")


def rationale_eol(fuel_kg: float, dv_mps: float) -> str:
    return (f"Propellant {fuel_kg:.2f} kg is at or below the {CONFIG.eolFuelThreshold:g} kg end-of-life threshold; "
            f"prograde graveyard burn of {dv_mps:.2f} m/s uses the remaining usable propellant.")
