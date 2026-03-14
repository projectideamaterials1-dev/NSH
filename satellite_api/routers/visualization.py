"""
routers/visualization.py
-------------------------
GET /api/visualization/snapshot

Returns current state of all satellites and debris in a
compressed format optimized for frontend rendering.
Converts ECI position vectors to Lat/Lon/Altitude.
"""

from fastapi import APIRouter, Request
from datetime import datetime, timezone
import math

router = APIRouter()


def eci_to_geodetic(x: float, y: float, z: float) -> tuple[float, float, float]:
    """
    Convert ECI (x, y, z) in km to (latitude, longitude, altitude_km).
    Uses simplified conversion assuming Earth rotation is negligible
    for snapshot purposes (no GMST applied — frontend uses relative positions).
    """
    R_EARTH = 6378.137  # km

    # Longitude from x, y
    lon = math.degrees(math.atan2(y, x))

    # Distance from Earth center
    r_mag = math.sqrt(x**2 + y**2 + z**2)

    # Latitude from z component
    lat = math.degrees(math.asin(z / r_mag))

    # Altitude above surface
    alt = r_mag - R_EARTH

    return round(lat, 4), round(lon, 4), round(alt, 4)


@router.get(
    "/visualization/snapshot",
    summary="Get current orbital snapshot for visualization",
    description=(
        "Returns lat/lon/altitude for all satellites with fuel and status, "
        "and a compact debris cloud array for efficient frontend rendering."
    ),
)
async def visualization_snapshot(request: Request):

    state = request.app.state.orbital_state

    satellites = []
    debris_cloud = []

    for obj in state.get_all():
        lat, lon, alt = eci_to_geodetic(obj.r.x, obj.r.y, obj.r.z)

        if obj.type == "SATELLITE":
            # Determine status based on fuel
            if obj.fuel_kg <= 0:
                status = "EOL"
            elif obj.fuel_kg <= 2.5:  # 5% of 50kg
                status = "CRITICAL_FUEL"
            else:
                status = "NOMINAL"

            satellites.append({
                "id": obj.id,
                "lat": lat,
                "lon": lon,
                "alt_km": alt,
                "fuel_kg": round(obj.fuel_kg, 3),
                "status": status,
            })

        else:
            # Debris — compact tuple format [id, lat, lon, alt]
            debris_cloud.append([obj.id, lat, lon, alt])

    timestamp = (
        state.sim_epoch.isoformat()
        if state.sim_epoch
        else datetime.now(tz=timezone.utc).isoformat()
    )

    return {
        "timestamp": timestamp,
        "satellites": satellites,
        "debris_cloud": debris_cloud,
    }