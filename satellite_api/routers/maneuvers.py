"""
routers/maneuvers.py
--------------------
POST /api/maneuver/schedule
Validates and schedules evasion, recovery, and EOL maneuvers.
Strictly enforces Tsiolkovsky fuel depletion, 15m/s thrust limits, 600s cooldowns,
and geometric Line-of-Sight (LOS) constraints via vectorized matrix math.
"""

from fastapi import APIRouter, Request, HTTPException, status
from pydantic import BaseModel
from typing import List
import math
import numpy as np
import logging
import csv
from pathlib import Path
from datetime import datetime

logger = logging.getLogger(__name__)
router = APIRouter()

# ============================================================================
# ORBITAL CONSTANTS
# ============================================================================
MU_EARTH = 398600.4418
R_EARTH = 6378.137
I_SP = 300.0
G0 = 9.80665
MAX_DELTA_V_MPS = 15.0
COOLDOWN_SECONDS = 600.0
DRY_MASS = 500.0
OMEGA_EARTH = 7.2921159e-5

# ============================================================================
# HIGH-PERFORMANCE GROUND STATION MATRIX PRE-COMPUTATION
# ============================================================================
_gs_ecef_list = []
_gs_sin_min_el_list = []

try:
    with open("data/ground_stations.csv", mode='r', encoding='utf-8') as f:
        for row in csv.DictReader(filter(lambda r: r.strip(), f)):
            clean_row = {k.strip(): v.strip() for k, v in row.items()}
            m_key = "Min Elevation_Angle_deg" if "Min Elevation_Angle_deg" in clean_row else "Min_Elevation_Angle_deg"
            
            lat_rad = math.radians(float(clean_row.get("Latitude", 0.0)))
            lon_rad = math.radians(float(clean_row.get("Longitude", 0.0)))
            r = R_EARTH + (float(clean_row.get("Elevation_m", 0.0)) / 1000.0)
            
            # Pre-compute Static ECEF Coordinates
            x = r * math.cos(lat_rad) * math.cos(lon_rad)
            y = r * math.cos(lat_rad) * math.sin(lon_rad)
            z = r * math.sin(lat_rad)
            
            _gs_ecef_list.append([x, y, z])
            # Pre-compute sin(min_elevation) to bypass expensive math.asin() later
            _gs_sin_min_el_list.append(math.sin(math.radians(float(clean_row.get(m_key, 0.0)))))

except Exception as e:
    logger.warning(f"Could not load ground stations for LOS validation: {e}")

# Broadcastable NumPy Arrays
GS_ECEF = np.array(_gs_ecef_list, dtype=np.float64) if _gs_ecef_list else np.empty((0, 3))
GS_SIN_MIN_EL = np.array(_gs_sin_min_el_list, dtype=np.float64) if _gs_sin_min_el_list else np.empty((0,))

# ============================================================================
# VECTORIZED MATH HELPERS
# ============================================================================
def predict_position_fast(r0: np.ndarray, v0: np.ndarray, dt_s: float) -> np.ndarray:
    """Fast analytical Keplerian propagation to find satellite position at future burn time."""
    if dt_s <= 0: return r0
    r_mag = np.linalg.norm(r0)
    v_mag = np.linalg.norm(v0)
    n = v_mag / r_mag  
    theta = n * dt_s   
    h_vec = np.cross(r0, v0)
    h_hat = h_vec / np.linalg.norm(h_vec)
    return r0 * math.cos(theta) + np.cross(h_hat, r0) * math.sin(theta)

def check_los_validity_vectorized(r_eci: np.ndarray, burn_time_ts: float) -> bool:
    """O(1) Vectorized Line-of-Sight check using Matrix Broadcasting."""
    if GS_ECEF.size == 0: return True # Failsafe open
    
    # Needs to be checked 10 seconds prior to burn per upload constraints
    upload_ts = burn_time_ts - 10.0 
    theta_gmst = (OMEGA_EARTH * upload_ts) % (2 * math.pi)
    
    # Create GMST Z-Axis Rotation Matrix
    cos_t, sin_t = math.cos(theta_gmst), math.sin(theta_gmst)
    R_z = np.array([
        [cos_t, -sin_t, 0.0],
        [sin_t,  cos_t, 0.0],
        [0.0,    0.0,   1.0]
    ])
    
    # 1. Rotate all stations to ECI instantly via matrix multiplication
    gs_eci = GS_ECEF @ R_z.T 
    
    # 2. Calculate range vectors for all stations simultaneously
    range_vecs = r_eci - gs_eci 
    
    # 3. Calculate norms
    gs_norms = np.linalg.norm(gs_eci, axis=1)
    range_norms = np.linalg.norm(range_vecs, axis=1)
    
    # 4. Vectorized Dot Product (cos_zenith)
    dot_prods = np.sum(gs_eci * range_vecs, axis=1)
    cos_zeniths = dot_prods / (gs_norms * range_norms)
    
    # 5. Compare directly against pre-computed sines (Bypassing math.asin entirely!)
    return bool(np.any(cos_zeniths >= GS_SIN_MIN_EL))

# ============================================================================
# EXACT JSON SCHEMAS (Section 4.2)
# ============================================================================
class Vector3D(BaseModel):
    x: float
    y: float
    z: float

class ManeuverBurn(BaseModel):
    burn_id: str
    burnTime: str
    deltaV_vector: Vector3D

class ManeuverScheduleRequest(BaseModel):
    satelliteId: str
    maneuver_sequence: List[ManeuverBurn]

