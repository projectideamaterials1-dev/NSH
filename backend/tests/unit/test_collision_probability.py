import math

import numpy as np
import pytest

from satellite_api.acm.collision_probability import (
    assess, encounter_frame, model_covariance_rtn, pc_2d, required_miss_km,
)
from satellite_api.acm.conjunctions import risk_level
from satellite_api.config import CONFIG


def test_pc_matches_isotropic_closed_form():
    # Zero miss, isotropic sigma: Pc = 1 - exp(-R^2 / (2 sigma^2)).
    for sigma, hbr in ((0.1, 0.02), (0.05, 0.05), (1.0, 0.01)):
        expected = 1.0 - math.exp(-hbr * hbr / (2.0 * sigma * sigma))
        assert pc_2d(np.zeros(2), np.eye(2) * sigma ** 2, hbr) == pytest.approx(expected, rel=1e-6)


def test_pc_matches_small_hard_body_approximation():
    cov = np.array([[0.04, 0.01], [0.01, 0.01]])
    miss = np.array([0.3, 0.1])
    hbr = 0.005
    density = math.exp(-0.5 * miss @ np.linalg.solve(cov, miss)) / (2.0 * math.pi * math.sqrt(np.linalg.det(cov)))
    assert pc_2d(miss, cov, hbr) == pytest.approx(math.pi * hbr * hbr * density, rel=1e-3)


def test_pc_falls_as_miss_grows_and_required_miss_reaches_target():
    cov = np.diag([0.5 ** 2, 0.1 ** 2])
    pcs = [pc_2d(np.array([m, 0.0]), cov, 0.02) for m in (0.0, 0.5, 1.0, 2.0, 4.0)]
    assert all(a > b for a, b in zip(pcs, pcs[1:]))
    target = 1e-6
    safe = required_miss_km(np.array([1.0, 0.0]), cov, 0.02, target)
    assert pc_2d(np.array([safe, 0.0]), cov, 0.02) <= target * 1.01
    assert pc_2d(np.array([safe * 0.95, 0.0]), cov, 0.02) > target


def test_covariance_grows_with_time_to_tca_and_tracked_objects_are_less_certain():
    owned_now, owned_later = model_covariance_rtn(0, True), model_covariance_rtn(2 * 86400, True)
    tracked = model_covariance_rtn(0, False)
    assert np.all(np.diag(owned_later) > np.diag(owned_now))
    assert np.all(np.diag(tracked) > np.diag(owned_now))


def test_encounter_frame_is_orthonormal_and_perpendicular_to_relative_velocity():
    a = np.array([7000.0, 0.0, 0.0, 0.0, 7.5, 0.0])
    b = np.array([7000.0, 0.3, 0.2, 0.0, 0.0, 7.5])
    x, y, z = encounter_frame(a, b)
    basis = np.vstack([x, y, z])
    assert basis @ basis.T == pytest.approx(np.eye(3), abs=1e-12)
    assert z @ (b[3:] - a[3:]) / np.linalg.norm(b[3:] - a[3:]) == pytest.approx(1.0)


def test_assess_reports_geometry_and_pc_driven_risk():
    a = np.array([7000.0, 0.0, 0.0, 0.0, 7.5, 0.0])
    b = np.array([7000.0, 0.05, 0.0, 0.0, 0.0, 7.5])
    out = assess(a, b, 0.05, 6 * 3600, obj_is_owned=False, pc_threshold=CONFIG.pcManeuverThreshold)
    assert 0.0 < out["pc"] < 1.0
    plane = out["encounter_plane"]
    assert plane["sigma_major_km"] >= plane["sigma_minor_km"] > 0
    assert out["safe_miss_km"] > 0.05

    # A 300 m miss is only WARNING on distance, but CRITICAL once Pc crosses the threshold.
    assert risk_level(0.3) == "WARNING"
    assert risk_level(0.3, pc=CONFIG.pcManeuverThreshold * 2) == "CRITICAL"
    assert risk_level(3.0, pc=1e-5) == "WARNING"
    assert risk_level(3.0, pc=1e-9) == "WATCH"
