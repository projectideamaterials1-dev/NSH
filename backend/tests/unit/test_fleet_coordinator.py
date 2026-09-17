"""Pure-function tests for acm/fleet_coordinator.py - no StateManager involved, mirrors
tests/regression/test_conjunction_scenario.py's style of building AutonomousBrain inputs
directly."""
import numpy as np
import pytest

from satellite_api.acm.brain import (AutonomousBrain, Conjunction, ManeuverPlan, ManeuverType,
                                     STATION_KEEPING, EVASION, EOL)
from satellite_api.acm.fleet_coordinator import coordinate_fleet, priority_score
from satellite_api.config import CONFIG


def _sk_pair(sat_idx: int, t1: float = 15.0, gap: float = 5400.0) -> list:
    return [
        ManeuverPlan(sat_idx, ManeuverType.PHASING_PROGRADE, np.zeros(3), t1, 0.01, False, 0.99, category=STATION_KEEPING),
        ManeuverPlan(sat_idx, ManeuverType.PHASING_RETROGRADE, np.zeros(3), t1 + gap, 0.01, False, 0.99, category=STATION_KEEPING),
    ]


def test_priority_score_monotonic():
    baseline = dict(risk_component=0.0, fuel_kg=25.0, drift_ratio=0.5, tca_urgency=0.0)
    base = priority_score(**baseline)

    assert priority_score(**{**baseline, "risk_component": 1.0}) > base
    assert priority_score(**{**baseline, "fuel_kg": 1.0}) > base          # lower fuel -> more urgent
    assert priority_score(**{**baseline, "fuel_kg": 49.0}) < base
    assert priority_score(**{**baseline, "drift_ratio": 1.0}) > base
    assert priority_score(**{**baseline, "tca_urgency": 1.0}) > base


def test_stagger_clustered_sk_burns():
    # 4 satellites all need SK at the same t1=15.0 (today's real clustering bug); distinct
    # fuel levels are the only varying score input, so lowest fuel must go first.
    plans = _sk_pair(0) + _sk_pair(1) + _sk_pair(2) + _sk_pair(3)
    drift_km = np.array([6.5, 6.5, 6.5, 6.5])          # identical drift so fuel decides ranking
    fuels = [5.0, 40.0, 20.0, 45.0]                     # sat0 most urgent ... sat3 least
    locked = {i: (100.0 + 15.0 + 5400.0 + 1.0, "SK") for i in range(4)}

    result = coordinate_fleet(plans, drift_km=drift_km, fuels=fuels, conjunctions=[],
                               now_ts=100.0, locked_satellites=locked)

    assert result.staggered_count == 3   # rank 0 (sat0) is unchanged
    by_sat = {}
    for p in plans:
        by_sat.setdefault(p.sat_idx, []).append(p)

    # sat0 (lowest fuel) kept its original slot.
    assert by_sat[0][0].burn_time_offset_s == 15.0
    # everyone else pushed back, in strict fuel-urgency order: sat2 < sat1 < sat3.
    t1s = {idx: seq[0].burn_time_offset_s for idx, seq in by_sat.items()}
    assert t1s[0] < t1s[2] < t1s[1] < t1s[3]
    # the t2-t1 gap is preserved exactly for every satellite (Hohmann phasing untouched).
    for idx, seq in by_sat.items():
        assert seq[1].burn_time_offset_s - seq[0].burn_time_offset_s == pytest.approx(5400.0)
    # locked_satellites shifted by the same delta_t applied to each satellite's burns.
    for idx, seq in by_sat.items():
        delta_t = seq[0].burn_time_offset_s - 15.0
        assert locked[idx][0] == pytest.approx(100.0 + 15.0 + 5400.0 + 1.0 + delta_t)


def test_stagger_leaves_evasion_and_eol_untouched():
    brain = AutonomousBrain()
    sat_state = np.array([6778.137, 0.0, 0.0, 0.0, 7.5, 0.0])
    nominal_state = sat_state.copy()
    threats = [Conjunction(sat_idx=5, debris_idx=0, tca_seconds=3600.0, miss_distance_km=0.05,
                           relative_velocity_kms=7.5, risk_score=0.999)]
    evasion_plans = brain.calculate_perfect_evasion_sequence(5, threats, 50.0, sat_state, nominal_state)
    assert evasion_plans and all(p.category == EVASION for p in evasion_plans)

    eol_plan = brain.plan_eol(9, sat_state, current_fuel_kg=2.0, max_dv_kms=0.015)
    assert eol_plan is not None and eol_plan.category == EOL

    sk_plans = _sk_pair(0) + _sk_pair(1) + _sk_pair(2)   # cluster that WOULD be staggered
    plans = sk_plans + evasion_plans + [eol_plan]
    before = [(p.sat_idx, p.category, p.burn_time_offset_s) for p in evasion_plans + [eol_plan]]

    n = 10
    drift_km = np.zeros(n)
    fuels = [50.0] * n
    result = coordinate_fleet(plans, drift_km=drift_km, fuels=fuels, conjunctions=threats,
                               now_ts=0.0, locked_satellites={})

    after = [(p.sat_idx, p.category, p.burn_time_offset_s) for p in evasion_plans + [eol_plan]]
    assert before == after
    assert result.staggered_count == 2   # only the 2 non-first satellites in the SK cluster


def test_stagger_max_delay_cap():
    n = 30
    plans = []
    for i in range(n):
        plans.extend(_sk_pair(i))
    drift_km = np.zeros(n)
    fuels = [float(50 - i) for i in range(n)]   # strictly increasing urgency with index -> stable rank order
    locked = {i: (15.0 + 5400.0 + 1.0, "SK") for i in range(n)}

    result = coordinate_fleet(plans, drift_km=drift_km, fuels=fuels, conjunctions=[],
                               now_ts=0.0, locked_satellites=locked)

    by_sat = {}
    for p in plans:
        by_sat.setdefault(p.sat_idx, []).append(p)
    delta_ts = {idx: seq[0].burn_time_offset_s - 15.0 for idx, seq in by_sat.items()}
    assert all(dt <= CONFIG.fleetStaggerMaxDelayS for dt in delta_ts.values())
    capped = [dt for dt in delta_ts.values() if dt == CONFIG.fleetStaggerMaxDelayS]
    assert len(capped) > 1


def test_stagger_single_satellite_is_noop():
    # No cluster (only one satellite needs SK this cycle) -> nothing to stagger against.
    # CONFIG.fleetStaggerEnabled itself is checked at the autopilot.py call site, not here -
    # see test_fleet_coordinator_disabled_is_noop in test_operations.py for that gate.
    plans = _sk_pair(0)
    before = [p.burn_time_offset_s for p in plans]
    result = coordinate_fleet(plans, drift_km=np.array([6.5]), fuels=[20.0], conjunctions=[],
                               now_ts=0.0, locked_satellites={0: (5416.0, "SK")})
    assert [p.burn_time_offset_s for p in plans] == before
    assert result.staggered_count == 0
