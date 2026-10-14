"""
realworld/pseudo_od.py
----------------------
Pseudo orbit determination from element-set history (Levit & Marshall, "Improved orbit predictions
using two-line elements"): fit the engine's numerical model (RK4 + J2 + drag) to positions sampled
from SEVERAL consecutive element sets of one object, each sampled only near its own epoch where it is
most accurate. The fitted state averages out the individual sets' errors, and the fitted drag
strength comes from the actual decay over days instead of a single B*. Levit & Marshall report LEO
prediction error growth falling from ~0.1-3 km/day (TLE + SGP4) to 50-200 m/day.

Fit parameters: the 6-element state at the earliest observation plus the ballistic coefficient
(Cd*A/m). Gauss-Newton with a finite-difference Jacobian; every iteration propagates the nominal and
the 7 perturbed trajectories together in one batch.

CelesTrak only serves the latest element set, so the live service keeps the sets it has seen at each
refresh (RealWorldService.element_history); a fit needs at least MIN_SETS spanning MIN_SPAN_H.
"""
import math
from datetime import datetime, timezone
from typing import List, Optional, Sequence

import numpy as np

from satellite_api.physics_engine import propagate_states

MIN_SETS = 3
MIN_SPAN_H = 12.0
SAMPLE_OFFSETS_S = (-1800.0, -900.0, 0.0, 900.0, 1800.0)    # around each element set's epoch
_PERTURB = np.array([0.01, 0.01, 0.01, 1e-5, 1e-5, 1e-5])     # km, km/s finite-difference steps
_B_PERTURB = 1e-3                                            # m^2/kg
STEP_S = 30.0


def _propagate_to(states: np.ndarray, ballistic: np.ndarray, times: np.ndarray) -> np.ndarray:
    """Positions of every row at each of the (ascending, >= 0) times. Returns (len(times), rows, 3)."""
    work = states.copy()
    out = np.empty((len(times), len(states), 3))
    t = 0.0
    for i, ti in enumerate(times):
        if ti - t > 1e-9:
            propagate_states(work, ti - t, max_step=STEP_S, ballistic=ballistic)
            t = ti
        out[i] = work[:, :3]
    return out


def fit(times_s: np.ndarray, positions_km: np.ndarray, state0_guess: np.ndarray, ballistic_guess: float = 0.01,
        iterations: int = 8, fit_drag: bool = True) -> dict:
    """Least-squares state (at t=0) and ballistic coefficient matching the observed positions.

    times_s: observation times [s] from the fit epoch (>= 0, ascending); positions_km: (n, 3)."""
    times_s = np.asarray(times_s, dtype=float)
    obs = np.asarray(positions_km, dtype=float)
    x = np.concatenate([np.asarray(state0_guess, dtype=float), [max(ballistic_guess, 1e-4)]])
    n_par = 7 if fit_drag else 6
    rms = math.inf
    for _ in range(iterations):
        rows = np.repeat(x[:6].reshape(1, 6), 1 + n_par, axis=0)
        bal = np.full(1 + n_par, x[6])
        for j in range(6):
            rows[1 + j, j] += _PERTURB[j]
        if fit_drag:
            bal[7] += _B_PERTURB
        pos = _propagate_to(rows, bal, times_s)                   # (n_obs, 1+n_par, 3)
        resid = (obs - pos[:, 0, :]).reshape(-1)
        steps = np.concatenate([_PERTURB, [_B_PERTURB]])[:n_par]
        jac = np.stack([(pos[:, 1 + j, :] - pos[:, 0, :]).reshape(-1) / steps[j] for j in range(n_par)], axis=1)
        dx, *_ = np.linalg.lstsq(jac, resid, rcond=None)
        x[:n_par] += dx
        x[6] = max(x[6], 1e-5)
        new_rms = float(np.sqrt(np.mean(resid ** 2)) * math.sqrt(3))   # 3-D position RMS
        if abs(rms - new_rms) < 1e-4 * max(new_rms, 1e-6):
            rms = new_rms
            break
        rms = new_rms
    final = _propagate_to(x[:6].reshape(1, 6), np.array([x[6]]), times_s)[:, 0, :]
    rms = float(np.sqrt(np.mean(np.sum((obs - final) ** 2, axis=1))))
    return {"state0": x[:6], "ballistic_m2_kg": float(x[6]), "rms_km": rms,
            "residuals_km": np.linalg.norm(obs - final, axis=1)}


def observations_from_sets(sets: Sequence, epoch0: datetime) -> tuple:
    """SGP4 pseudo-observations (TEME) from catalog element sets, each sampled around its own epoch.
    Returns (times_s from epoch0, positions_km, set index per observation)."""
    from sgp4.api import jday
    times, pos, owner = [], [], []
    for k, obj in enumerate(sets):
        for off in SAMPLE_OFFSETS_S:
            t = obj.epoch.timestamp() + off
            if t < epoch0.timestamp():
                continue
            dt = datetime.fromtimestamp(t, tz=timezone.utc)
            jd, fr = jday(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second + dt.microsecond * 1e-6)
            err, r, _ = obj.satrec.sgp4(jd, fr)
            if err == 0:
                times.append(t - epoch0.timestamp())
                pos.append(r)
                owner.append(k)
    order = np.argsort(times)
    return np.array(times)[order], np.array(pos)[order], np.array(owner)[order]


def fit_element_history(sets: List, ballistic_guess: float = 0.01) -> Optional[dict]:
    """Pseudo-OD over an object's element-set history (oldest first). None if there are too few sets or
    they span too little time."""
    sets = sorted(sets, key=lambda o: o.epoch)
    if len(sets) < MIN_SETS or (sets[-1].epoch - sets[0].epoch).total_seconds() < MIN_SPAN_H * 3600.0:
        return None
    from sgp4.api import jday
    epoch0 = sets[0].epoch
    jd, fr = jday(epoch0.year, epoch0.month, epoch0.day, epoch0.hour, epoch0.minute,
                  epoch0.second + epoch0.microsecond * 1e-6)
    err, r, v = sets[0].satrec.sgp4(jd, fr)
    if err != 0:
        return None
    times, pos, owner = observations_from_sets(sets, epoch0)
    result = fit(times, pos, np.concatenate([r, v]), ballistic_guess)
    per_set = [float(np.sqrt(np.mean(result["residuals_km"][owner == k] ** 2))) for k in range(len(sets))]
    return {
        "epoch": epoch0, "sets": len(sets), "span_h": round((sets[-1].epoch - epoch0).total_seconds() / 3600.0, 1),
        "state0": result["state0"], "ballistic_m2_kg": result["ballistic_m2_kg"], "rms_km": result["rms_km"],
        "rms_per_set_km": per_set,
    }
