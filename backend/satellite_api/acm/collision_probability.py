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
_math_erf = math.erf


def erf(x: np.ndarray) -> np.ndarray:
    """Element-wise erf for the 96 quadrature nodes (math.erf over a list is ~10x faster than np.vectorize)."""
    return np.fromiter(map(_math_erf, x.tolist()), dtype=float, count=len(x))


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


_HALF_CHORD = np.sqrt(np.maximum(0.0, 1.0 - _GL_NODES ** 2))
_SQRT_2PI = math.sqrt(2.0 * math.pi)


def _principal(cov_2d: np.ndarray):
    eigvals, eigvecs = np.linalg.eigh(cov_2d)
    eigvals = np.maximum(eigvals, 1e-18)
    return eigvecs, math.sqrt(eigvals[0]), math.sqrt(eigvals[1])


def _pc_principal(m0: float, m1: float, sx: float, sy: float, hbr_km: float) -> float:
    """Pc for a mean (m0, m1) expressed in the covariance principal axes (std devs sx, sy)."""
    # x = R·u over u ∈ [-1, 1]; inner y-integral over the chord is analytic.
    x = hbr_km * _GL_NODES
    half_chord = hbr_km * _HALF_CHORD
    gx = np.exp(-0.5 * ((x - m0) / sx) ** 2) / (sx * _SQRT_2PI)
    inner = 0.5 * (erf((m1 + half_chord) / (_SQRT2 * sy)) - erf((m1 - half_chord) / (_SQRT2 * sy)))
    return float(min(1.0, max(0.0, hbr_km * float(np.sum(_GL_WEIGHTS * gx * inner)))))


def pc_2d(miss_xy: np.ndarray, cov_2d: np.ndarray, hbr_km: float) -> float:
    """2-D Gaussian probability mass inside a circle of radius `hbr_km` centred at the origin,
    for a distribution with mean `miss_xy` and covariance `cov_2d` (same units)."""
    vecs, sx, sy = _principal(cov_2d)
    m = vecs.T @ np.asarray(miss_xy, dtype=float)   # mean in principal axes
    return _pc_principal(m[0], m[1], sx, sy, hbr_km)


def required_miss_km(miss_dir_xy: np.ndarray, cov_2d: np.ndarray, hbr_km: float, pc_target: float,
                     max_km: float = 50.0) -> float:
    """Smallest miss distance along `miss_dir_xy` at which Pc drops to `pc_target` (bisection; the
    covariance is decomposed once)."""
    d = np.asarray(miss_dir_xy, dtype=float)
    d = d / max(np.linalg.norm(d), 1e-12)
    vecs, sx, sy = _principal(cov_2d)
    u0, u1 = vecs.T @ d                              # unit direction in principal axes

    def pc_at(r):
        return _pc_principal(u0 * r, u1 * r, sx, sy, hbr_km)

    if pc_at(max_km) > pc_target:
        return max_km
    lo, hi = 0.0, max_km
    for _ in range(32):                      # 50 km / 2^32: far below a millimetre
        mid = 0.5 * (lo + hi)
        if pc_at(mid) > pc_target:
            lo = mid
        else:
            hi = mid
    return hi


_DILUTION_SCALES = np.logspace(-2.0, 2.0, 49)   # covariance scale factors k (sigma x k) searched for Pc_max


def max_pc(miss_xy: np.ndarray, cov_2d: np.ndarray, hbr_km: float) -> Tuple[float, float]:
    """(Pc_max, k): the largest Pc over covariance scalings k² C, and the k where it occurs.

    Probability dilution (Alfano; NASA CARA handbook): once the covariance is large compared with the
    miss distance, inflating it further LOWERS Pc, so a low Pc can mean "too uncertain to tell" rather
    than "safe". If the current covariance (k = 1) lies past the maximum (k_max < 1), the event is in
    the dilution region."""
    vecs, sx, sy = _principal(cov_2d)
    m = vecs.T @ np.asarray(miss_xy, dtype=float)
    f = lambda lk: _pc_principal(m[0], m[1], sx * math.exp(lk), sy * math.exp(lk), hbr_km)
    # Small hard body: Pc(k) ~ pi R^2 N(m; 0, k^2 C) = R^2/(2 k^2 sx sy) exp(-q / (2 k^2)), with q the squared
    # Mahalanobis distance, peaks at k* = sqrt(q/2). The exact peak is near it, so bracket k* and refine;
    # only a miss inside the hard body (no interior peak) needs the full scan.
    q = (m[0] / sx) ** 2 + (m[1] / sy) ** 2
    if float(np.hypot(m[0], m[1])) > 2.0 * hbr_km and q > 0.0:
        k_star = math.sqrt(q / 2.0)
        lo, hi = math.log(k_star) - 0.7, math.log(k_star) + 0.7     # x/2 .. x2 around the estimate
        edges = [(f(lo), lo), (f(hi), hi)]
    else:
        pcs = [_pc_principal(m[0], m[1], sx * k, sy * k, hbr_km) for k in _DILUTION_SCALES]
        i = int(np.argmax(pcs))
        # Golden-section refinement between the neighbouring grid points (Pc(k) is unimodal in k).
        lo = math.log(_DILUTION_SCALES[max(i - 1, 0)])
        hi = math.log(_DILUTION_SCALES[min(i + 1, len(_DILUTION_SCALES) - 1)])
        edges = [(pcs[i], math.log(_DILUTION_SCALES[i]))]
    g = (math.sqrt(5.0) - 1.0) / 2.0
    a, b = hi - g * (hi - lo), lo + g * (hi - lo)
    fa, fb = f(a), f(b)
    for _ in range(20):
        if fa > fb:
            hi, b, fb = b, a, fa
            a = hi - g * (hi - lo)
            fa = f(a)
        else:
            lo, a, fa = a, b, fb
            b = lo + g * (hi - lo)
            fb = f(b)
    lk = 0.5 * (lo + hi)
    best_pc, best_lk = max([(f(lk), lk), *edges])
    return best_pc, math.exp(best_lk)


