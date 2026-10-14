"""Trade study: the bisected minimum delta-v is safe, cheaper than the grid, and actually minimal."""
import numpy as np
import pytest

from satellite_api.acm.decision_support import _evaluate, trade_space
from satellite_api.acm.scenario import circular_state_over, make_threat
from satellite_api.config import CONFIG
from satellite_api.physics_engine import configure_drag

T0 = 1767225600.0


@pytest.fixture(autouse=True)
def _no_drag():
    configure_drag(False)
    yield


def test_min_dv_options_are_safe_minimal_and_cheaper_than_the_grid():
    sat = circular_state_over(10.0, 20.0, T0)
    deb = make_threat(sat, 1800.0, 0.05)
    study = trade_space(sat, deb, 1800.0, obj_is_owned=False)
    target = study["min_dv_target_pc"]
    assert target == pytest.approx(CONFIG.pcManeuverThreshold / 10.0)
    best = study["min_dv_options"][0]
    grid_safe = [g for g in study["grid"] if g["dv_mps"] != 0 and g["pc"] < target]
    assert abs(best["dv_mps"]) < min(abs(g["dv_mps"]) for g in grid_safe)
    assert best["pc"] < target

    # 5 % less delta-v at the same time and direction is no longer below the target: it is the minimum.
    _, pcs, _ = _evaluate(sat, deb, np.array([best["burn_offset_s"]]), np.array([best["dv_mps"] * 0.95]), 1,
                          1800.0, False, float("nan"), float("nan"))
    assert pcs[0] >= target


def test_no_minimum_is_reported_when_no_burn_is_needed():
    sat = circular_state_over(10.0, 20.0, T0)
    deb = make_threat(sat, 1800.0, 8.0)                 # 8 km miss: already safe without a burn
    study = trade_space(sat, deb, 1800.0, obj_is_owned=False)
    assert study["min_dv_options"] == []
