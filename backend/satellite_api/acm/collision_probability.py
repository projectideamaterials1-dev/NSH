"""
acm/collision_probability.py
----------------------------
Probability of collision (Pc) for a predicted close approach, using the standard
short-encounter (linearised relative motion) assumption.

At TCA the relative motion is treated as a straight line, so the 3-D problem collapses
onto the *encounter plane* (B-plane) perpendicular to the relative velocity:

    x̂ = miss vector direction,  ẑ = relative velocity direction,  ŷ = ẑ × x̂

The combined position covariance C = C_sat + C_obj (both rotated from their own RTN
frames into ECI) is projected onto (x̂, ŷ), and Pc is the 2-D Gaussian mass that falls
inside the combined hard-body circle of radius HBR centred on the miss vector:

    Pc = ∬_{|r| ≤ HBR} N(r; m, C₂) dA          (Foster 1992 / Alfano 2005)

evaluated in the covariance's principal axes as a 1-D integral with an analytic inner
erf term, using Gauss-Legendre quadrature (accurate to ~1e-10 for HBR up to many σ).

Real CDMs carry covariances from the orbit-determination process. This engine has no
OD covariance, so `model_covariance_rtn` supplies a documented *model* covariance that
grows linearly with time-to-TCA, with separate settings for owned satellites (precise
GNSS ephemerides) and tracked objects (TLE-quality catalog data). The resulting Pc is
appropriate for ranking and for demonstrating Pc-based decision logic, not for
certified operational screening.
"""
import math
from typing import Optional, Tuple

import numpy as np

# 1-σ RTN position uncertainty (km) at epoch and its growth rate (km per day to TCA).
# Owned satellite: onboard GNSS + operator OD. Tracked objects: TLE-quality catalog states,
# where along-track error dominates and grows fastest.
SAT_SIGMA0_KM = np.array([0.010, 0.040, 0.010])
SAT_SIGMA_RATE_KM_PER_DAY = np.array([0.005, 0.100, 0.005])
OBJ_SIGMA0_KM = np.array([0.100, 0.400, 0.150])
OBJ_SIGMA_RATE_KM_PER_DAY = np.array([0.050, 1.000, 0.080])

DEFAULT_HBR_M = 20.0          # combined hard-body radius (satellite + object envelope)
_GL_NODES, _GL_WEIGHTS = np.polynomial.legendre.leggauss(96)
_SQRT2 = math.sqrt(2.0)
erf = np.vectorize(math.erf, otypes=[float])