# Short-encounter (2-D Pc) validity: the formula assumes straight-line relative motion through the
# encounter region. Slow, near co-orbital pairs spend long enough near each other for the motion to
# curve and the covariance to change (Coppola 2012; Hall et al. 2017, NASA CARA), which needs a 3-D Pc
# or Monte Carlo instead. Heuristic flags, not a proof of validity:
SHORT_ENCOUNTER_MIN_VREL_KMS = 0.1        # below this relative speed the linear model is suspect
SHORT_ENCOUNTER_MAX_PERIOD_FRACTION = 0.02  # crossing the 5-sigma region takes > 2 % of an orbit
_MU_KM3_S2 = 398600.4418


def encounter_duration_s(state_sat: np.ndarray, state_obj: np.ndarray, sigma_major_km: float, hbr_km: float) -> float:
    """Time to cross the region where a collision is possible (5-sigma + HBR either side of TCA)."""
    v_rel = float(np.linalg.norm(np.asarray(state_obj[3:6]) - np.asarray(state_sat[3:6])))
    return 2.0 * (5.0 * sigma_major_km + hbr_km) / max(v_rel, 1e-9)


def short_encounter_check(state_sat: np.ndarray, state_obj: np.ndarray, sigma_major_km: float, hbr_km: float) -> dict:
    v_rel = float(np.linalg.norm(np.asarray(state_obj[3:6]) - np.asarray(state_sat[3:6])))
    r = float(np.linalg.norm(state_sat[:3]))
    period_s = 2.0 * math.pi * math.sqrt(r ** 3 / _MU_KM3_S2)
    duration = encounter_duration_s(state_sat, state_obj, sigma_major_km, hbr_km)
    valid = v_rel >= SHORT_ENCOUNTER_MIN_VREL_KMS and duration <= SHORT_ENCOUNTER_MAX_PERIOD_FRACTION * period_s
    return {"short_encounter_valid": valid, "encounter_duration_s": round(duration, 1),
            "relative_speed_kms": round(v_rel, 4)}


def assess(state_sat: np.ndarray, state_obj: np.ndarray, miss_km: float, dt_to_tca_s: float,
           obj_is_owned: bool, hbr_m: float = DEFAULT_HBR_M, covariance_scale: float = 1.0,
           pc_threshold: Optional[float] = None, cov_sat_rtn: Optional[np.ndarray] = None,
           cov_obj_rtn: Optional[np.ndarray] = None, covariance_source: Optional[str] = None,
           obj_element_age_s: float = 0.0) -> dict:
    """Pc and encounter-plane geometry for one conjunction (states at/near TCA, same frame).

    `cov_sat_rtn` / `cov_obj_rtn`: measured 3x3 RTN position covariances [km^2] (e.g. from a CCSDS
    CDM). When both are given they replace the time-scaled model covariance.
    `obj_element_age_s`: how old the tracked object's orbital elements are now. Catalog (TLE) error grows
    from the element epoch, not from the moment of screening, so the object's model covariance is grown
    over age + time to TCA (TLE accuracy studies: along-track 1-sigma 10-30 km after one day in LEO)."""
    state_sat = np.asarray(state_sat, dtype=float)
    state_obj = np.asarray(state_obj, dtype=float)
    x_hat, y_hat, _ = encounter_frame(state_sat, state_obj)
    measured = cov_sat_rtn is not None and cov_obj_rtn is not None
    obj_dt = dt_to_tca_s + (0.0 if obj_is_owned else max(0.0, obj_element_age_s))
    if measured:
        cov = eci_covariance(state_sat, np.asarray(cov_sat_rtn, dtype=float)) + eci_covariance(state_obj, np.asarray(cov_obj_rtn, dtype=float))
    else:
        cov = (eci_covariance(state_sat, model_covariance_rtn(dt_to_tca_s, True, covariance_scale))
               + eci_covariance(state_obj, model_covariance_rtn(obj_dt, obj_is_owned, covariance_scale)))
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
    pc_max, k_max = max_pc(miss_xy, cov_2d, hbr_km)
    out = {
        "pc": pc,
        "pc_max": pc_max,
        # Past the maximum: a larger covariance would give a LOWER Pc, so a low Pc here is not evidence of safety.
        "pc_diluted": bool(k_max < 1.0 and pc_max > 10.0 * max(pc, 1e-300)),
        "pc_max_covariance_scale": round(k_max, 4),
        **short_encounter_check(state_sat, state_obj, sigma_major, hbr_km),
        "hbr_m": hbr_m,
        "covariance_model": (covariance_source or "measured (CDM)") if measured else (
            "time-scaled RTN model" + (" + element age" if obj_dt > dt_to_tca_s else "")),
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
