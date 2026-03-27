"""
routers/maneuvers.py
--------------------
POST /api/maneuver/schedule
Validates and schedules evasion, recovery, and EOL maneuvers.
Strictly enforces Tsiolkovsky fuel depletion, 15m/s thrust limits, 600s cooldowns,
and Sequence-Level Line-of-Sight (LOS) constraints.
"""

from fastapi import APIRouter, Request, HTTPException, status
from typing import List
import math
import numpy as np
import logging
import csv
import datetime

# 🚀 CRITICAL FIX: Import strict schemas directly from models.py
from satellite_api.models import ManeuverScheduleRequest, ManeuverScheduleResponse, ValidationResult

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
            
            x = r * math.cos(lat_rad) * math.cos(lon_rad)
            y = r * math.cos(lat_rad) * math.sin(lon_rad)
            z = r * math.sin(lat_rad)
            
            _gs_ecef_list.append([x, y, z])
            _gs_sin_min_el_list.append(math.sin(math.radians(float(clean_row.get(m_key, 0.0)))))
except Exception as e:
    logger.warning(f"Could not load ground stations for LOS validation: {e}")

GS_ECEF = np.array(_gs_ecef_list, dtype=np.float64) if _gs_ecef_list else np.empty((0, 3))
GS_SIN_MIN_EL = np.array(_gs_sin_min_el_list, dtype=np.float64) if _gs_sin_min_el_list else np.empty((0,))

# ============================================================================
# VECTORIZED MATH HELPERS
# ============================================================================
def _calculate_gmst(ts: float) -> float:
    jd = ts / 86400.0 + 2440587.5
    d = jd - 2451545.0
    gmst_hours = 18.697374558 + 24.06570982441908 * d
    return (gmst_hours % 24) * 15.0 * math.pi / 180.0

def check_los_validity_vectorized(r_eci: np.ndarray, current_ts: float) -> bool:
    if GS_ECEF.size == 0: return True 
    
    theta_gmst = _calculate_gmst(current_ts)
    cos_t, sin_t = math.cos(theta_gmst), math.sin(theta_gmst)
    R_z = np.array([
        [cos_t, -sin_t, 0.0],
        [sin_t,  cos_t, 0.0],
        [0.0,    0.0,   1.0]
    ])
    
    gs_eci = GS_ECEF @ R_z.T 
    range_vecs = r_eci - gs_eci 
    
    gs_norms = np.linalg.norm(gs_eci, axis=1)
    range_norms = np.linalg.norm(range_vecs, axis=1)
    
    dot_prods = np.sum(gs_eci * range_vecs, axis=1)
    cos_zeniths = dot_prods / (gs_norms * range_norms)
    
    return bool(np.any(cos_zeniths >= GS_SIN_MIN_EL))

# ============================================================================
# API ENDPOINT
# ============================================================================
@router.post(
    "/api/maneuver/schedule", 
    response_model=ManeuverScheduleResponse,
    status_code=status.HTTP_202_ACCEPTED
)
async def schedule_maneuver(request: ManeuverScheduleRequest, req: Request):
    state = req.app.state.orbital_state
    sat_id = request.satelliteId
    
    if not state.is_ready():
        raise HTTPException(status_code=400, detail="Telemetry not initialized.")
        
    if sat_id not in state.sat_id_to_idx:
        raise HTTPException(status_code=404, detail=f"Satellite {sat_id} not found.")
    
    sat_idx = state.sat_id_to_idx[sat_id]
    
    async with state.lock:
        current_fuel = state.sat_fuel[sat_idx]
        sim_time_ts = state.current_time.timestamp()
        
        next_available_ts = sim_time_ts + state.sat_cooldown_timers[sat_idx]
        reserved_fuel = 0.0
        
        for maneuver in state.maneuver_queue:
            q_ts, q_sat, q_dvx, q_dvy, q_dvz = maneuver
            if q_sat == sat_id:
                dv_mag_mps = math.sqrt(q_dvx**2 + q_dvy**2 + q_dvz**2) * 1000.0
                q_mass = DRY_MASS + current_fuel - reserved_fuel
                reserved_fuel += q_mass * (1.0 - math.exp(-dv_mag_mps / (I_SP * G0)))
                next_available_ts = max(next_available_ts, q_ts + COOLDOWN_SECONDS)

        available_fuel = current_fuel - reserved_fuel
        projected_mass = DRY_MASS + available_fuel
        
        sat_r0 = state.sat_buffer[sat_idx, 0:3].copy()
    
    # 🚀 THE FIX: Sequence-Level LOS Verification
    # We check if we have a signal RIGHT NOW to upload the sequence into the satellite buffer.
    if not check_los_validity_vectorized(sat_r0, sim_time_ts):
        return _reject("NO_LINE_OF_SIGHT", projected_mass, los_ok=False)
    
    total_fuel_needed = 0.0
    validated_burns = []
    
    # ── Strict Constraint Validation Loop ──
    for burn in request.maneuver_sequence:
        burn_dt = datetime.datetime.fromisoformat(burn.burnTime.replace('Z', '+00:00'))
        burn_time_ts = burn_dt.timestamp()
        
        # A. Latency Check
        if burn_time_ts < (sim_time_ts + 10.0):
            return _reject("LATENCY_VIOLATION", projected_mass)
        
        # B. Thermal Cooldown Check
        if burn_time_ts < next_available_ts:
            return _reject("COOLDOWN_ACTIVE", projected_mass)
        
        next_available_ts = burn_time_ts + COOLDOWN_SECONDS
        
        # C. Max Thrust Limit
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
        
        validated_burns.append({
            "ts": burn_time_ts,
            "dvx": dv.x, "dvy": dv.y, "dvz": dv.z
        })
    
    if total_fuel_needed > available_fuel:
        return _reject("INSUFFICIENT_FUEL", projected_mass, fuel_ok=False)
    
    async with state.lock:
        for v_burn in validated_burns:
            state.maneuver_queue.append((
                v_burn["ts"], sat_id, 
                v_burn["dvx"], v_burn["dvy"], v_burn["dvz"]
            ))
        
    return ManeuverScheduleResponse(
        status="SCHEDULED",
        validation=ValidationResult(
            ground_station_los=True,
            sufficient_fuel=True,
            projected_mass_remaining_kg=round(projected_mass, 2),
        ),
    )

def _reject(reason: str, mass: float, fuel_ok: bool = True, los_ok: bool = True) -> ManeuverScheduleResponse:
    return ManeuverScheduleResponse(
        status=f"REJECTED: {reason}",
        validation=ValidationResult(
            ground_station_los=los_ok,
            sufficient_fuel=fuel_ok,
            projected_mass_remaining_kg=round(mass, 2),
        ),
    )