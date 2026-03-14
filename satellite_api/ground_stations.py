import csv
import math
from datetime import datetime
from typing import List, Tuple

# Earth constants
R_EARTH = 6378.137  # km
OMEGA_EARTH = 7.292115e-5  # rad/s (Earth rotation rate)

class GroundStation:
    def __init__(self, station_id, name, lat_deg, lon_deg, alt_m, min_elev_deg):
        self.id = station_id
        self.name = name
        self.lat = math.radians(lat_deg)
        self.lon = math.radians(lon_deg)
        self.alt = alt_m / 1000.0  # convert to km
        self.min_elev = math.radians(min_elev_deg)

def load_ground_stations(csv_path: str) -> List[GroundStation]:
    stations = []
    with open(csv_path, 'r') as f:
        reader = csv.DictReader(f)
        for row in reader:
            stations.append(GroundStation(
                station_id=row['Station_ID'],
                name=row['Station_Name'],
                lat_deg=float(row['Latitude']),
                lon_deg=float(row['Longitude']),
                alt_m=float(row['Elevation_m']),
                min_elev_deg=float(row['Min Elevation_Angle_deg'])
            ))
    return stations

def gmst_at_utc(dt: datetime) -> float:
    y = dt.year
    m = dt.month
    d = dt.day + (dt.hour + dt.minute/60.0 + dt.second/3600.0) / 24.0
    if m <= 2:
        y -= 1
        m += 12
    A = int(y/100)
    B = 2 - A + int(A/4)
    JD = int(365.25*(y+4716)) + int(30.6001*(m+1)) + d + B - 1524.5
    T = (JD - 2451545.0) / 36525.0
    GMST_sec = 24110.54841 + 8640184.812866 * T + 0.093104 * T**2 - 6.2e-6 * T**3
    GMST_rad = (GMST_sec % 86400) * 2 * math.pi / 86400.0
    return GMST_rad

def geodetic_to_eci(lat_rad: float, lon_rad: float, alt_km: float, gmst_rad: float) -> Tuple[float, float, float]:
    r = (R_EARTH + alt_km) * math.cos(lat_rad)
    x = r * math.cos(lon_rad + gmst_rad)
    y = r * math.sin(lon_rad + gmst_rad)
    z = (R_EARTH + alt_km) * math.sin(lat_rad)
    return (x, y, z)

def eci_to_geodetic(x: float, y: float, z: float, gmst_rad: float) -> Tuple[float, float, float]:
    x_ef = x * math.cos(gmst_rad) + y * math.sin(gmst_rad)
    y_ef = -x * math.sin(gmst_rad) + y * math.cos(gmst_rad)
    z_ef = z
    lon = math.atan2(y_ef, x_ef)
    p = math.sqrt(x_ef**2 + y_ef**2)
    if p < 1e-10:
        lat = math.copysign(math.pi/2, z_ef)
    else:
        lat = math.atan2(z_ef, p)
    alt = math.sqrt(x_ef**2 + y_ef**2 + z_ef**2) - R_EARTH
    return lat, lon, alt

def elevation_angle(sat_eci: Tuple[float,float,float], station_eci: Tuple[float,float,float]) -> float:
    dx = sat_eci[0] - station_eci[0]
    dy = sat_eci[1] - station_eci[1]
    dz = sat_eci[2] - station_eci[2]
    r = math.sqrt(dx*dx + dy*dy + dz*dz)
    up_x = station_eci[0]
    up_y = station_eci[1]
    up_z = station_eci[2]
    up_norm = math.sqrt(up_x*up_x + up_y*up_y + up_z*up_z)
    if up_norm < 1e-10:
        return 0
    cos_zenith = (dx*up_x + dy*up_y + dz*up_z) / (r * up_norm)
    cos_zenith = max(-1.0, min(1.0, cos_zenith))
    zenith = math.acos(cos_zenith)
    elev = math.pi/2 - zenith
    return elev
