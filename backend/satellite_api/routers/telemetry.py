"""
routers/telemetry.py
--------------------
POST /api/telemetry
Ingests high-frequency state vectors (upsert by object ID).
"""

from fastapi import APIRouter, HTTPException, Request
import logging
import orjson

from satellite_api.models import TelemetryIngestionResponse
from satellite_api.timeutils import parse_iso_utc

router = APIRouter()
logger = logging.getLogger(__name__)


@router.post(
    "/api/telemetry",
    response_model=TelemetryIngestionResponse,
    status_code=200
)
async def ingest_telemetry(request: Request) -> TelemetryIngestionResponse:
    state = request.app.state.orbital_state

    try:
        data = orjson.loads(await request.body())
        if not isinstance(data, dict):
            raise ValueError("payload must be a JSON object")
        objects = data.get("objects", [])
        if not isinstance(objects, list):
            raise ValueError("'objects' must be a list")
        timestamp_str = data.get("timestamp", "2026-01-01T00:00:00.000Z")
        current_ts = parse_iso_utc(timestamp_str).timestamp()

        sat_data, sat_ids = [], []
        debris_data, debris_ids = [], []
        append_sat_data = sat_data.append
        append_sat_ids = sat_ids.append
        append_deb_data = debris_data.append
        append_deb_ids = debris_ids.append

        sat_b, deb_b, any_b = [], [], False
        for obj in objects:
            r, v = obj["r"], obj["v"]
            vec = [float(r["x"]), float(r["y"]), float(r["z"]),
                   float(v["x"]), float(v["y"]), float(v["z"])]
            # Optional per-object ballistic coefficient Cd*A/m [m^2/kg] for the drag model.
            b = obj.get("ballistic_coefficient")
            b = float("nan") if b is None else float(b)
            any_b = any_b or b == b
            if str(obj.get("type", "DEBRIS")).upper() == "SATELLITE":
                append_sat_data(vec)
                append_sat_ids(str(obj["id"]))
                sat_b.append(b)
            else:
                append_deb_data(vec)
                append_deb_ids(str(obj["id"]))
                deb_b.append(b)
    except (ValueError, KeyError, TypeError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid payload: {e}")

    # Reject stale packets (older than the last accepted telemetry) to prevent
    # physics tearing, but still ACK so upstream feeds don't retry.
    if current_ts < state.last_telemetry_ts:
        return TelemetryIngestionResponse(
            status="ACK",
            processed_count=0,
            active_cdm_warnings=state.active_cdm_warnings,
        )
    state.last_telemetry_ts = current_ts

    await state.update_telemetry_raw(sat_data, debris_data, sat_ids, debris_ids, timestamp_str,
                                     sat_b if any_b else None, deb_b if any_b else None)

    pairs = state.warning_pairs()
    return TelemetryIngestionResponse(
        status="ACK",
        processed_count=len(objects),
        active_cdm_warnings=len(pairs),
        warning_pairs=pairs or None,
    )