def rtn_basis(r: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Columns are the R, T, N unit vectors expressed in the input (ECI/TEME) frame."""
    r_hat = r / np.linalg.norm(r)
    n_vec = np.cross(r, v)
    n_hat = n_vec / np.linalg.norm(n_vec)
    t_hat = np.cross(n_hat, r_hat)
    return np.column_stack([r_hat, t_hat, n_hat])


def model_covariance_rtn(dt_s: float, is_owned: bool, scale: float = 1.0) -> np.ndarray:
    """Diagonal RTN position covariance (km²) after propagating `dt_s` seconds to TCA."""
    days = max(0.0, dt_s) / 86400.0
    if is_owned:
        sigma = SAT_SIGMA0_KM + SAT_SIGMA_RATE_KM_PER_DAY * days
    else:
        sigma = OBJ_SIGMA0_KM + OBJ_SIGMA_RATE_KM_PER_DAY * days
    return np.diag((sigma * scale) ** 2)


def eci_covariance(state: np.ndarray, cov_rtn: np.ndarray) -> np.ndarray:
    basis = rtn_basis(state[:3], state[3:6])
    return basis @ cov_rtn @ basis.T


def encounter_frame(state_a: np.ndarray, state_b: np.ndarray) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(x̂, ŷ, ẑ) of the encounter plane for the pair; B relative to A."""
    rel_r = state_b[:3] - state_a[:3]
    rel_v = state_b[3:6] - state_a[3:6]
    if np.linalg.norm(rel_v) < 1e-9:
        rel_v = state_a[3:6]          # co-moving pair: fall back to the along-track direction
    z_hat = rel_v / max(np.linalg.norm(rel_v), 1e-12)
    miss = rel_r - (rel_r @ z_hat) * z_hat
    miss_norm = np.linalg.norm(miss)
    if miss_norm < 1e-9:
        # Dead-centre geometry: any direction perpendicular to ẑ will do.
        trial = np.array([1.0, 0.0, 0.0]) if abs(z_hat[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
        miss = trial - (trial @ z_hat) * z_hat
        miss_norm = np.linalg.norm(miss)
    x_hat = miss / miss_norm
    y_hat = np.cross(z_hat, x_hat)
    return x_hat, y_hat, z_hat


def pc_2d(miss_xy: np.ndarray, cov_2d: np.ndarray, hbr_km: float) -> float:
    """2-D Gaussian probability mass inside a circle of radius `hbr_km` centred at the origin,
    for a distribution with mean `miss_xy` and covariance `cov_2d` (same units)."""
    eigvals, eigvecs = np.linalg.eigh(cov_2d)
    eigvals = np.maximum(eigvals, 1e-18)
    m = eigvecs.T @ np.asarray(miss_xy, dtype=float)   # mean in principal axes
    sx, sy = math.sqrt(eigvals[0]), math.sqrt(eigvals[1])
    # x = R·u over u ∈ [-1, 1]; inner y-integral over the chord is analytic.
    x = hbr_km * _GL_NODES
    half_chord = hbr_km * np.sqrt(np.maximum(0.0, 1.0 - _GL_NODES ** 2))
    gx = np.exp(-0.5 * ((x - m[0]) / sx) ** 2) / (sx * math.sqrt(2.0 * math.pi))
    inner = 0.5 * (erf((m[1] + half_chord) / (_SQRT2 * sy)) - erf((m[1] - half_chord) / (_SQRT2 * sy)))
    return float(np.clip(hbr_km * np.sum(_GL_WEIGHTS * gx * inner), 0.0, 1.0))


def required_miss_km(miss_dir_xy: np.ndarray, cov_2d: np.ndarray, hbr_km: float, pc_target: float,
                     max_km: float = 50.0) -> float:
    """Smallest miss distance along `miss_dir_xy` at which Pc drops to `pc_target` (bisection)."""
    d = np.asarray(miss_dir_xy, dtype=float)
    d = d / max(np.linalg.norm(d), 1e-12)
    if pc_2d(d * max_km, cov_2d, hbr_km) > pc_target:
        return max_km
    lo, hi = 0.0, max_km
    for _ in range(40):
        mid = 0.5 * (lo + hi)
        if pc_2d(d * mid, cov_2d, hbr_km) > pc_target:
            lo = mid
        else:
            hi = mid
    return hi


def assess(state_sat: np.ndarray, state_obj: np.ndarray, miss_km: float, dt_to_tca_s: float,
           obj_is_owned: bool, hbr_m: float = DEFAULT_HBR_M, covariance_scale: float = 1.0,
           pc_threshold: Optional[float] = None, cov_sat_rtn: Optional[np.ndarray] = None,
           cov_obj_rtn: Optional[np.ndarray] = None, covariance_source: Optional[str] = None) -> dict:
    """Pc and encounter-plane geometry for one conjunction (states at/near TCA, same frame).

    `cov_sat_rtn` / `cov_obj_rtn`: measured 3x3 RTN position covariances [km^2] (e.g. from a CCSDS
    CDM). When both are given they replace the time-scaled model covariance."""
    state_sat = np.asarray(state_sat, dtype=float)
    state_obj = np.asarray(state_obj, dtype=float)
    x_hat, y_hat, _ = encounter_frame(state_sat, state_obj)
    measured = cov_sat_rtn is not None and cov_obj_rtn is not None
    if measured:
        cov = eci_covariance(state_sat, np.asarray(cov_sat_rtn, dtype=float)) +             eci_covariance(state_obj, np.asarray(cov_obj_rtn, dtype=float))
    else:
        cov = (eci_covariance(state_sat, model_covariance_rtn(dt_to_tca_s, True, covariance_scale))
               + eci_covariance(state_obj, model_covariance_rtn(dt_to_tca_s, obj_is_owned, covariance_scale)))
    plane = np.vstack([x_hat, y_hat])
    # Tiny floor keeps degenerate (co-moving / near-zero covariance) geometry well-posed.
    cov_2d = plane @ cov @ plane.T + np.eye(2) * 1e-12
    hbr_km = hbr_m / 1000.0
    miss_xy = np.array([miss_km, 0.0])
    pc = pc_2d(miss_xy, cov_2d, hbr_km)

    eigvals, eigvecs = np.linalg.eigh(cov_2d)
    major = int(np.argmax(eigvals))
    angle = math.degrees(math.atan2(eigvecs[1, major], eigvecs[0, major]))
    sigma_major, sigma_minor = math.sqrt(max(eigvals[major], 0.0)), math.sqrt(max(eigvals[1 - major], 0.0))
    # Mahalanobis distance of the miss vector: how many σ the predicted miss is from a hit.
    mahalanobis = float(math.sqrt(max(miss_xy @ np.linalg.solve(cov_2d, miss_xy), 0.0)))
    out = {
        "pc": pc,
        "hbr_m": hbr_m,
        "covariance_model": (covariance_source or "measured (CDM)") if measured else "time-scaled RTN model",
        "covariance_measured": measured,
        "encounter_plane": {
            "miss_x_km": float(miss_km), "miss_y_km": 0.0,
            "sigma_major_km": sigma_major, "sigma_minor_km": sigma_minor,
            "ellipse_angle_deg": (angle + 180.0) % 180.0,
            "mahalanobis": mahalanobis,
        },
    }
    if pc_threshold is not None:
        target = required_miss_km(np.array([1.0, 0.0]), cov_2d, hbr_km, pc_threshold / 10.0)
        out["safe_miss_km"] = float(target)
    return out
