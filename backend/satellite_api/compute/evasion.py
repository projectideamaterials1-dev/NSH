"""
compute/evasion.py
------------------
Choosing an avoidance plan for one satellite: the planner's plan plus mirrored / other-axis alternatives,
each re-screened against the post-burn trajectory until one is clean. Self-contained (inputs are copies,
the result is plain data) so it runs in a worker process - see compute/pool.py - in parallel for every
threatened satellite, while the live state stays free for the clock and the API.
"""

import math
import time
from typing import List

import numpy as np


def evaluate_evasion(job: dict) -> dict:
    """job: sid, idx, seq (ManeuverPlans), threat_rows, fuel_kg, sat_state, nominal, sat_ballistic,
    objects, ids, types, obj_ballistic, now_ts, horizon_s, verify, deadline (time.time() epoch),
    first_label, max_candidates.

    Returns {"plan", "candidates", "rejected", "no_clean", "budget_spent"}; "plan" is the chosen
    ManeuverPlan list and every candidate row is marked "chosen" or not."""
    from satellite_api.acm.autopilot import _label
    from satellite_api.acm.brain import AutonomousBrain, Conjunction
    from satellite_api.acm.decision_support import verify_sequence

    seq, threat_rows = job["seq"], job["threat_rows"]
    options = [(job["first_label"], seq)]
    verify = job["verify"]
    budget_spent = verify and time.time() > job["deadline"]
    if budget_spent:
        verify = False

    if verify:
        brain = AutonomousBrain()
        brain_threats = [Conjunction(sat_idx=job["idx"], debris_idx=0, tca_seconds=t["tca_s"],
                                     miss_distance_km=t["miss_distance_km"], relative_velocity_kms=0.0,
                                     risk_score=1.0, pc=t["pc"], requires_action=True,
                                     target_clearance_km=t["clearance_km"]) for t in threat_rows]
        for mode in ("transverse", "radial"):
            for direction in (1.0, -1.0):
                label = _label(mode, direction)
                if label == job["first_label"]:
                    continue
                alt = brain.calculate_perfect_evasion_sequence(job["idx"], brain_threats, job["fuel_kg"],
                                                               job["sat_state"], job["nominal"],
                                                               mode=mode, direction=direction)
                if alt:
                    options.append((label, alt))
        threat_ids = {t["object_id"] for t in threat_rows}

    candidates: List[dict] = []
    chosen, rejected = None, []
    for label, plan in options[:job["max_candidates"]]:
        cand = {"label": label, "n_burns": len(plan),
                "total_dv_mps": round(sum(float(np.linalg.norm(p.delta_v_rtn)) for p in plan) * 1000, 4),
                "fuel_kg": round(sum(p.estimated_fuel_kg for p in plan), 4),
                "first_burn_s": threat_rows[0]["tca_s"] - plan[0].burn_time_offset_s,
                "clean": None, "_plan": plan, "_score": (0, 0.0, 0.0)}
        candidates.append(cand)
        if not verify:
            chosen = cand
            break
        if time.time() > job["deadline"] and len(candidates) > 1:
            # Out of budget mid-way: keep the best verified so far rather than run past it.
            candidates.pop()
            budget_spent = True
            break
        burns = [{"offset_s": p.burn_time_offset_s,
                  "dv_eci_kms": np.array([p.delta_v_eci_dict[a] for a in "xyz"])} for p in plan]
        check = verify_sequence(job["sat_state"], job["sid"], burns, job["objects"], job["ids"], job["types"],
                                job["now_ts"], job["horizon_s"], threat_ids, job["sat_ballistic"],
                                job["obj_ballistic"])
        cand["verification"] = check
        cand["clean"] = check["clean"]
        unresolved = sum(r["needs_action"] for r in check["primary"])
        secondary = sum(r["needs_action"] for r in check["secondary"])
        closest_secondary = min([r["miss_distance_km"] for r in check["secondary"]] or [math.inf])
        cand["_score"] = (unresolved + secondary, -closest_secondary, cand["fuel_kg"])
        if check["clean"]:
            chosen = cand
            break
        rejected.append({"label": label, "why": ", ".join(filter(None, [
            f"{secondary} secondary conjunction(s)" if secondary else "",
            "primary threat not cleared" if unresolved else ""]))})

    no_clean = chosen is None
    if no_clean:
        chosen = min(candidates, key=lambda c: c["_score"])
    plan = chosen["_plan"]
    rejected = [r for r in rejected if r["label"] != chosen["label"]]
    for c in candidates:
        c["chosen"] = c is chosen
        c.pop("_plan")
        c.pop("_score")
    return {"plan": plan, "chosen": chosen, "candidates": candidates, "rejected": rejected,
            "no_clean": no_clean and verify, "budget_spent": budget_spent}
