"""
routers/simulation.py
----------------------
POST /api/simulate/step
Advances the simulation by step_seconds.
- Splits the step at scheduled burn epochs and executes each burn on time.
- Integrates physics for all objects (RK4 + J2) with Continuous Collision Detection
  (C++ engine, or the NumPy fallback when the extension is not built).
- Propagates Nominal "Ghost" slots for Station-Keeping drift detection.
- Returns strict 4-key JSON response matching Section 4.3 of NSH 2026 PS.
"""

from fastapi import APIRouter, Request, HTTPException
import logging

from satellite_api.models import SimulateStepRequest, SimulateStepResponse
from satellite_api.timeutils import iso_z

router = APIRouter()
logger = logging.getLogger(__name__)


@router.post(
    "/api/simulate/step",
    response_model=SimulateStepResponse,
    summary="Advance orbital simulation by one step",
)
async def simulate_step(payload: SimulateStepRequest, request: Request) -> SimulateStepResponse:
    state = request.app.state.orbital_state

    if not state.is_ready():
        raise HTTPException(status_code=400, detail="Telemetry not initialized.")
    live = getattr(request.app.state, "realworld", None)
    if live is not None and live.live and live.state is state:
        raise HTTPException(status_code=409, detail="Live mode keeps simulation time at real UTC; "
                                                    "turn live mode off (PUT /api/live) to step manually.")

    try:
        collisions, maneuvers_executed = await state.run_simulation_step(payload.step_seconds)
    except Exception as e:
        logger.error(f"Simulation step failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Engine Error: {e}")

    return SimulateStepResponse(
        status="STEP_COMPLETE",
        new_timestamp=iso_z(state.current_time),
        collisions_detected=collisions,
        maneuvers_executed=maneuvers_executed,
    )
