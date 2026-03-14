import csv
import numpy as np
from typing import List, Tuple
from datetime import datetime

# CRITICAL FIX: Relative import for package structure
from satellite_api.coordinates import compute_gmst, datetime_to_julian

# WGS84 Constants (Synced with coordinates.py & physics_rk4.cpp)
A_EARTH = 6378.137          # Semi-major axis (km)
F_WGS84 = 1 / 298.257223563 # Flattening
E2 = 2 * F_WGS84 - F_WGS84**2

class GroundStation:
    def __init__(self, station_id: str, name: str, lat_deg: float, lon_deg: float, alt_m: float, min_elev_deg: float):
        self.id = station_id
        self.name = name
        self.lat_rad = np.radians(lat_deg)
        self.lon_rad = np.radians(lon_deg)
        self.alt_km = alt_m / 1000.0
        self.min_elev_rad = np.radians(min_elev_deg)

        # 1. Pre-compute accurate WGS84 ECEF Position
        sin_lat = np.sin(self.lat_rad)
        cos_lat = np.cos(self.lat_rad)
        sin_lon = np.sin(self.lon_rad)
        cos_lon = np.cos(self.lon_rad)
        
        # Prime Vertical Radius of Curvature
        N = A_EARTH / np.sqrt(1 - E2 * sin_lat**2)
        
        self.ecef_x = (N + self.alt_km) * cos_lat * cos_lon
        self.ecef_y = (N + self.alt_km) * cos_lat * sin_lon
        self.ecef_z = (N * (1 - E2) + self.alt_km) * sin_lat
        
        self.pos_ecef = np.array([self.ecef_x, self.ecef_y, self.ecef_z])

        # 2. Pre-compute Geodetic Normal Vector ("Up" direction) in ECEF
        self.normal_ecef = np.array([
            cos_lat * cos_lon,
            cos_lat * sin_lon,
            sin_lat
        ])

    def check_visibility_vectorized(self, sats_eci: np.ndarray, current_time: datetime) -> np.ndarray:
        if len(sats_eci) == 0:
            return np.array([], dtype=bool)

        # 1. Get GMST for the current time
        jd = datetime_to_julian(current_time)
        gmst = compute_gmst(jd)

        # 2. Convert all Satellite ECI positions to ECEF natively
        cos_g = np.cos(gmst)
        sin_g = np.sin(gmst)
        
        x_eci = sats_eci[:, 0]
        y_eci = sats_eci[:, 1]
        z_eci = sats_eci[:, 2]
        
        sat_x_ecef = x_eci * cos_g + y_eci * sin_g
        sat_y_ecef = -x_eci * sin_g + y_eci * cos_g
        sat_z_ecef = z_eci
        
        sats_ecef = np.column_stack((sat_x_ecef, sat_y_ecef, sat_z_ecef))

        # 3. Calculate Slant Range Vector (Satellite - Station)
        range_vectors = sats_ecef - self.pos_ecef
        
        # 4. Calculate distances
        distances = np.linalg.norm(range_vectors, axis=1)
        
        # 5. Dot product of range vectors with the station's normal vector
        dot_products = np.dot(range_vectors, self.normal_ecef)
        
        # Protect against division by zero 
        safe_distances = np.where(distances < 1e-10, 1e-10, distances)
        sin_elevation = dot_products / safe_distances
        
        # Clip to valid domain [-1, 1] for arcsin
        sin_elevation = np.clip(sin_elevation, -1.0, 1.0)
        elevations_rad = np.arcsin(sin_elevation)

        # 6. Return boolean mask of satellites above the minimum elevation angle
        return elevations_rad >= self.min_elev_rad

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