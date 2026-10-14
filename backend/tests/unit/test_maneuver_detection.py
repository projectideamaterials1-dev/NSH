"""Maneuver detection between consecutive element sets (Lemmens & Krag semi-major-axis jump test)."""
import math
from datetime import datetime, timedelta, timezone

import pytest

from satellite_api.realworld.catalog import MU_EARTH, CatalogObject, detect_maneuver

T0 = datetime(2026, 10, 15, tzinfo=timezone.utc)


def _obj(epoch, a_km, inc=51.6, ndot=0.0):
    n_rev_day = math.sqrt(MU_EARTH / a_km ** 3) * 86400.0 / (2.0 * math.pi)
    fields = {"MEAN_MOTION": n_rev_day, "MEAN_MOTION_DOT": ndot, "INCLINATION": inc}
    return CatalogObject(norad_id=25544, name="OBJ", intl_designator="", epoch=epoch, source="test",
                         fields=fields, satrec=None)


def test_drag_decay_predicted_by_the_old_elements_is_not_a_maneuver():
    a0 = 6778.0
    old = _obj(T0, a0, ndot=2e-4)       # n-dot/2 [rev/day^2]: a decaying low orbit
    n0 = float(old.fields["MEAN_MOTION"])
    dt = 1.0
    n1 = n0 + 2 * 2e-4 * dt              # exactly the predicted decay
    new = _obj(T0 + timedelta(days=dt), (MU_EARTH / (n1 * 2 * math.pi / 86400.0) ** 2) ** (1 / 3), ndot=2e-4)
    assert new.fields["MEAN_MOTION"] == pytest.approx(n1)
    assert detect_maneuver(old, new) is None


def test_semi_major_axis_jump_is_an_in_plane_maneuver_with_a_dv_estimate():
    old, new = _obj(T0, 6778.0), _obj(T0 + timedelta(hours=8), 6778.5)
    hit = detect_maneuver(old, new)
    assert hit["kind"] == "in-plane" and hit["unexplained_delta_a_km"] == pytest.approx(0.5, abs=1e-3)
    v = math.sqrt(MU_EARTH / 6778.0) * 1000.0
    assert hit["dv_estimate_mps"] == pytest.approx(v * 0.5 / (2 * 6778.0), rel=0.01)   # ~0.28 m/s


def test_inclination_jump_is_an_out_of_plane_maneuver():
    hit = detect_maneuver(_obj(T0, 6778.0, inc=51.60), _obj(T0 + timedelta(hours=8), 6778.0, inc=51.65))
    assert hit["kind"] == "out-of-plane" and hit["delta_inclination_deg"] == pytest.approx(0.05)


def test_small_noise_old_or_out_of_order_element_sets_are_ignored():
    assert detect_maneuver(_obj(T0, 6778.0), _obj(T0 + timedelta(hours=8), 6778.05)) is None   # 50 m < 100 m
    assert detect_maneuver(_obj(T0, 6778.0), _obj(T0 + timedelta(days=5), 6779.0)) is None     # gap too long
    assert detect_maneuver(_obj(T0, 6778.0), _obj(T0 - timedelta(hours=1), 6779.0)) is None    # older set


def test_population_threshold_rises_with_class_noise_but_never_below_the_floor():
    from satellite_api.realworld.catalog import MANEUVER_DA_KM, population_threshold_km, unexplained_da_km
    assert population_threshold_km([0.5] * 5) == MANEUVER_DA_KM                 # too few samples: the floor
    quiet = [0.001 * ((i % 7) - 3) for i in range(100)]
    assert population_threshold_km(quiet) == MANEUVER_DA_KM                      # well-tracked class: the floor
    noisy = [0.08 * ((i % 7) - 3) for i in range(100)] + [5.0, -4.0]            # sloppy class + two real maneuvers
    thr = population_threshold_km(noisy)
    assert 0.5 < thr < 4.0                                                       # robust: the two outliers don't set it
    old, new = _obj(T0, 6778.0), _obj(T0 + timedelta(hours=8), 6778.3)
    assert unexplained_da_km(old, new) == pytest.approx(0.3, abs=1e-3)
    assert detect_maneuver(old, new) is not None                                 # 300 m > 100 m floor
    assert detect_maneuver(old, new, da_threshold_km=thr) is None                # but within this class's noise
