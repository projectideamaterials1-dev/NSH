"""Propagator validation: the engine against SGP4 and against analytic J2 theory."""
import json
import math
from pathlib import Path

import numpy as np
import pytest

from satellite_api.physics_engine import J2, MU_EARTH, R_EARTH, configure_drag, propagate_states
from satellite_api.realworld.catalog import parse_records
from satellite_api.realworld.validation import compare_with_sgp4

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "celestrak_sample.json"


def _station(name):
    records = json.loads(FIXTURE.read_text())["stations"]
    return next(o for o in parse_records(records, "stations") if o.name == name).satrec


def _iss():
    return _station("ISS (ZARYA)")


@pytest.mark.parametrize("name", ["ISS (ZARYA)", "CSS (TIANHE)"])
def test_engine_tracks_sgp4_within_documented_bounds(name):
    sat = _station(name)
    with_drag = {r["hours"]: r["error_km"] for r in compare_with_sgp4(sat, hours=(6, 24), drag=True)}
    without = {r["hours"]: r["error_km"] for r in compare_with_sgp4(sat, hours=(6, 24), drag=False)}
    # Bounds documented in docs/VALIDATION.md (measured ~0.2 km @ 6 h, 2.1-2.4 km @ 24 h with drag).
    assert with_drag[6] < 0.5
    assert with_drag[24] < 3.0
    # Modelling drag is what closes much of the gap to SGP4 over a day at station altitude.
    assert with_drag[24] < 0.75 * without[24]


def test_validation_leaves_drag_configuration_untouched():
    configure_drag(False)
    compare_with_sgp4(_iss(), hours=(1,), drag=True)
    from satellite_api.physics_engine import drag_settings
    assert drag_settings()["enabled"] is False


@pytest.mark.parametrize("inc_deg", [28.5, 51.6, 97.4])
def test_nodal_regression_matches_j2_theory(inc_deg):
    """dRAAN/dt = -1.5 n J2 (R/a)^2 cos(i) for a circular orbit."""
    configure_drag(False)
    a = R_EARTH + 550.0
    inc = math.radians(inc_deg)
    v = math.sqrt(MU_EARTH / a)
    state = np.array([[a, 0.0, 0.0, 0.0, v * math.cos(inc), v * math.sin(inc)]])
    duration = 86400.0
    propagate_states(state, duration, max_step=5.0)
    h = np.cross(state[0, :3], state[0, 3:])
    raan = math.atan2(h[0], -h[1])
    n = math.sqrt(MU_EARTH / a ** 3)
    expected = -1.5 * n * J2 * (R_EARTH / a) ** 2 * math.cos(inc) * duration
    # The orbit starts on the ascending node (RAAN = 0); compare the wrapped drift.
    drift = (raan + math.pi) % (2 * math.pi) - math.pi
    assert drift == pytest.approx(expected, rel=0.03, abs=1e-5)
