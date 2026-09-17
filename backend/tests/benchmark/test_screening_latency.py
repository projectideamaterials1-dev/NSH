"""
Screening-loop latency benchmark: unlike test_snapshot_performance.py (a single trivial-state
endpoint check), this measures acm.conjunctions.screen() itself - the actual cost the autopilot's
background loop pays every cycle (see acm/autopilot.py's due()/run_cycle()) - at catalog sizes
representative of "today" and of the larger real-world catalogs called out in the operational-
readiness assessment. Meant to run as its own (non-blocking) CI job, not gate every PR.
"""
import time

import numpy as np
import pytest

from satellite_api.acm.conjunctions import screen
from satellite_api.physics_engine import ENGINE_NAME, process_conjunctions

R_EARTH = 6378.137
MU_EARTH = 398600.4418

# Generous budgets: CI hardware varies (shared/virtualized runners), so these are wide enough
# to avoid flaking on a slow runner while still catching a severe algorithmic regression (e.g.
# an accidental O(n^2) broad phase or an unbounded spatial-hash cell) - not tight performance
# targets. Tune down once real CI timing data exists.
_BUDGETS_S = {1_000: 8.0, 10_000: 30.0, 50_000: 180.0}


def _random_leo_cloud(n: int, seed: int) -> np.ndarray:
    """A spread of circular-orbit state vectors across LEO altitudes/inclinations - realistic
    enough to exercise the spatial-hash broad phase, not a physics-accuracy fixture."""
    rng = np.random.default_rng(seed)
    alt = rng.uniform(400.0, 900.0, n)
    r = R_EARTH + alt
    inc = rng.uniform(0.0, np.pi, n)
    raan = rng.uniform(0.0, 2 * np.pi, n)
    v = np.sqrt(MU_EARTH / r)
    x, y, z = r * np.cos(raan), r * np.sin(raan), np.zeros(n)
    vx = -v * np.sin(raan) * np.cos(inc)
    vy = v * np.cos(raan) * np.cos(inc)
    vz = v * np.sin(inc)
    return np.column_stack([x, y, z, vx, vy, vz]).astype(np.float64)


@pytest.mark.parametrize("n_debris", sorted(_BUDGETS_S))
def test_screening_latency_scales_within_budget(n_debris):
    n_sats = max(5, n_debris // 200)
    sats = _random_leo_cloud(n_sats, seed=1)
    debris = _random_leo_cloud(n_debris, seed=2)
    sat_ids = [f"SAT-{i}" for i in range(n_sats)]
    deb_ids = [f"DEB-{i}" for i in range(n_debris)]

    t0 = time.perf_counter()
    screen(sats, debris, sat_ids, deb_ids, start_ts=0.0, horizon_s=3600.0, warning_km=5.0,
           engine=process_conjunctions)
    elapsed = time.perf_counter() - t0

    budget = _BUDGETS_S[n_debris]
    print(f"screen() on {n_sats} sats + {n_debris} debris ({ENGINE_NAME} engine): "
          f"{elapsed:.2f}s (budget {budget:.0f}s)")
    assert elapsed < budget, (
        f"Screening {n_sats} sats + {n_debris} debris took {elapsed:.2f}s, over the {budget:.0f}s "
        f"budget - this is the same cost the autopilot's background loop pays every cycle "
        f"(see acm/autopilot.py's falling-behind detection); investigate before this regresses "
        f"further at real-world catalog sizes."
    )
