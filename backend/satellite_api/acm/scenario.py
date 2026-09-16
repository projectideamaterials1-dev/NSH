"""
acm/scenario.py
---------------
Helpers for building reproducible encounter scenarios (tests, demo mode).
"""
import math

import numpy as np

from satellite_api.physics_engine import propagate_states


def _rotate(v: np.ndarray, axis: np.ndarray, angle_rad: float) -> np.ndarray:
    axis = axis / np.linalg.norm(axis)
    return (v * math.cos(angle_rad) + np.cross(axis, v) * math.sin(angle_rad)
            + axis * float(axis @ v) * (1.0 - math.cos(angle_rad)))


def make_threat(sat_state: np.ndarray, tca_s: float, miss_km: float = 0.05,
                crossing_angle_deg: float = 90.0) -> np.ndarray:
    """Returns a present-epoch debris state that passes `sat_state`'s un-maneuvered trajectory
    at `tca_s` seconds from now with a radial miss of `miss_km`, crossing its track at
    `crossing_angle_deg` (J2 dynamics are time-reversible, so the debris is back-propagated)."""
    sat = np.array(sat_state, dtype=np.float64).reshape(1, 6)
    propagate_states(sat, tca_s)
    r_tca, v_tca = sat[0, :3], sat[0, 3:]
    r_hat = r_tca / np.linalg.norm(r_tca)

    deb = np.empty((1, 6))
    deb[0, :3] = r_tca + r_hat * miss_km
    deb[0, 3:] = _rotate(v_tca, r_hat, math.radians(crossing_angle_deg))

    deb[0, 3:] *= -1.0          # run the clock backwards
    propagate_states(deb, tca_s)
    deb[0, 3:] *= -1.0
    return deb[0]


def circular_state_over(lat_deg: float, lon_deg: float, ts: float, alt_km: float = 550.0,
                        heading: str = "north") -> np.ndarray:
    """Circular-orbit ECI state directly above a ground point at time `ts`."""
    from satellite_api.ground_stations import gmst_rad
    lat, lon = math.radians(lat_deg), math.radians(lon_deg) + gmst_rad(ts)
    r = 6378.137 + alt_km
    pos = r * np.array([math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)])
    east = np.array([-math.sin(lon), math.cos(lon), 0.0])
    north = np.cross(pos / r, east)
    direction = north if heading == "north" else east
    # tilt slightly east so the orbit is not exactly polar
    vel = (0.8 * direction + 0.6 * east) if heading == "north" else direction
    vel = vel / np.linalg.norm(vel) * math.sqrt(398600.4418 / r)
    return np.concatenate([pos, vel])
