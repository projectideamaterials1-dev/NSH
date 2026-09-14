"""
ground_stations.py
------------------
Ground-station catalogue (data/ground_stations.csv) and vectorised visibility maths
shared by maneuver validation, the autopilot, pass prediction and the dashboard API.
"""
import csv
import logging
import math
from dataclasses import dataclass
from typing import List

import numpy as np

from satellite_api.timeutils import data_dir

logger = logging.getLogger(__name__)

R_EARTH = 6378.137


@dataclass(frozen=True)
class GroundStation:
    id: str
    name: str
    latitude: float
    longitude: float
    elevation_m: float
    min_elevation_deg: float


def _load() -> List[GroundStation]:
    stations = []
    try:
        with open(data_dir() / "ground_stations.csv", mode="r", encoding="utf-8") as f:
            for row in csv.DictReader(filter(lambda r: r.strip(), f)):
                clean = {k.strip(): v.strip() for k, v in row.items()}
                min_key = "Min Elevation_Angle_deg" if "Min Elevation_Angle_deg" in clean else "Min_Elevation_Angle_deg"
                stations.append(GroundStation(
                    id=clean.get("Station_ID", f"GS-{len(stations) + 1:03d}"),
                    name=clean.get("Station_Name", ""),
                    latitude=float(clean.get("Latitude", 0.0)),
                    longitude=float(clean.get("Longitude", 0.0)),
                    elevation_m=float(clean.get("Elevation_m", 0.0)),
                    min_elevation_deg=float(clean.get(min_key, 0.0)),
                ))
    except Exception as e:  # missing/invalid file -> no LOS constraint
        logger.warning(f"Could not load ground stations: {e}")
    return stations


STATIONS: List[GroundStation] = _load()


def _ecef(st: GroundStation) -> List[float]:
    lat, lon = math.radians(st.latitude), math.radians(st.longitude)
    r = R_EARTH + st.elevation_m / 1000.0
    return [r * math.cos(lat) * math.cos(lon), r * math.cos(lat) * math.sin(lon), r * math.sin(lat)]


GS_ECEF = np.array([_ecef(s) for s in STATIONS], dtype=np.float64).reshape(-1, 3)
GS_SIN_MIN_EL = np.array([math.sin(math.radians(s.min_elevation_deg)) for s in STATIONS], dtype=np.float64)


def gmst_rad(ts: float) -> float:
    """Greenwich mean sidereal angle for a POSIX timestamp."""
    d = ts / 86400.0 + 2440587.5 - 2451545.0
    return ((18.697374558 + 24.06570982441908 * d) % 24) * 15.0 * math.pi / 180.0


def stations_eci(ts: float) -> np.ndarray:
    theta = gmst_rad(ts)
    c, s = math.cos(theta), math.sin(theta)
    rot = np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])
    return GS_ECEF @ rot.T


def sin_elevations(r_eci: np.ndarray, ts: float) -> np.ndarray:
    """sin(elevation) of each satellite (N,3) as seen from each station -> (N, G)."""
    r = np.asarray(r_eci, dtype=np.float64).reshape(-1, 3)
    if GS_ECEF.size == 0:
        return np.empty((len(r), 0))
    gs = stations_eci(ts)                                   # (G,3)
    rng = r[:, None, :] - gs[None, :, :]                    # (N,G,3)
    up = gs / np.linalg.norm(gs, axis=1)[:, None]           # (G,3)
    return np.einsum("ngk,gk->ng", rng, up) / np.linalg.norm(rng, axis=2)


def elevations_deg(r_eci: np.ndarray, ts: float) -> np.ndarray:
    return np.degrees(np.arcsin(np.clip(sin_elevations(r_eci, ts), -1.0, 1.0)))


def visible_mask(r_eci: np.ndarray, ts: float) -> np.ndarray:
    """(N, G) boolean: station g sees satellite n above its minimum elevation."""
    return sin_elevations(r_eci, ts) >= GS_SIN_MIN_EL[None, :]


def los_mask(r_eci: np.ndarray, ts: float) -> np.ndarray:
    """(N,) boolean: satellite has line of sight to at least one station."""
    if GS_ECEF.size == 0:
        return np.ones(len(np.asarray(r_eci).reshape(-1, 3)), dtype=bool)
    return visible_mask(r_eci, ts).any(axis=1)


def has_los(r_eci: np.ndarray, ts: float) -> bool:
    return bool(los_mask(np.asarray(r_eci).reshape(1, 3), ts)[0])


def brain_stations() -> List[dict]:
    """Station dicts in the format AutonomousBrain.check_line_of_sight expects."""
    return [{
        "id": s.id, "name": s.name, "latitude": s.latitude, "longitude": s.longitude,
        "elevation_m": s.elevation_m, "min_elevation_angle_deg": s.min_elevation_deg,
    } for s in STATIONS]
