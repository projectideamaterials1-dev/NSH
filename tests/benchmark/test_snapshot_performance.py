import pytest
import time

@pytest.mark.asyncio
async def test_snapshot_performance(client):
    headers = {"X-API-Key": "CRIMSON_NEBULA_2026"}
    start = time.perf_counter()
    response = await client.get("/api/visualization/snapshot", headers=headers)
    end = time.perf_counter()
    
    assert response.status_code in [200, 400]
    duration = end - start
    print(f"Snapshot took {duration:.4f}s")
    # For a small state, it should be very fast
    assert duration < 0.5
