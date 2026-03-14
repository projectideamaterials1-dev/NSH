"""
collision.py — Collision Detection Service
-------------------------------------------
Two-stage pipeline:
  Stage 1 (Fast Filter)   — Bounding-box coarse screen (O(n²) but cheap)
  Stage 2 (Precise Check) — TCA-based closest approach for flagged pairs
"""

from typing import List, Tuple
from satellite_api.models import SpaceObject, CollisionWarning
from satellite_api.physics import separation_km, time_to_closest_approach, risk_level, CRIT_DIST_KM
from datetime import datetime, timedelta, timezone

# Coarse filter threshold — only pairs within this distance get precise TCA check
COARSE_THRESHOLD_KM = 50.0


def run_collision_screening(
    objects: List[SpaceObject],
    sim_time_offset_s: float = 0.0,
) -> List[CollisionWarning]:
    """
    Full two-stage collision screening across all tracked objects.

    Returns list of CollisionWarning for pairs within CRIT_DIST_KM.
    """
    warnings: List[CollisionWarning] = []
    n = len(objects)

    if n < 2:
        return warnings

    # Stage 1: Coarse bounding-box filter
    candidate_pairs: List[Tuple[int, int]] = []
    for i in range(n):
        for j in range(i + 1, n):
            dist = separation_km(
                objects[i].r.to_list(),
                objects[j].r.to_list(),
            )
            if dist < COARSE_THRESHOLD_KM:
                candidate_pairs.append((i, j))

    # Stage 2: Precise TCA check for candidate pairs
    for i, j in candidate_pairs:
        o1, o2 = objects[i], objects[j]

        tca_s, min_dist = time_to_closest_approach(
            o1.r.to_list(), o1.v.to_list(),
            o2.r.to_list(), o2.v.to_list(),
        )

        if min_dist < CRIT_DIST_KM:
            # Predicted TCA timestamp
            tca_time = (
                datetime.now(tz=timezone.utc) + timedelta(seconds=tca_s + sim_time_offset_s)
            ).isoformat()

            warnings.append(
                CollisionWarning(
                    object1=o1.id,
                    object2=o2.id,
                    closest_approach_km=round(min_dist, 4),
                    predicted_time=tca_time,
                    risk_level=risk_level(min_dist),
                )
            )

    # Sort by distance (closest first)
    warnings.sort(key=lambda w: w.closest_approach_km)
    return warnings