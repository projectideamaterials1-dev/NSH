"""Planner cost at whole-catalog scale: RK4 steps scale with the orbit, not a fixed 5 s."""
import math

import numpy as np

from satellite_api.acm.brain import MU_EARTH, RK4_MIN_STEP_S, RK4_STEPS_PER_ORBIT, _rk4_step_s


def _circular(r_km):
    return np.array([r_km, 0.0, 0.0]), np.array([0.0, math.sqrt(MU_EARTH / r_km), 0.0])


def test_leo_keeps_five_second_steps():
    assert _rk4_step_s(*_circular(6778.0)) == RK4_MIN_STEP_S


def test_geo_keeps_steps_per_orbit_not_seconds():
    step = _rk4_step_s(*_circular(42164.0))
    assert math.isclose(step, 86164.0 / RK4_STEPS_PER_ORBIT, rel_tol=0.01)


def test_unbound_state_falls_back_to_minimum_step():
    assert _rk4_step_s(np.array([7000.0, 0, 0]), np.array([0, 20.0, 0])) == RK4_MIN_STEP_S


def test_evasion_budget_defers_only_distant_threats(monkeypatch):
    """Over budget, a threat hours away waits for the next cycle; one inside 30 min is still planned."""
    from datetime import datetime, timezone
    from satellite_api.acm import brain as B
    monkeypatch.setattr(B, "EVASION_PLAN_BUDGET_S", -1.0)          # budget already spent
    b = B.AutonomousBrain()
    r, v = _circular(6778.0)
    sats = np.array([np.concatenate([r, v]), np.concatenate([r * 1.001, v])])
    conj = lambda i, tca: B.Conjunction(sat_idx=i, debris_idx=0, tca_seconds=tca, miss_distance_km=0.05,
                                        relative_velocity_kms=10.0, risk_score=1.0, requires_action=True)
    planned = b.plan_evasion(sats, sats.copy(), [40.0, 40.0], [conj(0, 900.0), conj(1, 7200.0)],
                             datetime(2026, 10, 17, tzinfo=timezone.utc), [], evasion_mode="auto")
    assert b.evasions_deferred == 1
    assert {p.sat_idx for p in planned} <= {0}


def test_apogee_perigee_filter_keeps_only_objects_that_can_meet():
    from satellite_api.acm.autopilot import SHELL_MARGIN_KM, _altitude_shells
    leo = np.concatenate(_circular(6928.0))
    a, rp_, ra_ = (6778.0 + 7378.0) / 2, 6778.0, 7378.0
    crossing = np.array([rp_, 0, 0, 0, math.sqrt(MU_EARTH * (2 / rp_ - 1 / a)), 0])   # eccentric, spans the LEO shell
    geo = np.concatenate(_circular(42164.0))
    near = np.concatenate(_circular(6928.0 + SHELL_MARGIN_KM - 5))
    rp, ra = _altitude_shells(np.array([crossing, geo, near]))
    sp, sa = _altitude_shells(leo[None, :])
    keep = (rp <= sa[0] + SHELL_MARGIN_KM) & (ra >= sp[0] - SHELL_MARGIN_KM)
    assert keep.tolist() == [True, False, True]
