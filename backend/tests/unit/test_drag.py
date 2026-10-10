import math

import numpy as np
import pytest

from satellite_api import physics_engine as pe
from satellite_api.physics_engine import (
    ATMOSPHERE_TABLE, MU_EARTH, R_EARTH, atmospheric_density, configure_drag, density_scale, propagate_states,
)


def _circular(alt_km: float, inc_deg: float = 51.6) -> np.ndarray:
    r = R_EARTH + alt_km
    v = math.sqrt(MU_EARTH / r)
    inc = math.radians(inc_deg)
    return np.array([[r, 0.0, 0.0, 0.0, v * math.cos(inc), v * math.sin(inc)]])


def _sma(state: np.ndarray) -> float:
    r, v = np.linalg.norm(state[0, :3]), np.linalg.norm(state[0, 3:])
    return 1.0 / (2.0 / r - v * v / MU_EARTH)


def test_density_table_is_continuous_and_decreasing():
    for h0 in ATMOSPHERE_TABLE[1:, 0]:
        below, above = atmospheric_density(h0 - 1e-6), atmospheric_density(h0)
        assert above == pytest.approx(below, rel=0.25)      # table breakpoints match within the model's fit
    alts = np.linspace(150, 1500, 200)
    assert np.all(np.diff(atmospheric_density(alts)) < 0)
    assert atmospheric_density(400) == pytest.approx(3.725e-12)


def test_density_scale_tracks_solar_and_geomagnetic_activity():
    assert density_scale(150, 2) == pytest.approx(1.0)
    assert density_scale(70, 0) < 1.0 < density_scale(250, 7)
    assert density_scale(None, None) == pytest.approx(1.0)
    assert 0.1 <= density_scale(1000, 9) <= 10.0


def test_drag_decay_matches_analytic_rate():
    """Circular-orbit decay per revolution: da = -2*pi*B*rho*a^2 (SI units; non-rotating atmosphere).

    Measured differentially (drag vs drag-free run) so J2's osculating oscillation cancels."""
    ballistic = 0.02
    configure_drag(True, ballistic, 1.0)
    dragged, free = _circular(400.0, inc_deg=90.0), _circular(400.0, inc_deg=90.0)
    a0 = _sma(free)
    period = 2 * math.pi * math.sqrt(a0 ** 3 / MU_EARTH)
    propagate_states(dragged, period, max_step=5.0)
    propagate_states(free, period, max_step=5.0, drag=False)
    da_m = (_sma(dragged) - _sma(free)) * 1000.0
    rho = atmospheric_density(a0 - R_EARTH)
    expected_m = -2 * math.pi * ballistic * rho * (a0 * 1000.0) ** 2
    # Altitude varies a few km around the orbit under J2 and the atmosphere co-rotates, hence 10%.
    assert da_m < 0
    assert da_m == pytest.approx(expected_m, rel=0.10)


def test_drag_is_off_for_reference_orbits_and_when_disabled():
    configure_drag(True, 0.02, 1.0)
    ghost, real = _circular(400.0), _circular(400.0)
    propagate_states(ghost, 3000.0, max_step=5.0, drag=False)
    propagate_states(real, 3000.0, max_step=5.0)
    assert _sma(real) < _sma(ghost)

    configure_drag(False)
    a, b = _circular(400.0), _circular(400.0)
    propagate_states(a, 3000.0, max_step=5.0)
    propagate_states(b, 3000.0, max_step=5.0, drag=False)
    assert np.array_equal(a, b)


@pytest.mark.skipif(pe._native_set_drag is None, reason="C++ engine not built with drag support")
def test_native_and_numpy_drag_agree():
    configure_drag(True, 0.02, 2.0)
    sats = np.vstack([_circular(350.0), _circular(500.0, 97.0)])
    native = sats.copy()
    pe._native(native, np.zeros((0, 6)), 0.1, 600.0)
    numpy_ = sats.copy()
    pe._numpy_process_conjunctions(numpy_, np.zeros((0, 6)), 0.1, 600.0)
    assert np.linalg.norm(native[:, :3] - numpy_[:, :3], axis=1).max() < 1e-6


# ── per-object ballistic coefficients ──────────────────────────────────────────
def test_per_object_ballistic_coefficients_in_both_engines():
    configure_drag(True, 0.01, 1.0)
    base = np.vstack([_circular(400.0), _circular(400.0)])
    ballistic = np.array([0.002, 0.05])
    numpy_ = base.copy()
    pe._numpy_process_conjunctions(numpy_, np.zeros((0, 6)), 0.0, 1800.0, ballistic, None)
    # The heavier-drag object lags behind (lower orbit, faster decay).
    assert _sma(numpy_[1:2]) < _sma(numpy_[0:1])
    if pe._native_set_drag is not None:
        native = base.copy()
        pe.process_conjunctions(native, np.zeros((0, 6)), 0.0, 1800.0, ballistic, None)
        assert np.abs(native - numpy_).max() < 1e-6
    # NaN / non-positive entries fall back to the global coefficient.
    fallback, reference = base[:1].copy(), base[:1].copy()
    propagate_states(fallback, 600.0, ballistic=np.array([np.nan]))
    propagate_states(reference, 600.0)
    assert np.array_equal(fallback, reference)


def test_ballistic_coefficient_from_bstar():
    from types import SimpleNamespace
    from satellite_api.realworld.catalog import ballistic_coefficient
    as_obj = (lambda bstar: SimpleNamespace(satrec=SimpleNamespace(bstar=bstar)))
    assert ballistic_coefficient(as_obj(1e-4)) == pytest.approx(2e-4 / 0.15696615)
    assert np.isnan(ballistic_coefficient(as_obj(-3e-4)))      # negative B*: fit artefact
    assert np.isnan(ballistic_coefficient(as_obj(0.5)))        # absurd B*: not physics
    assert np.isnan(ballistic_coefficient(as_obj(0.0)))


@pytest.mark.asyncio
async def test_telemetry_ballistic_coefficients_drive_decay_and_survive_removal(client):
    from satellite_api.main import app
    from satellite_api.config import CONFIG
    sat = _circular(350.0)[0]
    obj = lambda i, b: {"id": i, "type": "SATELLITE", "r": dict(zip("xyz", sat[:3])), "v": dict(zip("xyz", sat[3:])),
                        **({"ballistic_coefficient": b} if b is not None else {})}
    await client.post("/api/telemetry", json={"timestamp": "2026-01-01T00:00:00.000Z",
                                              "objects": [obj("LIGHT", 0.002), obj("HEAVY", 0.08), obj("PLAIN", None)]})
    state = app.state.orbital_state
    assert np.isnan(state.sat_ballistic[state.sat_id_to_idx["PLAIN"]])
    CONFIG.atmosphericDrag = True
    await client.post("/api/simulate/step", json={"step_seconds": 3600})
    sma = {sid: _sma(state.sat_buffer[i:i + 1]) for sid, i in state.sat_id_to_idx.items()}
    assert sma["HEAVY"] < sma["PLAIN"] < sma["LIGHT"]

    async with state.lock:
        state.remove_satellites(["LIGHT"])
    assert state.sat_ballistic[state.sat_id_to_idx["HEAVY"]] == pytest.approx(0.08)
