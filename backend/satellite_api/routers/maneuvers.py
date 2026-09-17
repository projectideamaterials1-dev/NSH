"""
routers/maneuvers.py
--------------------
POST /api/maneuver/schedule
Validates and schedules evasion, recovery, and EOL maneuvers.
Strictly enforces Tsiolkovsky fuel depletion, 15m/s thrust limits, 600s cooldowns,
and Sequence-Level Line-of-Sight (LOS) constraints (see acm/scheduler.py).
"""

from fastapi import APIRouter, Request, HTTPException, status
import logging

import numpy as np

from satellite_api.acm.scheduler import BurnRequest, evaluate_sequence, queue_burns
from satellite_api.ground_stations import GS_ECEF, GS_SIN_MIN_EL, gmst_rad, has_los
from satellite_api.models import ManeuverScheduleRequest, ManeuverScheduleResponse, ValidationResult
from satellite_api.timeutils import parse_iso_utc

logger = logging.getLogger(__name__)
router = APIRouter()

__all__ = ["router", "check_los_validity_vectorized", "GS_ECEF", "GS_SIN_MIN_EL"]


def _calculate_gmst(ts: float) -> float:
    return gmst_rad(ts)


def check_los_validity_vectorized(r_eci: np.ndarray, current_ts: float) -> bool:
    """True if at least one ground station sees the position above its minimum elevation."""
    return has_los(r_eci, current_ts)


@router.post(
    "/api/maneuver/schedule",
    response_model=ManeuverScheduleResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Schedule a maneuver sequence",
    description="""
    Validates and schedules a sequence of burns for a satellite.
    - **Δv per burn ≤15 m/s**
    - **Minimum 600s cooldown between burns**
    - **Line-of-sight to at least one ground station required**
    - **Tsiolkovsky fuel feasibility check**
    """,
    responses={
        202: {"description": "Maneuver accepted", "model": ManeuverScheduleResponse},
        400: {"description": "Telemetry not initialized or invalid request"},
        404: {"description": "Satellite not found"},
        422: {"description": "Validation error (e.g., invalid burnTime)"}
    }
)
async def schedule_maneuver(request: ManeuverScheduleRequest, req: Request):
    state = req.app.state.orbital_state
    sat_id = request.satelliteId

    if not state.is_ready():
        raise HTTPException(status_code=400, detail="Telemetry not initialized.")
    if sat_id not in state.sat_id_to_idx:
        raise HTTPException(status_code=404, detail=f"Satellite {sat_id} not found.")
    if not request.maneuver_sequence:
        raise HTTPException(status_code=422, detail="maneuver_sequence must not be empty.")

    actor = getattr(req.state, "actor", "unknown")
    burns = []
    for burn in request.maneuver_sequence:
        try:
            ts = parse_iso_utc(burn.burnTime).timestamp()
        except ValueError:
            raise HTTPException(status_code=422, detail=f"Invalid burnTime for {burn.burn_id}: {burn.burnTime!r}")
        dv = burn.deltaV_vector
        burns.append(BurnRequest(burn.burn_id, ts, (dv.x, dv.y, dv.z), "EXTERNAL", actor))

    async with state.lock:
        evaluation = evaluate_sequence(state, sat_id, burns)
        if evaluation.accepted:
            queue_burns(state, sat_id, burns, source="api")
        else:
            logger.info(f"Rejected maneuver for {sat_id}: {evaluation.status}")
            state.emit("warn", "maneuver", f"Burn request rejected: {evaluation.reason.replace('_', ' ').lower()}",
                       satellite_id=sat_id, reason=evaluation.reason, source="api")

    return ManeuverScheduleResponse(
        status=evaluation.status,
        validation=ValidationResult(
            ground_station_los=evaluation.ground_station_los,
            sufficient_fuel=evaluation.sufficient_fuel,
            projected_mass_remaining_kg=round(evaluation.projected_mass_remaining_kg, 2),
        ),
    )
