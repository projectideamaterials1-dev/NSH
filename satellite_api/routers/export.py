"""
routers/export.py
-----------------
GET /api/export/czml
Predicted satellite ground tracks in Cesium CZML format.
"""
from datetime import timedelta
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query, Request
import numpy as np

from satellite_api.coordinates import convert_states_to_lla
from satellite_api.physics_engine import propagate_states
from satellite_api.timeutils import iso_z, parse_iso_utc

router = APIRouter()

MAX_SAMPLES = 1500


def generate_czml(satellites: List[dict], start_time: str, end_time: str) -> List[dict]:
    """CZML document for Cesium.js; each satellite needs `id` and `trajectory`
    as a flat list of [timeOffsetSeconds, lon_deg, lat_deg, height_m, ...]."""
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
                "cartographicDegrees": sat["trajectory"],
            },
            "path": {
                "material": {"solidColor": {"color": {"rgba": [0, 255, 255, 160]}}},
                "width": 1,
                "leadTime": 0,
                "trailTime": 5400,
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
async def export_czml(
    request: Request,
    start: Optional[str] = Query(None, description="ISO start (defaults to current sim time)"),
    end: Optional[str] = Query(None, description="ISO end (defaults to start + 1 h)"),
    step_seconds: float = Query(60.0, ge=1.0, le=3600.0),
):
    """Exports predicted satellite trajectories (RK4 + J2, no future burns) as CZML."""
    state = request.app.state.orbital_state
    if not state.is_ready() or state.current_time is None:
        raise HTTPException(status_code=400, detail="State not initialized")

    try:
        start_dt = parse_iso_utc(start) if start else state.current_time
        end_dt = parse_iso_utc(end) if end else start_dt + timedelta(hours=1)
    except ValueError:
        raise HTTPException(status_code=422, detail="start/end must be ISO-8601 timestamps")
    if end_dt <= start_dt:
        raise HTTPException(status_code=422, detail="end must be after start")
    if start_dt < state.current_time:
        raise HTTPException(status_code=422, detail="start must not be before the current simulation time")

    total_s = (end_dt - start_dt).total_seconds()
    n_samples = int(total_s // step_seconds) + 1
    if n_samples > MAX_SAMPLES:
        raise HTTPException(status_code=422, detail=f"Too many samples ({n_samples}); increase step_seconds")

    async with state.lock:
        n = state.sat_count
        states = state.sat_buffer[:n].copy()
        ids = [state.idx_to_sat_id[i] for i in range(n)]
        sim_now = state.current_time

    propagate_states(states, (start_dt - sim_now).total_seconds())
    tracks = [[] for _ in range(n)]
    for k in range(n_samples):
        t_offset = k * step_seconds
        if k > 0:
            propagate_states(states, step_seconds)
        lla = np.asarray(convert_states_to_lla(states, start_dt + timedelta(seconds=t_offset))).reshape(-1, 4)
        for i, (_, lat, lon, alt_km) in enumerate(lla.tolist()):
            tracks[i].extend([t_offset, round(lon, 5), round(lat, 5), round(alt_km * 1000.0, 1)])

    sats = [{"id": sid, "trajectory": tracks[i]} for i, sid in enumerate(ids)]
    return generate_czml(sats, iso_z(start_dt), iso_z(end_dt))