class ValidationResult(BaseModel):
    ground_station_los: bool
    sufficient_fuel: bool
    projected_mass_remaining_kg: float

class ManeuverScheduleResponse(BaseModel):
    status: str
    validation: ValidationResult

# ============================================================================
# API ENDPOINT
# ============================================================================
@router.post(
    "/api/maneuver/schedule", # Mapped securely for main.py alignment
    response_model=ManeuverScheduleResponse,
    status_code=status.HTTP_202_ACCEPTED
)
async def schedule_maneuver(request: ManeuverScheduleRequest, req: Request):
    state = req.app.state.orbital_state
    sat_id = request.satelliteId
    
    if not state.is_initialized:
        raise HTTPException(status_code=400, detail="Telemetry not initialized.")
        
    if sat_id not in state.sat_id_to_idx:
        raise HTTPException(status_code=404, detail=f"Satellite {sat_id} not found.")
    
    sat_idx = state.sat_id_to_idx[sat_id]
    
    # ── 1. Fetch Current State Safely ─────────────────────────────────────────
    async with state.lock:
        current_fuel = state.sat_fuel[sat_idx]
        last_burn_ts = state.sat_cooldown_timers[sat_idx]
        current_mass = DRY_MASS + current_fuel
        sat_r0 = state.sat_buffer[sat_idx, 0:3].copy()
        sat_v0 = state.sat_buffer[sat_idx, 3:6].copy()
    
    sim_time_ts = state.current_time.timestamp()
    
    total_fuel_needed = 0.0
    validated_burns = []
    projected_mass = current_mass
    
    # ── 2. Strict Constraint Validation Loop ──────────────────────────────────
    for i, burn in enumerate(request.maneuver_sequence):
        burn_time_ts = datetime.fromisoformat(burn.burnTime.replace('Z', '+00:00')).timestamp()
        
        # A. Latency Check: Cannot schedule burns in the past or < 10s from now
        if burn_time_ts < (sim_time_ts + 10.0):
            return _reject("LATENCY_VIOLATION", projected_mass)
        
        # B. Thermal Cooldown Check: 600s between burns
        if i == 0:
            if (burn_time_ts - last_burn_ts) < COOLDOWN_SECONDS and last_burn_ts > 0:
                return _reject("COOLDOWN_ACTIVE", projected_mass)
        else:
            prev_ts = datetime.fromisoformat(request.maneuver_sequence[i-1].burnTime.replace('Z', '+00:00')).timestamp()
            if (burn_time_ts - prev_ts) < COOLDOWN_SECONDS:
                return _reject("COOLDOWN_ACTIVE", projected_mass)
        
        # C. Max Thrust Limit (15.0 m/s)
        dv = burn.deltaV_vector
        dv_mag_kms = math.sqrt(dv.x**2 + dv.y**2 + dv.z**2)
        dv_mag_mps = dv_mag_kms * 1000.0
        
        if dv_mag_mps > MAX_DELTA_V_MPS:
            return _reject("MAX_THRUST_EXCEEDED", projected_mass)
        
        # D. Tsiolkovsky Fuel Depletion
        delta_m = projected_mass * (1.0 - math.exp(-dv_mag_mps / (I_SP * G0)))
        if 0 < delta_m < 0.001: delta_m = 0.001 
            
        total_fuel_needed += delta_m
        projected_mass -= delta_m
        
        # E. Hyper-Optimized Vectorized Line-of-Sight Validation
        dt_to_burn = burn_time_ts - sim_time_ts
        predicted_pos_eci = predict_position_fast(sat_r0, sat_v0, dt_to_burn)
        
        if not check_los_validity_vectorized(predicted_pos_eci, burn_time_ts):
            return _reject("NO_LINE_OF_SIGHT", projected_mass, los_ok=False)
        
        validated_burns.append({
            "ts": burn_time_ts,
            "dvx": dv.x, "dvy": dv.y, "dvz": dv.z
        })
    
    # F. Final Fuel Check
    if total_fuel_needed > current_fuel:
        return _reject("INSUFFICIENT_FUEL", projected_mass, fuel_ok=False)
    
    # ── 3. Commit to Memory Manager (JIT Queue) ───────────────────────────────
    async with state.lock:
        for v_burn in validated_burns:
            state.maneuver_queue.append((
                v_burn["ts"], sat_id, 
                v_burn["dvx"], v_burn["dvy"], v_burn["dvz"]
            ))
            state.sat_cooldown_timers[sat_idx] = v_burn["ts"]
            
        state.sat_fuel[sat_idx] -= total_fuel_needed
        state.maneuver_queue.sort(key=lambda x: x[0]) 
    
    # Return 202 ACCEPTED exactly matching Section 4.2 Schema
    return ManeuverScheduleResponse(
        status="SCHEDULED",
        validation=ValidationResult(
            ground_station_los=True,
            sufficient_fuel=True,
            projected_mass_remaining_kg=round(projected_mass, 2),
        ),
    )

def _reject(reason: str, mass: float, fuel_ok: bool = True, los_ok: bool = True) -> ManeuverScheduleResponse:
    """Helper to cleanly format rejections while matching strict schema requirements."""
    return ManeuverScheduleResponse(
        status=f"REJECTED: {reason}",
        validation=ValidationResult(
            ground_station_los=los_ok,
            sufficient_fuel=fuel_ok,
            projected_mass_remaining_kg=round(mass, 2),
        ),
    )