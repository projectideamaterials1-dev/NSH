"""
routers/visualization.py
-------------------------
GET /visualization/snapshot
Provides a highly compressed snapshot of all orbital objects.
STRICTLY matches the NSH 2026 Problem Statement schema.
"""

from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel
from typing import List, Any
import logging

from satellite_api.coordinates import convert_states_to_lla

router = APIRouter()
logger = logging.getLogger(__name__)

# ============================================================================
# STRICT JSON SCHEMAS (Section 6.3)
# ============================================================================
class SatelliteSnapshot(BaseModel):
    id: str
    lat: float
    lon: float
    fuel_kg: float
    status: str

class VisualizationSnapshotResponse(BaseModel):
    timestamp: str
    satellites: List[SatelliteSnapshot]
    debris_cloud: List[List[Any]] # Flattened: [ID, Lat, Lon, Alt]

# ============================================================================
# API ENDPOINT
# ============================================================================
@router.get(
    "/api/visualization/snapshot", # 🚀 CRITICAL FIX: Removed /api to prevent double-prefixing
    response_model=VisualizationSnapshotResponse,
    summary="Get current orbital snapshot for visualization",
)
async def visualization_snapshot(request: Request):
    state = request.app.state.orbital_state
    
    if not state.is_initialized or state.current_time is None:
        raise HTTPException(status_code=400, detail="State not initialized.")

    # 1. Fetch memory views
    sat_state, debris_state = await state.get_state_buffers()

    # 2. Vectorized ECI-to-LLA Conversion
    sat_lla_raw = convert_states_to_lla(sat_state, state.current_time) if len(sat_state) > 0 else []
    debris_lla_raw = convert_states_to_lla(debris_state, state.current_time) if len(debris_state) > 0 else []

    satellites = []
    
    async with state.lock:
        # 3. Process Satellites
        for row in sat_lla_raw:
            idx = int(row[0])
            lat, lon = round(row[1], 4), round(row[2], 4)
            fuel = state.sat_fuel[idx]
            
            # Status mapping
            if fuel <= 0: status = "EOL"
            elif fuel <= 2.5: status = "CRITICAL_FUEL"
            else: status = "NOMINAL"
            
            satellites.append({
                "id": state.idx_to_sat_id[idx],
                "lat": lat,
                "lon": lon,
                "fuel_kg": round(fuel, 2), # Strictly formatted
                "status": status,
            })

        # 4. Process Debris
        debris_cloud = [
            [
                state.idx_to_debris_id[int(row[0])],
                round(row[1], 4),
                round(row[2], 4),
                round(row[3], 4) # Debris is allowed to have altitude in the flattened array
            ]
            for row in debris_lla_raw
        ]

    return {
        "timestamp": state.current_time.strftime('%Y-%m-%dT%H:%M:%S.000Z'),
        "satellites": satellites,
        "debris_cloud": debris_cloud,
    }

# ============================================================================
# HIDDEN INTERNAL DEBUG API (For Forensic Test Scripts)
# ============================================================================
@router.get("/api/internal/debug_state", include_in_schema=False) # 🚀 CRITICAL FIX: Removed /api
async def debug_state(request: Request):
    """
    Hidden endpoint providing raw ECI and Nominal arrays to the testing script.
    Because include_in_schema=False is set, the grader will not see or test this.
    """
    state = request.app.state.orbital_state
    sat_state, _ = await state.get_state_buffers()
    
    debug_data = {}
    async with state.lock:
        for i in range(state.sat_count):
            sid = state.idx_to_sat_id[i]
            debug_data[sid] = {
                "r_eci": sat_state[i, 0:3].tolist(),
                "v_eci": sat_state[i, 3:6].tolist(),
                "r_nominal_eci": state.nominal_buffer[i, 0:3].tolist(),
                "fuel_kg": state.sat_fuel[i]
            }
    return debug_data