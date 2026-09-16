import math

import numpy as np
import pytest

from satellite_api.acm.brain import Conjunction
from satellite_api.acm.plugins import PLUGINS, RadialOverridePlugin, TriShuntPlugin, get_plugin
from satellite_api.acm.scenario import circular_state_over
from satellite_api.gravity import GravityModel, MU_EARTH, R_EARTH, ZONAL_J
from satellite_api.physics_engine import J2, j2_acceleration


def _positions(n=8):
    r = np.random.default_rng(3).normal(size=(n, 3))
    return r / np.linalg.norm(r, axis=1)[:, None] * 7000.0


def test_j2_model_matches_simulation_engine():
    model = GravityModel()
    model.harmonics = {(2, 0): (J2, 0.0)}
    r = _positions()
    assert np.allclose(model.acceleration_vec(r), j2_acceleration(r), rtol=0, atol=1e-15)


def test_j3_j4_match_closed_form():
    r = _positions()
    x, y, z = r.T
    rn = np.linalg.norm(r, axis=1)
    j3, j4 = ZONAL_J[3], ZONAL_J[4]
    ax = (-5 * j3 * MU_EARTH * R_EARTH ** 3 * x / (2 * rn ** 7) * (3 * z - 7 * z ** 3 / rn ** 2)
          + 15 * j4 * MU_EARTH * R_EARTH ** 4 * x / (8 * rn ** 7) * (1 - 14 * z ** 2 / rn ** 2 + 21 * z ** 4 / rn ** 4))
    az = (-5 * j3 * MU_EARTH * R_EARTH ** 3 / (2 * rn ** 7) * (6 * z ** 2 - 7 * z ** 4 / rn ** 2 - 3 * rn ** 2 / 5)
          + 15 * j4 * MU_EARTH * R_EARTH ** 4 * z / (8 * rn ** 7) * (5 - 70 * z ** 2 / (3 * rn ** 2) + 21 * z ** 4 / rn ** 4))
    model = GravityModel()
    model.harmonics = {(3, 0): (j3, 0.0), (4, 0): (j4, 0.0)}
    perturbation = model.acceleration_vec(r) + MU_EARTH * r / rn[:, None] ** 3
    assert np.allclose(perturbation[:, 0], ax, rtol=1e-9)
    assert np.allclose(perturbation[:, 2], az, rtol=1e-9)


def test_scalar_api_and_presets():
    ax, ay, az = GravityModel(preset="J6").acceleration(7000.0, 0.0, 0.0)
    assert ax < 0 and abs(ay) < 1e-12
    assert set(GravityModel(preset="J6").zonal) == {2, 3, 4, 5, 6}
    with pytest.raises(ValueError):
        GravityModel(preset="EGM999")


def test_load_normalised_coefficient_file(tmp_path):
    path = tmp_path / "egm.txt"
    c20_norm = -ZONAL_J[2] / math.sqrt(5)
    path.write_text(f"# n m C S\n2 0 {c20_norm:.12E} 0.0\n2 2 2.43914352D-06 -1.40016683D-06\n")
    model = GravityModel(model_path=str(path))
    assert model.zonal[2] == pytest.approx(ZONAL_J[2], rel=1e-9)
    assert (2, 2) in model.harmonics


def test_gravity_propagation_conserves_energy():
    model = GravityModel(preset="J4")
    r0 = 6928.137
    state = np.array([[r0, 0.0, 0.0, 0.0, math.sqrt(MU_EARTH / r0), 0.0]])
    e0 = 0.5 * state[0, 3:] @ state[0, 3:] - MU_EARTH / r0
    model.propagate(state, 5700.0, max_step=10.0)
    e1 = 0.5 * state[0, 3:] @ state[0, 3:] - MU_EARTH / np.linalg.norm(state[0, :3])
    assert abs(e1 - e0) / abs(e0) < 1e-3


def test_plugin_registry():
    assert set(PLUGINS) == {"Auto", "TriShunt", "RadialOverride"}
    with pytest.raises(ValueError):
        get_plugin("Nope")


def test_trishunt_plans_three_transverse_burns():
    ts = 1767225600.0
    sat = circular_state_over(0.0, 0.0, ts)
    burns = TriShuntPlugin().plan(sat, 50.0, [{"tca_ts": ts + 1800, "miss_distance_km": 0.05}], ts, sat_id="SAT-1")
    assert [b["maneuver_type"] for b in burns] == ["PHASING_PROGRADE", "PHASING_RETROGRADE", "RECOVERY"]
    assert burns[0]["burnTime"] == pytest.approx(ts + 15.0)
    dv = np.array([burns[0]["deltaV_vector"][k] for k in "xyz"])
    # along-track, not radial (reference is the epoch position; the burn happens 15 s / ~1° of arc later)
    assert abs(dv @ sat[:3]) / (np.linalg.norm(dv) * np.linalg.norm(sat[:3])) < 0.05
    assert all(b["estimated_fuel_kg"] > 0 for b in burns)


def test_radial_override_plans_radial_shunt_and_recovery():
    ts = 1767225600.0
    sat = circular_state_over(0.0, 0.0, ts)
    threat = Conjunction(0, 0, 1800.0, 0.05, 10.0, 1.0)
    burns = RadialOverridePlugin().plan(sat, 50.0, [threat], ts)
    assert [b["maneuver_type"] for b in burns] == ["RADIAL_SHUNT", "RECOVERY"]
    dv = np.array([burns[0]["deltaV_vector"][k] for k in "xyz"])
    r_hat = sat[:3] / np.linalg.norm(sat[:3])
    assert abs(dv @ r_hat) / np.linalg.norm(dv) > 0.99   # radial


def test_no_burns_for_past_conjunctions():
    ts = 1767225600.0
    sat = circular_state_over(0.0, 0.0, ts)
    assert get_plugin("Auto").plan(sat, 50.0, [{"tca_ts": ts - 5, "miss_distance_km": 0.01}], ts) == []
