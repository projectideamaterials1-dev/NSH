"""
routers/export.py
-----------------
GET /api/export/czml
Predicted satellite ground tracks in Cesium CZML format.
"""
import asyncio
import time
from datetime import timedelta
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse
import numpy as np

from satellite_api.coordinates import convert_states_to_lla
from satellite_api.physics_engine import propagate_fast
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

    propagate_fast(states, (start_dt - sim_now).total_seconds())
    tracks = [[] for _ in range(n)]
    for k in range(n_samples):
        t_offset = k * step_seconds
        if k > 0:
            propagate_fast(states, step_seconds)
        lla = np.asarray(convert_states_to_lla(states, start_dt + timedelta(seconds=t_offset))).reshape(-1, 4)
        for i, (_, lat, lon, alt_km) in enumerate(lla.tolist()):
            tracks[i].extend([t_offset, round(lon, 5), round(lat, 5), round(alt_km * 1000.0, 1)])

    sats = [{"id": sid, "trajectory": tracks[i]} for i, sid in enumerate(ids)]
    return generate_czml(sats, iso_z(start_dt), iso_z(end_dt))


# ─── CCSDS OEM ────────────────────────────────────────────────────────────────────────────
def _oem_epoch(ts: float) -> str:
    return iso_z(ts)[:-1]          # CCSDS epochs carry no "Z"


def build_oem(sat_id: str, state0: np.ndarray, start_ts: float, horizon_s: float, step_s: float,
              burns: List[tuple], ballistic=None, originator: str = "NSH") -> str:
    """CCSDS Orbit Ephemeris Message 2.0 (KVN) of one satellite's predicted trajectory, WITH its queued
    burns applied (ILRS practice: predictions issued before a maneuver contain the post-maneuver arc).
    Each burn starts a new segment, as CCSDS 502.0-B recommends for velocity discontinuities.

    burns: (burn_ts, dv_eci_kms[3]) in time order, within the horizon."""
    end_ts = start_ts + horizon_s
    cuts = [start_ts] + [b[0] for b in burns] + [end_ts]
    state = np.asarray(state0, dtype=np.float64).reshape(1, 6).copy()
    lines = ["CCSDS_OEM_VERS = 2.0", f"CREATION_DATE = {_oem_epoch(time.time())}", f"ORIGINATOR = {originator}", ""]
    t = start_ts
    for seg in range(len(cuts) - 1):
        seg_start, seg_end = cuts[seg], cuts[seg + 1]
        if seg > 0:
            state[0, 3:] += burns[seg - 1][1]            # the burn at the segment boundary
        lines += ["META_START", f"OBJECT_NAME = {sat_id}", f"OBJECT_ID = {sat_id}", "CENTER_NAME = EARTH",
                  "REF_FRAME = TEME", "TIME_SYSTEM = UTC", f"START_TIME = {_oem_epoch(seg_start)}",
                  f"STOP_TIME = {_oem_epoch(seg_end)}", "META_STOP", ""]
        if seg == 0:
            lines.append("COMMENT Predicted by the NSH engine (RK4 + J2 + drag), decision-support fidelity.")
        else:
            dv = burns[seg - 1][1] * 1000.0
            lines.append(f"COMMENT Planned impulsive burn at {_oem_epoch(seg_start)}: dv ECI "
                         f"[{dv[0]:.4f}, {dv[1]:.4f}, {dv[2]:.4f}] m/s ({np.linalg.norm(dv):.4f} m/s)")
        samples = [seg_start] + [seg_start + k * step_s for k in range(1, int((seg_end - seg_start) // step_s) + 1)]
        if samples[-1] < seg_end - 1e-6:
            samples.append(seg_end)
        for ts in samples:
            if ts - t > 1e-9:
                propagate_fast(state, ts - t, ballistic)
                t = ts
            r, v = state[0, :3], state[0, 3:]
            lines.append(f"{_oem_epoch(ts)} {r[0]:.6f} {r[1]:.6f} {r[2]:.6f} {v[0]:.9f} {v[1]:.9f} {v[2]:.9f}")
        lines.append("")
    return "\n".join(lines)


@router.get("/api/export/oem/{sat_id}", tags=["Export"], response_class=PlainTextResponse)
async def export_oem(
    request: Request, sat_id: str,
    hours: float = Query(6.0, gt=0, le=72, description="Prediction horizon"),
    step_seconds: float = Query(60.0, ge=1.0, le=3600.0),
):
    """Predicted ephemeris of one satellite, including its queued burns, as a CCSDS OEM (KVN) - the format
    operators and screening services exchange planned-maneuver trajectories in."""
    state = request.app.state.orbital_state
    if not state.is_ready() or state.current_time is None:
        raise HTTPException(status_code=400, detail="State not initialized")
    horizon_s = hours * 3600.0
    if horizon_s / step_seconds > MAX_SAMPLES:
        raise HTTPException(status_code=422, detail="Too many samples; increase step_seconds")
    async with state.lock:
        idx = state.sat_id_to_idx.get(sat_id)
        if idx is None:
            raise HTTPException(status_code=404, detail=f"Unknown satellite {sat_id!r}")
        state0 = state.sat_buffer[idx].copy()
        start_ts = state.now_ts
        sat_b, _ = state.ballistic_arrays()
        ballistic = None if sat_b is None else np.asarray(sat_b, dtype=float)[idx:idx + 1]
        burns = sorted((float(m[0]), np.array(m[2:5], dtype=float)) for m in state.maneuver_queue
                       if m[1] == sat_id and start_ts < float(m[0]) < start_ts + horizon_s)
    text = await asyncio.to_thread(build_oem, sat_id, state0, start_ts, horizon_s, step_seconds, burns, ballistic)
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in sat_id)
    return PlainTextResponse(text, headers={"Content-Disposition": f'attachment; filename="{safe}.oem"'})
