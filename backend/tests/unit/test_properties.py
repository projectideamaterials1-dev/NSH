"""
Property-based tests (Hypothesis): instead of single hand-picked examples, these assert an
invariant holds across a wide, randomly-sampled range of inputs - the kind of coverage a
safety-relevant scheduler/physics engine needs beyond a handful of example-based tests.
"""
import asyncio
import math

import numpy as np
from hypothesis import HealthCheck, given, settings, strategies as st

from satellite_api.acm.scheduler import BurnRequest, evaluate_sequence
from satellite_api.config import CONFIG
from satellite_api.physics_engine import propagate_states
from satellite_api.state import StateManager

R_EARTH = 6378.137
MU_EARTH = 398600.4418
_SUPPRESS = [HealthCheck.function_scoped_fixture]


# ============================================================================
# Physics: energy conservation across arbitrary LEO orbits (generalizes the single
# circular-equatorial case in test_propagation.py to a wide range of altitudes/inclinations).
# ============================================================================
@settings(max_examples=25, deadline=None, suppress_health_check=_SUPPRESS)
@given(
    alt_km=st.floats(min_value=300.0, max_value=2000.0, allow_nan=False, allow_infinity=False),
    inc_deg=st.floats(min_value=0.0, max_value=89.0, allow_nan=False, allow_infinity=False),
)
def test_propagation_conserves_energy_for_arbitrary_leo_orbits(alt_km, inc_deg):
    r_mag = R_EARTH + alt_km
    v_mag = math.sqrt(MU_EARTH / r_mag)
    inc = math.radians(inc_deg)
    state = np.array([[r_mag, 0.0, 0.0,
                        0.0, v_mag * math.cos(inc), v_mag * math.sin(inc)]], dtype=np.float64)
    period = 2 * math.pi * math.sqrt(r_mag ** 3 / MU_EARTH)

    def energy(s):
        return 0.5 * np.dot(s[0, 3:], s[0, 3:]) - MU_EARTH / np.linalg.norm(s[0, :3])

    e0 = energy(state)
    propagate_states(state, period)
    # J2 makes energy only approximately conserved; the integrator must not blow up or drift
    # significantly over exactly one nominal period, for any LEO altitude/inclination.
    assert abs(energy(state) - e0) / abs(e0) < 1e-3


# ============================================================================
# Scheduler: evaluate_sequence must never accept a burn that violates the safety cap or
# the cooldown, no matter the fuel/Delta-v/timing combination requested.
# ============================================================================
def _fresh_state_with_one_satellite() -> StateManager:
    StateManager._instance = None
    state = StateManager()
    asyncio.run(state.update_telemetry_raw(
        sat_data=[[7000.0, 0.0, 0.0, 0.0, 7.5, 0.0]], debris_data=[],
        sat_ids=["SAT-P"], debris_ids=[], timestamp_str="2026-01-01T00:00:00.000Z",
    ))
    return state


@settings(max_examples=40, deadline=None, suppress_health_check=_SUPPRESS)
@given(
    dv_mps=st.floats(min_value=0.001, max_value=500.0, allow_nan=False, allow_infinity=False),
    fuel_kg=st.floats(min_value=0.001, max_value=500.0, allow_nan=False, allow_infinity=False),
)
def test_evaluate_sequence_never_exceeds_max_delta_v(dv_mps, fuel_kg):
    """A single burn over CONFIG.maxDeltaV must be rejected regardless of available fuel -
    the cap is a per-burn safety limit, not something more propellant should be able to buy."""
    state = _fresh_state_with_one_satellite()
    state.sat_fuel[state.sat_id_to_idx["SAT-P"]] = fuel_kg
    burn = BurnRequest("B1", state.now_ts + 100.0, (dv_mps / 1000.0, 0.0, 0.0))
    evaluation = evaluate_sequence(state, "SAT-P", [burn], check_los=False)
    if dv_mps > CONFIG.maxDeltaV:
        assert not evaluation.accepted
        assert evaluation.reason == "MAX_THRUST_EXCEEDED"


@settings(max_examples=40, deadline=None, suppress_health_check=_SUPPRESS)
@given(gap_s=st.floats(min_value=0.0, max_value=CONFIG.cooldownSeconds - 0.2, allow_nan=False))
def test_evaluate_sequence_enforces_cooldown_between_burns(gap_s):
    """Two burns on the same satellite closer together than cooldownSeconds must never both
    be accepted, for any gap strictly inside the cooldown window."""
    state = _fresh_state_with_one_satellite()
    state.sat_fuel[state.sat_id_to_idx["SAT-P"]] = 50.0
    small_dv_kms = (CONFIG.maxDeltaV / 1000.0) * 0.1  # comfortably under the cap
    t0 = state.now_ts + 100.0
    burns = [
        BurnRequest("B1", t0, (small_dv_kms, 0.0, 0.0)),
        BurnRequest("B2", t0 + gap_s, (small_dv_kms, 0.0, 0.0)),
    ]
    evaluation = evaluate_sequence(state, "SAT-P", burns, check_los=False)
    assert not evaluation.accepted
    assert evaluation.reason == "COOLDOWN_ACTIVE"
