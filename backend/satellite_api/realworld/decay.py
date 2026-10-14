"""
realworld/decay.py
------------------
Orbital lifetime and re-entry estimates for catalog objects (cf. The Aerospace Corporation's CORDS
re-entry predictions and public re-entry trackers).

For a near-circular orbit, drag shrinks the semi-major axis at

    da/dt = -B * rho(h) * sqrt(mu * a)            (B = Cd*A/m)

The drag strength K = B * (activity scaling) is calibrated from the object's OWN observed decay: the
element set's MEAN_MOTION_DOT (n-dot/2) gives da/dt now, so K = |da/dt| / (rho(h0) sqrt(mu a0)). That
absorbs the true area-to-mass ratio, attitude and current solar activity. When the elements show no
decay, B from B* is used instead (with the current NOAA density scale). The lifetime is then the
integral of dh / |da/dt| from the current altitude down to 120 km through the engine's atmosphere
table (Vallado 8-4).

Accuracy: re-entry predictions are inherently uncertain - solar activity alone moves them by tens of
percent - so a +-25 % window is reported (CORDS quotes similar relative windows), and eccentric orbits
(e > 0.02) are marked low-confidence because perigee drag, not the mean altitude, dominates them.
"""
import math
from typing import Optional

from satellite_api.physics_engine import R_EARTH, atmospheric_density

MU_SI = 3.986004418e14            # m^3/s^2
REENTRY_ALT_KM = 120.0            # below this an object re-enters within hours
WINDOW_FRACTION = 0.25
MAX_LIFETIME_DAYS = 3650.0        # beyond ~10 years: "long-lived", no date


def _rate_m_s(k: float, alt_km: float) -> float:
    """|da/dt| [m/s] at altitude alt_km for drag strength k [m^2/kg]."""
    a_m = (R_EARTH + alt_km) * 1000.0
    return k * float(atmospheric_density(alt_km)) * math.sqrt(MU_SI * a_m)


def lifetime_days(alt_km: float, k: float, step_km: float = 1.0) -> float:
    """Days until the orbit decays from alt_km to REENTRY_ALT_KM, for drag strength k."""
    if k <= 0.0 or alt_km <= REENTRY_ALT_KM:
        return 0.0
    total_s, h = 0.0, alt_km
    while h > REENTRY_ALT_KM:
        dh = min(step_km, h - REENTRY_ALT_KM)
        mid = h - dh / 2.0
        total_s += dh * 1000.0 / _rate_m_s(k, mid)
        if total_s > MAX_LIFETIME_DAYS * 86400.0:
            return math.inf
        h -= dh
    return total_s / 86400.0


def estimate(elements: dict, mean_motion_dot: float, ballistic_m2_kg: float = float("nan"),
             density_scale: float = 1.0) -> Optional[dict]:
    """Lifetime estimate from an element set. `elements` is CatalogObject.elements(); mean_motion_dot is
    the OMM MEAN_MOTION_DOT [rev/day^2] (= n-dot/2). None when the object shows no measurable decay and
    has no usable ballistic coefficient."""
    a_km = elements["semi_major_axis_km"]
    e = elements["eccentricity"]
    n = elements["mean_motion_rev_day"]
    perigee, apogee = elements["perigee_alt_km"], elements["apogee_alt_km"]
    # Drag acts mostly near perigee: for eccentric orbits use an effective altitude between perigee and the mean.
    h0 = perigee + 0.25 * (apogee - perigee) if e > 0.02 else a_km - R_EARTH
    method = None
    k = 0.0
    if mean_motion_dot > 0.0 and n > 0.0:
        da_dt_km_day = (2.0 / 3.0) * a_km * (2.0 * mean_motion_dot) / n          # positive = shrinking
        k = (da_dt_km_day * 1000.0 / 86400.0) / _rate_m_s(1.0, h0)
        method = "observed decay (n-dot) calibrated"
    elif math.isfinite(ballistic_m2_kg) and ballistic_m2_kg > 0.0:
        k = ballistic_m2_kg * density_scale
        method = "B* ballistic coefficient x current solar activity"
    if not method:
        return None
    days = lifetime_days(h0, k)
    out = {
        "perigee_alt_km": perigee, "apogee_alt_km": apogee, "effective_alt_km": round(h0, 1),
        "decay_rate_km_per_day": round(_rate_m_s(k, h0) * 86400.0 / 1000.0, 4),
        "lifetime_days": None if math.isinf(days) else round(days, 2),
        "window_days": None if math.isinf(days) else [round(days * (1 - WINDOW_FRACTION), 2),
                                                        round(days * (1 + WINDOW_FRACTION), 2)],
        "method": method,
        "confidence": "low (eccentric orbit)" if e > 0.02 else "nominal",
    }
    return out
