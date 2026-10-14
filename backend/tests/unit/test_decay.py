"""Orbital lifetime / re-entry estimates (realworld/decay.py)."""
import math

import pytest

from satellite_api.physics_engine import R_EARTH
from satellite_api.realworld import decay


def _elements(alt_km, e=0.0):
    a = R_EARTH + alt_km
    n_rev_day = math.sqrt(398600.4418 / a ** 3) * 86400.0 / (2 * math.pi)
    return {"semi_major_axis_km": a, "eccentricity": e, "mean_motion_rev_day": n_rev_day,
            "perigee_alt_km": a * (1 - e) - R_EARTH, "apogee_alt_km": a * (1 + e) - R_EARTH}


def _ndot_for(alt_km, k):
    """MEAN_MOTION_DOT (= n-dot/2, rev/day^2) that the drag model produces at alt_km for strength k."""
    el = _elements(alt_km)
    da_dt_km_day = decay._rate_m_s(k, alt_km) * 86400.0 / 1000.0
    return da_dt_km_day * el["mean_motion_rev_day"] / (2.0 * (2.0 / 3.0) * el["semi_major_axis_km"])


def test_lifetime_shrinks_with_lower_orbits_and_stronger_drag():
    assert decay.lifetime_days(300, 0.01) > decay.lifetime_days(250, 0.01) > decay.lifetime_days(200, 0.01)
    assert decay.lifetime_days(300, 0.02) == pytest.approx(decay.lifetime_days(300, 0.01) / 2, rel=1e-6)
    # Typical satellite (Cd*A/m ~ 0.01 m^2/kg) at 200 km: days, not weeks; at 1000 km: effectively forever.
    assert 0.5 < decay.lifetime_days(200, 0.01) < 10
    assert math.isinf(decay.lifetime_days(1000, 0.01))


def test_observed_decay_calibrates_the_drag_strength():
    k_true = 0.015
    est = decay.estimate(_elements(320), _ndot_for(320, k_true))
    assert est["method"].startswith("observed decay")
    assert est["lifetime_days"] == pytest.approx(decay.lifetime_days(320, k_true), rel=0.01)
    lo, hi = est["window_days"]
    assert lo == pytest.approx(0.75 * est["lifetime_days"], rel=1e-3) and hi == pytest.approx(1.25 * est["lifetime_days"], rel=1e-3)


def test_falls_back_to_bstar_and_reports_nothing_without_decay_information():
    est = decay.estimate(_elements(300), 0.0, ballistic_m2_kg=0.01, density_scale=2.0)
    assert est["method"].startswith("B*") and est["lifetime_days"] == pytest.approx(decay.lifetime_days(300, 0.02), abs=0.01)
    assert decay.estimate(_elements(300), 0.0, ballistic_m2_kg=float("nan")) is None
    assert decay.estimate(_elements(300, e=0.05), _ndot_for(300, 0.01))["confidence"].startswith("low")
