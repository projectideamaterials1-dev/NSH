import os
import sys

# Isolate tests from local runtime side effects before the app is imported.
os.environ.setdefault("ACM_ARCHIVE", "0")
os.environ.setdefault("ACM_BACKGROUND", "0")
os.environ.setdefault("ACM_IGNORE_SAVED_CONFIG", "1")
os.environ.pop("REDIS_URL", None)

import pytest
from httpx import AsyncClient, ASGITransport

# Add project root to Python path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from satellite_api.config import CONFIG, SimConfig
from satellite_api.main import app
from satellite_api.state import StateManager, get_state


@pytest.fixture(autouse=True)
def reset_state(monkeypatch, tmp_path):
    """Give every test a fresh StateManager singleton and default configuration."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path))       # config saves go to a temp dir
    CONFIG.__dict__.update(SimConfig().__dict__)
    StateManager._instance = None
    app.state.orbital_state = get_state()
    app.state.conjunction_service = None
    yield
    StateManager._instance = None
    CONFIG.__dict__.update(SimConfig().__dict__)


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


def make_object(obj_id, obj_type, r, v):
    return {
        "id": obj_id,
        "type": obj_type,
        "r": dict(zip("xyz", r)),
        "v": dict(zip("xyz", v)),
    }
