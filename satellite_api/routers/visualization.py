from fastapi import APIRouter, Request, HTTPException
import logging

from satellite_api.coordinates import convert_states_to_lla

router = APIRouter()
logger = logging.getLogger(__name__)

@router.get(
    "/visualization/snapshot",
    summary="Get current orbital snapshot for visualization",
    description="Returns GMST-corrected lat/lon/altitude for satellites and debris."
)
async def visualization_snapshot(request: Request):
    state = request.app.state.orbital_state
    
    if not state.is_ready() or state.current_time is None:
        raise HTTPException(status_code=400, detail="State not initialized.")

    # ── 1. Fetch the exact memory slices from our NumPy buffers ─────────────
    sat_state, debris_state = await state.get_state_buffers()

    # ── 2. Vectorized WGS84 ECI-to-LLA Math ─────────────────────────────────
    # Output format is an array of [index, lat, lon, alt]
    sat_lla_raw = convert_states_to_lla(sat_state, state.current_time)
    debris_lla_raw = convert_states_to_lla(debris_state, state.current_time)

    satellites = []
    # Lock the state briefly to ensure fuel and ID arrays don't mutate
    async with state.lock:
        # ── 3. Build Satellite Dicts (Matches Teammate's Contract) ──────────
        for row in sat_lla_raw:
            idx = int(row[0])
            lat, lon, alt = round(row[1], 4), round(row[2], 4), round(row[3], 4)
            fuel = state.sat_fuel[idx]
            
            # Determine status based on fuel (5% threshold = 2.5kg)
            if fuel <= 0:
                status = "EOL"
            elif fuel <= 2.5:
                status = "CRITICAL_FUEL"
            else:
                status = "NOMINAL"
            
            satellites.append({
                "id": state.idx_to_sat_id[idx],
                "lat": lat,
                "lon": lon,
                "alt_km": alt,
                "fuel_kg": round(fuel, 3),
                "status": status,
            })

        # ── 4. Build Debris Cloud (Flattened per NSH Spec Section 6.3) ──────
        # Format: [ID, Lat, Lon, Alt]
        debris_cloud = [
            [
                state.idx_to_debris_id[int(row[0])],
                round(row[1], 4),
                round(row[2], 4),
                round(row[3], 4)
            ]
            for row in debris_lla_raw
        ]

    return {
        "timestamp": state.current_time.isoformat(),
        "satellites": satellites,
        "debris_cloud": debris_cloud,
    }