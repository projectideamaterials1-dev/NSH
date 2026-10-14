import pytest
import numpy as np
from datetime import datetime, timezone
from satellite_api.acm.brain import AutonomousBrain, Conjunction

def test_conjunction_evasion_plan():
    brain = AutonomousBrain()
    R_EARTH = 6378.137
    alt = 400.0
    r_mag = R_EARTH + alt
    sat_state = np.array([r_mag, 0.0, 0.0, 0.0, 7.5, 0.0])
    nominal_state = sat_state.copy()
    sat_fuel = 50.0
    conjunctions = [
        Conjunction(
            sat_idx=0,
            debris_idx=0,
            tca_seconds=3600.0,
            miss_distance_km=0.05,
            relative_velocity_kms=7.5,
            risk_score=0.999
        )
    ]
    current_time = datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc)
    
    plans = brain.plan_evasion(
        sat_states=sat_state.reshape(1, 6),
        nominal_states=nominal_state.reshape(1, 6),
        sat_fuels=[sat_fuel],
        conjunctions=conjunctions,
        current_time=current_time,
        ground_stations=[]
    )
    
    assert len(plans) > 0


def test_unbound_satellite_state_is_skipped_not_fatal():
    # Live-catalog regression (2026-10-15): one satellite's state was above escape speed, station-keeping
    # took sqrt of a negative semi-major axis, and every screening cycle for the whole fleet failed.
    from satellite_api.acm.scenario import circular_state_over
    from satellite_api.acm.autopilot import brain_stations
    from satellite_api.ground_stations import STATIONS
    st = STATIONS[0]
    good = circular_state_over(st.latitude, st.longitude, 1767225600.0)
    bad = good.copy()
    bad[3:6] *= 1.5                                   # hyperbolic
    states = np.vstack([bad, good]).astype(float)
    nominal = states.copy()
    states[:, :3] += 10.0                             # both drifted out of their slot -> station-keeping runs
    brain = AutonomousBrain()
    plans = brain.plan_evasion(states, nominal, [50.0, 50.0], [], datetime.fromtimestamp(1767225600.0, timezone.utc),
                               brain_stations())
    assert brain.skipped_unbound == {0}
    assert all(p.sat_idx != 0 for p in plans)
