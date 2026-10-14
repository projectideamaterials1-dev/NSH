"""
acm/monte_carlo.py
------------------
Monte Carlo probability of collision for encounters where the 2-D short-encounter formula is not
trustworthy (slow, near co-orbital pairs flagged by collision_probability.short_encounter_check).
NASA CARA uses a 3-D Pc or Monte Carlo for those (Hall, Hejduk & Johnson 2017).

Both objects are sampled from their position covariances (and a velocity spread consistent with
them, see below) at the start of a window around TCA, every sample pair is propagated with the full
force model (RK4 + J2 + drag) through the window, and a sample counts as a hit when the pair's
closest approach (continuous, linear between steps) is inside the hard-body radius. Curvature,
the time spent close together and changing geometry are therefore all modeled, unlike in the 2-D Pc.

Velocity spread: the covariance model only carries positions. A position error of size sigma on a
near-circular orbit comes with a velocity error of about n * sigma (Clohessy-Wiltshire scaling), so
velocities are sampled with that spread, uncorrelated. That is an approximation and is reported as
such.
"""
import math
from typing import Optional

import numpy as np

from satellite_api.acm.collision_probability import eci_covariance
from satellite_api.acm.conjunctions import closest_approach
from satellite_api.physics_engine import propagate_fast

_MU = 398600.4418
MAX_HALF_WINDOW_S = 1800.0


def _wilson(hits: int, n: int, z: float = 1.96):
    p = hits / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return max(0.0, centre - half), min(1.0, centre + half)


def _samples(state: np.ndarray, cov_rtn: np.ndarray, n: int, rng: np.random.Generator) -> np.ndarray:
    cov = eci_covariance(state, cov_rtn)
    pos = rng.multivariate_normal(np.zeros(3), cov, size=n, method="eigh")
    r = float(np.linalg.norm(state[:3]))
    mean_motion = math.sqrt(_MU / r ** 3)
    vel = rng.multivariate_normal(np.zeros(3), cov * mean_motion ** 2, size=n, method="eigh")
    out = np.repeat(state.reshape(1, 6), n, axis=0)
    out[:, :3] += pos
    out[:, 3:] += vel
    return out


def monte_carlo_pc(state_sat: np.ndarray, state_obj: np.ndarray, dt_to_tca_s: float, cov_sat_rtn: np.ndarray,
                   cov_obj_rtn: np.ndarray, hbr_km: float, encounter_duration_s: float, samples: int = 5000,
                   seed: Optional[int] = 0, ballistic_sat: float = float("nan"),
                   ballistic_obj: float = float("nan")) -> dict:
    """Pc by sampling. States are 'now'; the window is centred on TCA (dt_to_tca_s from now) and spans
    the encounter (at least +-60 s, at most +-30 min), clipped so it never starts in the past."""
    half = min(MAX_HALF_WINDOW_S, max(60.0, 0.5 * encounter_duration_s))
    start = max(0.0, dt_to_tca_s - half)
    window = (dt_to_tca_s - start) + half
    base = np.vstack([np.asarray(state_sat, float), np.asarray(state_obj, float)])
    bal = np.array([ballistic_sat, ballistic_obj], dtype=float)
    if start > 0:
        propagate_fast(base, start, None if np.isnan(bal).all() else bal)
    rng = np.random.default_rng(seed)
    a = _samples(base[0], cov_sat_rtn, samples, rng)
    b = _samples(base[1], cov_obj_rtn, samples, rng)
    step = min(5.0, max(0.5, window / 200.0))
    bal_a = None if math.isnan(ballistic_sat) else np.full(samples, ballistic_sat)
    bal_b = None if math.isnan(ballistic_obj) else np.full(samples, ballistic_obj)
    miss, _, _, _ = closest_approach(a, b, window_s=window, step_s=step, ballistic_a=bal_a, ballistic_b=bal_b)
    hits = int(np.count_nonzero(miss < hbr_km))
    lo, hi = _wilson(hits, samples)
    return {
        "pc_mc": hits / samples, "hits": hits, "samples": samples,
        "ci95": [lo, hi],
        # With no hits, the 95 % upper bound (~3/N) is the honest statement: "Pc is below this".
        "resolution": 1.0 / samples,
        "window_s": round(window, 1), "step_s": round(step, 2),
        "median_miss_km": float(np.median(miss)),
        "method": "Monte Carlo, RK4 + J2 + drag, position covariance + n*sigma velocity spread",
    }
