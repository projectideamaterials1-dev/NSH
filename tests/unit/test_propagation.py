import pytest
import numpy as np
import math

from satellite_api.state import StateManager
try:
    from acm_engine import process_conjunctions
except ImportError:
    # Fallback if extension not built
    def process_conjunctions(*args):
        return args[0], args[1], []

def test_j2_propagation_accuracy():
    """Verify that the high-fidelity propagator moves the satellite correctly."""
    R_EARTH = 6378.137
    MU_EARTH = 398600.4418
    alt = 400.0
    r_mag = R_EARTH + alt
    v_mag = math.sqrt(MU_EARTH / r_mag)
    
    # ECI state
    state = np.array([[r_mag, 0.0, 0.0, 0.0, v_mag, 0.0]], dtype=np.float64)
    initial_pos = state[0, :3].copy()
    
    dt = 600.0
    updated_sat, _, collisions = process_conjunctions(state, np.empty((0,6), dtype=np.float64), 0.0, dt)
    
    # Verify the satellite moved
    assert not np.allclose(updated_sat[0, :3], initial_pos, atol=1e-3)
    
    # Verify it's still roughly at the same altitude (within 10km for a 10-min prop)
    actual_r = np.linalg.norm(updated_sat[0, :3])
    assert abs(actual_r - r_mag) < 10.0
    
    # Verify it's in the correct quadrant (moved in +y direction)
    assert updated_sat[0, 1] > 10.0
