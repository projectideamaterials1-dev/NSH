import pytest
from datetime import datetime, timezone
from satellite_api.state import get_state

@pytest.mark.asyncio
async def test_cooldown_enforcement():
    state = get_state()
    # Simulate initial telemetry
    await state.update_telemetry_raw(
        sat_data=[[7000,0,0,0,7.5,0]],  # one satellite
        debris_data=[],
        sat_ids=["SAT-001"],
        debris_ids=[],
        timestamp_str="2026-01-01T00:00:00.000Z"
    )
    
    # Schedule a burn at t=10s
    burn_time = state.current_time.timestamp() + 10.0
    # Pack: (ts, sat_id, dvx, dvy, dvz, burn_id)
    await state.add_maneuver((burn_time, "SAT-001", 0.0, 0.0075, 0.0, "BURN-01")) 
    
    # Execute pending maneuvers at t=10.0
    executed = await state.execute_pending_maneuvers(burn_time)
    assert executed == 1
    
    # Cooldown timer should be set
    if hasattr(state, 'sat_cooldown_timers'):
        idx = state.sat_id_to_idx["SAT-001"]
        assert state.sat_cooldown_timers[idx] > 599.0
    
    # Try to schedule another burn within cooldown (at t=20s)
    new_burn_time = burn_time + 10.0
    await state.add_maneuver((new_burn_time, "SAT-001", 0.0, 0.0075, 0.0, "BURN-02"))
    executed2 = await state.execute_pending_maneuvers(new_burn_time)
    assert executed2 == 0  # blocked
