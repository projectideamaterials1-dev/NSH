from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import ORJSONResponse
import asyncio
import logging
import acm_engine
from datetime import timedelta

from satellite_api.models import SimulateStepRequest, SimulateStepResponse

router = APIRouter()
logger = logging.getLogger(__name__)

@router.post(
    "/simulate/step",
    response_model=SimulateStepResponse,
    summary="Advance orbital simulation by one step",
    description="Advances simulation using C++ RK4+J2 propagation. Executes scheduled maneuvers."
)
async def simulate_step(payload: SimulateStepRequest, request: Request) -> SimulateStepResponse:
    state = request.app.state.orbital_state
    
    if not state.is_ready():
        raise HTTPException(status_code=400, detail="Telemetry not initialized.")

    try:
        # ── 1. Calculate the Time Window ──────────────────────────────────────
        target_time_dt = state.current_time + timedelta(seconds=payload.step_seconds)
        target_time_ts = target_time_dt.timestamp()

        # ── 2. Execute Scheduled Maneuvers (Just-In-Time) ─────────────────────
        # Applies ΔV directly to NumPy velocity buffers BEFORE C++ propagation
        maneuvers_executed = await state.execute_pending_maneuvers(target_time_ts)

        # ── 3. Fetch Isolated State Buffers ───────────────────────────────────
        sat_state, debris_state = await state.get_state_buffers()

        # ── 4. C++ Physics Propagation & Collision Detection ──────────────────
        # Offload to C++ engine. GIL is released.
        updated_sat, updated_debris, collisions = await asyncio.to_thread(
            acm_engine.process_conjunctions,
            sat_state,
            debris_state,
            0.100,               # 100m collision threshold
            payload.step_seconds # dt in seconds
        )

        # ── 5. Commit Propagated States & Advance Clock ───────────────────────
        await state.commit_state_buffers(updated_sat, updated_debris)
        new_timestamp = await state.advance_time(payload.step_seconds)

        # ── 6. Format Collision Results ───────────────────────────────────────
        collision_list = collisions.tolist() if len(collisions) > 0 else []

        # ── 7. Build Swagger-Compliant Response (Matches NSH Spec) ────────────
        return SimulateStepResponse(
            status="STEP_COMPLETE",
            new_timestamp=new_timestamp,
            collisions_detected=len(collision_list),
            maneuvers_executed=maneuvers_executed,
            collision_data=collision_list
        )
    except Exception as e:
        logger.error(f"Simulation step failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"C++ Engine Error: {str(e)}")