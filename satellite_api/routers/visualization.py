"""
routers/visualization.py
-------------------------
GET /api/visualization/snapshot
Provides a highly compressed snapshot of all orbital objects.
STRICTLY matches the NSH 2026 Problem Statement schema.
Optimized for 100k+ objects using NumPy vectorization.
"""

from fastapi import APIRouter, Request, HTTPException, Query
from fastapi.responses import ORJSONResponse, StreamingResponse
from typing import Optional
import asyncio
import logging

import numpy as np
import orjson

from satellite_api.models import VisualizationSnapshotResponse
from satellite_api.coordinates import convert_states_to_lla
from satellite_api.timeutils import iso_z

router = APIRouter()
logger = logging.getLogger(__name__)


def _sat_status(fuel: float) -> str:
    if fuel <= 0.0:
        return "EOL"
    if fuel <= 2.5:
        return "CRITICAL_FUEL"
    return "NOMINAL"


def _parse_bbox(bbox: Optional[str]):
    if not bbox:
        return None
    parts = bbox.split(",")
    try:
        if len(parts) != 4:
            raise ValueError
        min_lon, min_lat, max_lon, max_lat = map(float, parts)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid bbox format. Expected minLon,minLat,maxLon,maxLat")
    return min_lon, min_lat, max_lon, max_lat


def _bbox_mask(lla: np.ndarray, bbox) -> np.ndarray:
    if bbox is None or len(lla) == 0:
        return np.ones(len(lla), dtype=bool)
    min_lon, min_lat, max_lon, max_lat = bbox
    lat, lon = lla[:, 1], lla[:, 2]
    return (lon >= min_lon) & (lon <= max_lon) & (lat >= min_lat) & (lat <= max_lat)


def _build_snapshot(state, bbox=None, page: int = 1, per_page: Optional[int] = None):
    """Builds the snapshot dict. Caller must hold state.lock. Returns (snapshot, total_debris)."""
    n_sat, n_deb = state.sat_count, state.debris_count
    sat_lla = convert_states_to_lla(state.sat_buffer[:n_sat], state.current_time, as_array=True)
    deb_lla = convert_states_to_lla(state.debris_buffer[:n_deb], state.current_time, as_array=True)

    satellites = []
    for row in sat_lla[_bbox_mask(sat_lla, bbox)]:
        idx = int(row[0])
        fuel = float(state.sat_fuel[idx])
        satellites.append({
            "id": state.idx_to_sat_id.get(idx, f"SAT-UNKNOWN-{idx}"),
            "lat": round(float(row[1]), 4),
            "lon": round(float(row[2]), 4),
            "fuel_kg": round(fuel, 2),
            "status": _sat_status(fuel),
        })

    deb_rows = deb_lla if bbox is None else deb_lla[_bbox_mask(deb_lla, bbox)]
    total_debris = len(deb_rows)
    if per_page is not None:
        start = (page - 1) * per_page
        deb_rows = deb_rows[start:start + per_page]
    id_map = state.idx_to_debris_id
    ids = [id_map.get(i, "UNKNOWN") for i in deb_rows[:, 0].astype(np.int64).tolist()]
    lat, lon, alt = np.round(deb_rows[:, 1:4], 4).T.tolist() if total_debris else ([], [], [])
    debris_cloud = list(map(list, zip(ids, lat, lon, alt)))

    snapshot = {
        "timestamp": iso_z(state.current_time),
        "satellites": satellites,
        "debris_cloud": debris_cloud,
    }
    return snapshot, total_debris


@router.get(
    "/api/visualization/snapshot",
    response_model=VisualizationSnapshotResponse,
    summary="Get current orbital snapshot for visualization",
)
async def visualization_snapshot(
    request: Request,
    bbox: Optional[str] = Query(None, description="minLon,minLat,maxLon,maxLat"),
    page: int = Query(1, ge=1, description="Debris page (only used with per_page)"),
    per_page: Optional[int] = Query(None, ge=1, le=100000, description="Debris page size; omit for the full cloud"),
):
    state = request.app.state.orbital_state

    if not state.is_ready() or state.current_time is None:
        raise HTTPException(status_code=400, detail="State not initialized.")

    parsed_bbox = _parse_bbox(bbox)
    async with state.lock:
        snapshot, total_debris = _build_snapshot(state, parsed_bbox, page, per_page)

    headers = {"X-Total-Count": str(total_debris)}
    if per_page is not None:
        headers["X-Page"] = str(page)
        headers["X-Per-Page"] = str(per_page)
    # Returned directly (skipping per-row pydantic validation) to stay fast at 100k+ debris;
    # response_model above still documents the schema.
    return ORJSONResponse(snapshot, headers=headers)


@router.get("/api/stream/snapshot")
async def snapshot_stream(request: Request):
    """Server-Sent Events stream that pushes a snapshot whenever simulation time changes."""
    state = request.app.state.orbital_state

    async def event_generator():
        last_timestamp = None
        while not await request.is_disconnected():
            if state.is_ready() and state.current_time is not None:
                async with state.lock:
                    ts = state.current_time.isoformat()
                    snapshot = None
                    if ts != last_timestamp:
                        snapshot, _ = _build_snapshot(state)
                if snapshot is not None:
                    yield b"data: " + orjson.dumps(snapshot) + b"\n\n"
                    last_timestamp = ts
            await asyncio.sleep(0.5)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


# ============================================================================
# HIDDEN INTERNAL DEBUG API (For Forensic Test Scripts)
# ============================================================================
@router.get("/api/internal/debug_state", include_in_schema=False)
async def debug_state(request: Request):
    """Raw ECI and Nominal arrays for the stress-test script (hidden from OpenAPI)."""
    state = request.app.state.orbital_state
    debug_data = {}
    async with state.lock:
        for i in range(state.sat_count):
            sid = state.idx_to_sat_id[i]
            debug_data[sid] = {
                "r_eci": state.sat_buffer[i, 0:3].tolist(),
                "v_eci": state.sat_buffer[i, 3:6].tolist(),
                "r_nominal_eci": state.nominal_buffer[i, 0:3].tolist(),
                "v_nominal_eci": state.nominal_buffer[i, 3:6].tolist(),
                "fuel_kg": float(state.sat_fuel[i]),
                "cooldown_s": float(state.sat_cooldown_timers[i]),
            }
    return debug_data
