"""A screening loop that keeps failing must show up in /health, /metrics and the event log."""
import pytest

from satellite_api.acm.autopilot import SCREEN_FAILING_AFTER, ConjunctionService
from satellite_api.main import app


@pytest.mark.asyncio
async def test_repeated_screening_failures_degrade_health_until_recovery(client):
    state = app.state.orbital_state
    service = ConjunctionService(state)
    app.state.conjunction_service = service
    assert (await client.get("/health")).json()["status"] == "online"

    for _ in range(SCREEN_FAILING_AFTER):
        await service._record_cycle(RuntimeError("cudaErrorUnknown: unknown error"))
    health = (await client.get("/health")).json()
    assert health["status"] == "degraded"
    assert health["screening"]["consecutive_failures"] == SCREEN_FAILING_AFTER
    assert "cudaErrorUnknown" in health["screening"]["last_error"]
    assert "acm_screen_consecutive_failures 3.0" in (await client.get("/metrics")).text
    assert any(e["level"] == "crit" and "screening is failing" in e["message"] for e in state.events)

    await service._record_cycle(None)
    health = (await client.get("/health")).json()
    assert health["status"] == "online" and health["screening"]["consecutive_failures"] == 0
    assert any("screening recovered" in e["message"] for e in state.events)
