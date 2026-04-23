import pytest
import sys
import os
import asyncio
from httpx import AsyncClient, ASGITransport

# Add project root to Python path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from satellite_api.main import app
from satellite_api.state import get_state, StateManager

@pytest.fixture
async def client():
    """Async test client with StateManager override."""
    # Force use of StateManager instead of RedisStateManager for tests
    app.state.orbital_state = get_state() 
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

@pytest.fixture(autouse=True)
def reset_state():
    """Reset state before each test."""
    state = get_state()
    # Reset singleton state (hack for testing)
    state.__class__._instance = None
    get_state()  # reinitialize
    yield
    state.__class__._instance = None
