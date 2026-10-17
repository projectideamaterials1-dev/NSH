"""The compute pool runs autopilot work in real worker processes with this process's physics settings."""
import asyncio
import math

import numpy as np
import pytest

from satellite_api.acm.brain import AutonomousBrain, Conjunction, MU_EARTH
from satellite_api.compute import planning, pool


def _settings_seen_in_worker():
    from satellite_api.config import CONFIG
    from satellite_api.physics_engine import _drag
    import os
    return CONFIG.maxDeltaV, _drag["scale"], os.environ.get("CUDA_VISIBLE_DEVICES")


@pytest.fixture
def one_worker(monkeypatch):
    monkeypatch.setenv("ACM_WORKERS", "1")
    pool.shutdown()
    yield
    pool.shutdown()


def test_worker_process_uses_live_settings_and_no_gpu(one_worker, monkeypatch):
    from satellite_api.config import CONFIG
    from satellite_api import physics_engine
    monkeypatch.setattr(CONFIG, "maxDeltaV", 7.5)
    monkeypatch.setitem(physics_engine._drag, "scale", 1.75)
    max_dv, scale, cuda = asyncio.run(pool.run(_settings_seen_in_worker))
    assert (max_dv, scale, cuda) == (7.5, 1.75, "-1")


def test_planner_state_comes_back_from_the_worker(one_worker):
    r = 6778.0
    sats = np.array([[r, 0, 0, 0, math.sqrt(MU_EARTH / r), 0]])
    threat = Conjunction(sat_idx=0, debris_idx=0, tca_seconds=3000.0, miss_distance_km=0.05,
                         relative_velocity_kms=10.0, risk_score=1.0, requires_action=True)
    from datetime import datetime, timezone
    brain, plans = asyncio.run(pool.run(planning.plan, AutonomousBrain(), sats, sats.copy(), [40.0], [threat],
                                        datetime(2026, 10, 17, tzinfo=timezone.utc), [], evasion_mode="auto"))
    assert plans and all(p.sat_idx == 0 for p in plans)
    assert 0 in brain.locked_satellites          # the lock the planner set is not lost with the worker
