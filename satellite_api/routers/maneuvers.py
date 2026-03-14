import numpy as np
import math
from datetime import datetime, timedelta
from fastapi import APIRouter, Request, HTTPException, status
import logging
from pathlib import Path

from satellite_api.models import ManeuverScheduleRequest, ManeuverScheduleResponse, ValidationResult
from satellite_api.ground_stations import load_ground_stations

logger = logging.getLogger(__name__)
router = APIRouter()

# --- Orbital Constants for Prediction ---
MU_EARTH = 398600.4418
R_EARTH = 6378.137
I_SP = 300.0
G0 = 9.80665
MAX_DELTA_V_MPS = 15.0
COOLDOWN_SECONDS = 600.0
SIGNAL_LATENCY_SECONDS = 10.0

# --- Global Ground Station Cache ---
_ground_stations = None
def get_ground_stations():
    global _ground_stations
    if _ground_stations is None:
        csv_path = Path("data/ground_stations.csv")
        if csv_path.exists():
            _ground_stations = load_ground_stations(str(csv_path))
        else:
            logger.warning("Ground stations CSV not found. LOS validation will pass by default.")
            _ground_stations = []
    return _ground_stations

def predict_position_fast(state_vector: np.ndarray, dt_seconds: float) -> np.ndarray:
    """Lightweight Euler-Cromer step for rapid Line-of-Sight prediction."""
    if dt_seconds <= 0:
        return state_vector[:3]
    x, y, z = state_vector[0], state_vector[1], state_vector[2]
    vx, vy, vz = state_vector[3], state_vector[4], state_vector[5]
    r = math.sqrt(x*x + y*y + z*z)
    if r < 1e-10: return state_vector[:3]
    a_two_body = -MU_EARTH / (r**3)
    ax, ay, az = x * a_two_body, y * a_two_body, z * a_two_body
    new_vx = vx + ax * dt_seconds
    new_vy = vy + ay * dt_seconds
    new_vz = vz + az * dt_seconds
    new_x = x + new_vx * dt_seconds
    new_y = y + new_vy * dt_seconds
    new_z = z + new_vz * dt_seconds
    return np.array([new_x, new_y, new_z])

@router.post(
    "/maneuver/schedule",
    response_model=ManeuverScheduleResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Schedule an evasion maneuver sequence"
)
async def schedule_maneuver(request: ManeuverScheduleRequest, req: Request):
    state = req.app.state.orbital_state
    sat_id = request.satelliteId

    # --- 1. Bridge the ID to the NumPy Index ---
    if sat_id not in state.sat_id_to_idx:
        raise HTTPException(status_code=404, detail=f"Satellite {sat_id} not found in telemetry.")
    sat_idx = state.sat_id_to_idx[sat_id]
    
    current_time_dt = state.current_time
    if current_time_dt is None:
        raise HTTPException(status_code=400, detail="Simulation time not initialized.")
    
    current_time_ts = current_time_dt.timestamp()

    # --- 2. Extract Data from NumPy Buffers ---
    async with state.lock:
        sat_kinematics = state.sat_buffer[sat_idx].copy()
        initial_fuel = state.sat_fuel[sat_idx]
        last_burn_ts = state.sat_cooldown_timers[sat_idx]
        initial_mass = state.sat_initial_mass[sat_idx]
        current_mass = initial_mass - (50.0 - initial_fuel)

    # --- 3. Validate Maneuver Sequence ---
    total_fuel_needed = 0.0
    stations = get_ground_stations()

    for i, burn in enumerate(request.maneuver_sequence):
        burn_time_ts = burn.burnTime.timestamp()

        # CRITICAL: Check 10s Signal Latency (Section 5.4)
        if burn_time_ts < (current_time_ts + SIGNAL_LATENCY_SECONDS):
            return _reject("LATENCY_VIOLATION")

        # Check: Cooldown (600s)
        if i == 0 and (burn_time_ts - last_burn_ts) < COOLDOWN_SECONDS:
            return _reject("COOLDOWN_ACTIVE")
        elif i > 0:
            prev_burn_ts = request.maneuver_sequence[i-1].burnTime.timestamp()
            if (burn_time_ts - prev_burn_ts) < COOLDOWN_SECONDS:
                return _reject("COOLDOWN_ACTIVE")

        # Check: Thrust Limit & Fuel Math
        dv_x, dv_y, dv_z = burn.deltaV_vector.x, burn.deltaV_vector.y, burn.deltaV_vector.z
        dv_kms = math.sqrt(dv_x**2 + dv_y**2 + dv_z**2)
        dv_mps = dv_kms * 1000.0
        
        if dv_mps > MAX_DELTA_V_MPS:
            return _reject("MAX_THRUST_EXCEEDED")

        # Tsiolkovsky Equation
        delta_m = current_mass * (1 - math.exp(-dv_mps / (I_SP * G0)))
        total_fuel_needed += delta_m
        current_mass -= delta_m

        # Check: Line-of-Sight (LOS) Validation
        dt_to_burn = burn_time_ts - current_time_ts
        predicted_pos_eci = predict_position_fast(sat_kinematics, dt_to_burn)
        pos_array = predicted_pos_eci.reshape(1, 3)
        
        los_valid = False
        if not stations:
            los_valid = True
        else:
            for station in stations:
                vis_mask = station.check_visibility_vectorized(pos_array, burn.burnTime)
                if vis_mask[0]:
                    los_valid = True
                    break
        
        if not los_valid:
            return _reject("NO_LINE_OF_SIGHT")

    # --- 4. Final Fuel Check ---
    if total_fuel_needed > initial_fuel:
        return _reject("INSUFFICIENT_FUEL")

    # --- 5. Queue the Maneuvers in State (String-Locked) ---
    async with state.lock:
        for burn in request.maneuver_sequence:
            state.maneuver_queue.append((
                burn.burnTime.timestamp(),
                sat_id,  # CRITICAL: Use String ID, not index
                burn.deltaV_vector.x,
                burn.deltaV_vector.y,
                burn.deltaV_vector.z
            ))
        # Keep queue chronologically sorted
        state.maneuver_queue.sort(key=lambda x: x[0])
        
        # CRITICAL: Deduct fuel ONCE and set cooldown to the LAST burn
        state.sat_fuel[sat_idx] -= total_fuel_needed
        state.sat_cooldown_timers[sat_idx] = request.maneuver_sequence[-1].burnTime.timestamp()

    return ManeuverScheduleResponse(
        status="SCHEDULED",
        validation=ValidationResult(
            ground_station_los=True,
            sufficient_fuel=True,
            projected_mass_remaining_kg=round(current_mass, 2),
        ),
    )

def _reject(reason: str):
    return ManeuverScheduleResponse(
        status=f"REJECTED: {reason}",
        validation=ValidationResult(
            ground_station_los=False if "SIGHT" in reason else True,
            sufficient_fuel=False if "FUEL" in reason else True,
            projected_mass_remaining_kg=0.0,
        ),
    )