from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse
from typing import List
import datetime

router = APIRouter()

def generate_czml(satellites: List[dict], start_time: str, end_time: str) -> List[dict]:
    """Basic CZML output for Cesium.js visualization."""
    czml = [{
        "id": "document",
        "name": "Crimson Nebula Export",
        "version": "1.0",
        "clock": {
            "interval": f"{start_time}/{end_time}",
            "currentTime": start_time,
            "multiplier": 60,
            "range": "LOOP_STOP"
        }
    }]
    
    for sat in satellites:
        czml.append({
            "id": sat["id"],
            "name": sat["id"],
            "availability": f"{start_time}/{end_time}",
            "position": {
                "epoch": start_time,
                "cartographicDegrees": sat["trajectory"]  # array of [timeOffset, lon, lat, alt]
            },
            "point": {
                "color": {"rgba": [0, 255, 255, 255]},
                "pixelSize": 10,
                "outlineColor": {"rgba": [255, 255, 255, 255]},
                "outlineWidth": 2
            },
            "label": {
                "text": sat["id"],
                "show": True,
                "font": "12pt monospace",
                "pixelOffset": {"cartesian2": [0, -15]}
            }
        })
    return czml

@router.get("/api/export/czml", tags=["Export"])
async def export_czml(request: Request, start: str = None, end: str = None):
    """Exports current satellite trajectories in Cesium CZML format."""
    state = request.app.state.orbital_state
    if not state.is_ready():
        raise HTTPException(status_code=400, detail="State not initialized")
        
    # In a real implementation, we would extract historical/predicted points from trails.
    # Placeholder: Return an empty CZML structure with basic document info.
    now = state.current_time or datetime.datetime.now(datetime.timezone.utc)
    start_iso = start or now.isoformat()
    end_iso = end or (now + datetime.timedelta(hours=1)).isoformat()
    
    # Mock data for demonstration
    mock_sats = []
    for sat_id in list(state.sat_id_to_idx.keys())[:5]:
        mock_sats.append({
            "id": sat_id,
            "trajectory": [0, 77.5, 13.0, 500000] # t, lon, lat, alt
        })
        
    return generate_czml(mock_sats, start_iso, end_iso)
