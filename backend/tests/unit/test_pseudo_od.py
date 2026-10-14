"""Pseudo-OD (Levit & Marshall): fitting several noisy element sets beats extrapolating the latest one."""
import numpy as np
import pytest

from satellite_api.physics_engine import configure_drag, propagate_states
from satellite_api.realworld import pseudo_od


@pytest.fixture(autouse=True)
def _drag():
    configure_drag(True, 0.01, 1.0)
    yield
    configure_drag(False)


def _truth_at(state0, b, times):
    return pseudo_od._propagate_to(np.asarray(state0, float).reshape(1, 6), np.array([b]), np.asarray(times, float))[:, 0, :]


def test_fit_beats_single_set_extrapolation_and_recovers_drag():
    rng = np.random.default_rng(7)
    r = 6378.137 + 350.0
    v = np.sqrt(398600.4418 / r)
    truth0 = np.array([r, 0.0, 0.0, 0.0, v * np.cos(np.radians(51.6)), v * np.sin(np.radians(51.6))])
    b_true = 0.02
    epochs = np.array([0.0, 12, 24, 36]) * 3600.0
    times, obs = [], []
    for ep in epochs:
        ts = np.clip(ep + np.array(pseudo_od.SAMPLE_OFFSETS_S), 0.0, None)
        true_pos = _truth_at(truth0, b_true, ts)
        # Each "element set" is off along-track by its own bias (TLE errors are along-track dominated) plus noise.
        along = np.diff(true_pos, axis=0).mean(axis=0)
        along /= np.linalg.norm(along)
        bias = rng.normal(0.0, 0.6) * along
        times.extend(ts)
        obs.extend(true_pos + bias + rng.normal(0.0, 0.05, size=true_pos.shape))
    order = np.argsort(times)
    times, obs = np.array(times)[order], np.array(obs)[order]

    guess = truth0 + np.array([1.0, -1.0, 0.5, 0.001, -0.001, 0.0005])
    fit = pseudo_od.fit(times, obs, guess, ballistic_guess=0.01)
    assert fit["rms_km"] < 1.0
    assert fit["ballistic_m2_kg"] == pytest.approx(b_true, rel=0.3)

    horizon = epochs[-1] + 24 * 3600.0
    truth_future = _truth_at(truth0, b_true, [horizon])[0]
    fitted_future = _truth_at(fit["state0"], fit["ballistic_m2_kg"], [horizon])[0]
    # The latest single set: its own (biased) position at its epoch, true-ish velocity, a generic B.
    last = obs[np.argmin(np.abs(times - epochs[-1]))]
    state_last = np.concatenate([last, np.zeros(3)])
    work = truth0.reshape(1, 6).copy()
    propagate_states(work, epochs[-1], max_step=30.0, ballistic=np.array([b_true]))
    state_last[3:] = work[0, 3:]
    single_future = _truth_at(state_last, 0.01, [24 * 3600.0])[0]
    err_fit = np.linalg.norm(fitted_future - truth_future)
    err_single = np.linalg.norm(single_future - truth_future)
    print(f"24 h prediction error: fit {err_fit:.2f} km, latest set {err_single:.2f} km; "
          f"B fit {fit['ballistic_m2_kg']:.4f} (true {b_true}); rms {fit['rms_km']:.2f} km")
    assert err_fit < err_single, (err_fit, err_single)
