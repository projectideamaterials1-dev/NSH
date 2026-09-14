import math

import numpy as np
import pytest

from satellite_api import physics_engine
from satellite_api.physics_engine import (
    _numpy_process_conjunctions,
    process_conjunctions,
    propagate_states,
)

R_EARTH = 6378.137
MU_EARTH = 398600.4418


def _circular_state(alt_km=400.0):
    r_mag = R_EARTH + alt_km
    v_mag = math.sqrt(MU_EARTH / r_mag)
    return np.array([[r_mag, 0.0, 0.0, 0.0, v_mag, 0.0]], dtype=np.float64), r_mag


@pytest.mark.parametrize("engine", [process_conjunctions, _numpy_process_conjunctions])
def test_j2_propagation_accuracy(engine):
    """The propagator moves the satellite along a near-circular orbit."""
    state, r_mag = _circular_state()
    initial_pos = state[0, :3].copy()

    updated_sat, _, collisions = engine(state, np.empty((0, 6), dtype=np.float64), 0.1, 600.0)

    assert not np.allclose(updated_sat[0, :3], initial_pos, atol=1e-3)
    assert abs(np.linalg.norm(updated_sat[0, :3]) - r_mag) < 10.0
    assert updated_sat[0, 1] > 10.0
    assert len(collisions) == 0


def test_native_and_numpy_engines_agree():
    if physics_engine.ENGINE_NAME != "cpp":
        pytest.skip("C++ extension not built")
    a, _ = _circular_state()
    b = a.copy()
    empty = np.empty((0, 6), dtype=np.float64)
    process_conjunctions(a, empty.copy(), 0.1, 300.0)
    _numpy_process_conjunctions(b, empty.copy(), 0.1, 300.0)
    assert np.linalg.norm(a[0, :3] - b[0, :3]) < 1e-3  # < 1 m


def test_energy_is_conserved_over_one_orbit():
    state, r_mag = _circular_state()
    period = 2 * math.pi * math.sqrt(r_mag ** 3 / MU_EARTH)

    def energy(s):
        return 0.5 * np.dot(s[0, 3:], s[0, 3:]) - MU_EARTH / np.linalg.norm(s[0, :3])

    e0 = energy(state)
    propagate_states(state, period)
    # J2 makes energy only approximately conserved; the integrator must not blow up.
    assert abs(energy(state) - e0) / abs(e0) < 1e-3


@pytest.mark.parametrize("engine", [process_conjunctions, _numpy_process_conjunctions])
def test_head_on_conjunction_is_detected(engine):
    sat, r_mag = _circular_state()
    v = sat[0, 4]
    # Debris 30 km ahead on the same track, flying the opposite way -> meets in ~2 s
    theta = 30.0 / r_mag
    debris = np.array([[r_mag * math.cos(theta), r_mag * math.sin(theta), 0.0,
                        v * math.sin(theta), -v * math.cos(theta), 0.0]])
    _, _, collisions = engine(sat, debris, 0.1, 10.0)
    assert len(collisions) == 1
    sat_idx, target_idx, is_debris, miss_km, tca = collisions[0]
    assert (sat_idx, target_idx, is_debris) == (0, 0, 1)
    assert miss_km < 0.1
    assert 1.0 < tca < 3.0
