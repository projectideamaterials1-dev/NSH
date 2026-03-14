"""
physics.py — Orbital mechanics engine
--------------------------------------
Implements:
  • Two-body gravity
  • J2 oblateness perturbation
  • RK4 numerical integrator
  • Closest Approach distance (TCA) estimator
"""

import math
from typing import Tuple

# ─── Earth Constants ──────────────────────────────────────────────────────────
MU    = 398600.4418       # km³/s²  — Earth's gravitational parameter
R_EQ  = 6378.137          # km      — Earth equatorial radius
J2    = 1.08262668e-3     # Dimensionless — J2 oblateness coefficient
CRIT_DIST_KM = 0.1        # km      — Collision warning threshold (100 meters)


# ─── Acceleration ─────────────────────────────────────────────────────────────

def acceleration(r: list[float]) -> list[float]:
    """
    Compute total acceleration at position r [km].

    a = a_gravity + a_J2

    a_gravity = -μ/|r|³ * r

    a_J2 = (3/2) * J2 * μ * R_eq² / |r|⁵ * [
        x * (5z²/r² - 1),
        y * (5z²/r² - 1),
        z * (5z²/r² - 3)
    ]
    """
    x, y, z = r
    r_mag = math.sqrt(x*x + y*y + z*z)
    r3    = r_mag ** 3
    r5    = r_mag ** 5

    # Two-body gravity
    ax_grav = -MU * x / r3
    ay_grav = -MU * y / r3
    az_grav = -MU * z / r3

    # J2 perturbation
    coeff = 1.5 * J2 * MU * (R_EQ ** 2) / r5
    factor_xy = 1.0 - 5.0 * (z * z) / (r_mag * r_mag)
    factor_z  = 3.0 - 5.0 * (z * z) / (r_mag * r_mag)

    ax_j2 = coeff * x * (-factor_xy)
    ay_j2 = coeff * y * (-factor_xy)
    az_j2 = coeff * z * (-factor_z)

    return [
        ax_grav + ax_j2,
        ay_grav + ay_j2,
        az_grav + az_j2,
    ]


# ─── RK4 Integrator ───────────────────────────────────────────────────────────

def _add(a: list[float], b: list[float]) -> list[float]:
    return [a[i] + b[i] for i in range(3)]

def _scale(v: list[float], s: float) -> list[float]:
    return [x * s for x in v]


def rk4_step(r: list[float], v: list[float], dt: float) -> Tuple[list[float], list[float]]:
    """
    Advance state (r, v) by dt seconds using 4th-order Runge-Kutta.

    State derivative:
        dr/dt = v
        dv/dt = a(r)
    """
    def deriv(ri, vi):
        return vi, acceleration(ri)

    # k1
    dr1, dv1 = deriv(r, v)

    # k2
    r2 = _add(r, _scale(dr1, dt / 2))
    v2 = _add(v, _scale(dv1, dt / 2))
    dr2, dv2 = deriv(r2, v2)

    # k3
    r3 = _add(r, _scale(dr2, dt / 2))
    v3 = _add(v, _scale(dv2, dt / 2))
    dr3, dv3 = deriv(r3, v3)

    # k4
    r4 = _add(r, _scale(dr3, dt))
    v4 = _add(v, _scale(dv3, dt))
    dr4, dv4 = deriv(r4, v4)

    # Weighted sum
    r_new = [
        r[i] + (dt / 6) * (dr1[i] + 2*dr2[i] + 2*dr3[i] + dr4[i])
        for i in range(3)
    ]
    v_new = [
        v[i] + (dt / 6) * (dv1[i] + 2*dv2[i] + 2*dv3[i] + dv4[i])
        for i in range(3)
    ]

    return r_new, v_new


# ─── Collision / Closest Approach ─────────────────────────────────────────────

def separation_km(r1: list[float], r2: list[float]) -> float:
    """Euclidean distance between two position vectors (km)."""
    return math.sqrt(sum((r1[i] - r2[i]) ** 2 for i in range(3)))


def relative_velocity_kms(v1: list[float], v2: list[float]) -> float:
    """Relative speed between two objects (km/s)."""
    return math.sqrt(sum((v1[i] - v2[i]) ** 2 for i in range(3)))


def time_to_closest_approach(
    r1: list[float], v1: list[float],
    r2: list[float], v2: list[float],
) -> Tuple[float, float]:
    """
    Linear TCA estimate (seconds until minimum separation).
    Uses dot product of relative position and velocity.

    Returns (tca_seconds, min_dist_km).
    """
    dr = [r2[i] - r1[i] for i in range(3)]
    dv = [v2[i] - v1[i] for i in range(3)]

    dv2 = sum(x * x for x in dv)
    if dv2 < 1e-12:
        # Objects moving in parallel — current separation is closest
        return 0.0, separation_km(r1, r2)

    t_min = -sum(dr[i] * dv[i] for i in range(3)) / dv2

    # Clamp to positive future
    t_min = max(0.0, t_min)

    r1_tca = [r1[i] + v1[i] * t_min for i in range(3)]
    r2_tca = [r2[i] + v2[i] * t_min for i in range(3)]
    dist_tca = separation_km(r1_tca, r2_tca)

    return t_min, dist_tca


def risk_level(dist_km: float) -> str:
    """Classify collision risk by closest-approach distance."""
    if dist_km < 0.5:
        return "CRITICAL"
    elif dist_km < 1.5:
        return "HIGH"
    elif dist_km < CRIT_DIST_KM:
        return "MEDIUM"
    else:
        return "LOW"