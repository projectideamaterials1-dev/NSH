"""
routers/telemetry.py
---------------------
POST /api/telemetry

Receives position/velocity telemetry for satellites and debris,
updates internal state, and runs collision screening.
"""

from fastapi import APIRouter, Request
from models import TelemetryIngestionRequest, TelemetryIngestionResponse
from collision import run_collision_screening

router = APIRouter()


@router.post(
    "/telemetry",
    response_model=TelemetryIngestionResponse,
    summary="Ingest telemetry for space objects",
    description=(
        "Accepts real-time position (r) and velocity (v) vectors for "
        "satellites and debris. Updates internal state and runs two-stage "
        "collision screening. Returns ACK with active CDM warning count."
    ),
)
async def ingest_telemetry(
    payload: TelemetryIngestionRequest,
    request: Request,
) -> TelemetryIngestionResponse:

    state = request.app.state.orbital_state

    # ── 1. Upsert all incoming objects into shared state ──────────────────────
    for obj in payload.objects:
        state.upsert(obj)

    # Set sim epoch on first telemetry received
    if state.sim_epoch is None:
        state.sim_epoch = payload.timestamp

    # ── 2. Run collision screening on full object catalog ─────────────────────
    all_objects = state.get_all()
    warnings = run_collision_screening(all_objects, sim_time_offset_s=state.sim_time_s)

    # ── 3. Build response ─────────────────────────────────────────────────────
    warning_pairs = [
        {
            "object1": w.object1,
            "object2": w.object2,
            "closest_approach_km": w.closest_approach_km,
            "risk_level": w.risk_level,
            "predicted_time": w.predicted_time,
        }
        for w in warnings
    ]

    return TelemetryIngestionResponse(
        status="ACK",
        processed_count=len(payload.objects),
        active_cdm_warnings=len(warnings),
        warning_pairs=warning_pairs if warnings else None,
    )