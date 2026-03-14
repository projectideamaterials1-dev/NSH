import numpy as np
from datetime import datetime

def datetime_to_julian(dt: datetime) -> float:
    return dt.toordinal() + 1721425.5 + (
        dt.hour + dt.minute / 60.0 + dt.second / 3600.0
    ) / 24.0

def compute_gmst(julian_date: float) -> float:
    T = (julian_date - 2451545.0) / 36525.0
    gmst_degrees = 280.46061837 + 360.98564736629 * (julian_date - 2451545.0) + 0.000387933 * T**2
    return np.radians(gmst_degrees % 360)

def convert_states_to_lla(states: np.ndarray, current_time: datetime) -> list:
    """Vectorized conversion from ECI to LLA for thousands of objects."""
    if len(states) == 0:
        return []
    
    jd = datetime_to_julian(current_time)
    gmst = compute_gmst(jd)
    
    # 1. Vectorized ECI to ECEF
    cos_gmst = np.cos(gmst)
    sin_gmst = np.sin(gmst)
    
    x_eci = states[:, 0]
    y_eci = states[:, 1]
    z_eci = states[:, 2]
    
    x = x_eci * cos_gmst + y_eci * sin_gmst
    y = -x_eci * sin_gmst + y_eci * cos_gmst
    z = z_eci
    
    # 2. Vectorized ECEF to LLA (Numerically Stable)
    R_EARTH = 6378.137  # EXACT match with physics_rk4.cpp
    f = 1 / 298.257223563
    e2 = 2 * f - f * f
    
    p = np.sqrt(x * x + y * y)
    lon = np.arctan2(y, x)
    
    # Stable initial guess
    lat = np.arctan2(z, p * (1 - e2))
    
    # 5 iterations is highly accurate for Earth's flattening
    for _ in range(5):
        N = R_EARTH / np.sqrt(1 - e2 * np.sin(lat)**2)
        # CRITICAL FIX: Numerically stable update (No division by cos(lat))
        lat = np.arctan2(z + e2 * N * np.sin(lat), p)
        
    N = R_EARTH / np.sqrt(1 - e2 * np.sin(lat)**2)
    
    # CRITICAL FIX: Polar Singularity Guard for Altitude
    cos_lat = np.cos(lat)
    sin_lat = np.sin(lat)
    
    # Compute both pathways
    alt_equatorial = (p / cos_lat) - N
    # Avoid dividing by 0 at the poles by using the Z axis instead
    alt_polar = (z / sin_lat) - N * (1 - e2)
    
    # If cos(lat) is close to 0 (poles), use the polar formula. Otherwise, use standard.
    h = np.where(np.abs(cos_lat) > 1e-4, alt_equatorial, alt_polar)
    
    # 3. Stack results and convert to list
    ids = np.arange(len(states))
    lat_deg = np.degrees(lat)
    lon_deg = np.degrees(lon)
    
    # Creates an (N, 4) array and converts to Python list for ORJSON
    return np.column_stack((ids, lat_deg, lon_deg, h)).tolist()