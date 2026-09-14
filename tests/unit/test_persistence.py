import numpy as np
import pytest

from satellite_api.db import MissionArchive, add_pending_maneuver, init_db
from satellite_api.state import StateManager
from satellite_api.state_redis import RedisStateManager

TS = "2026-01-01T00:00:00.000Z"


class FakeRedis:
    def __init__(self):
        self.store = {}

    async def hset(self, key, mapping):
        self.store.setdefault(key, {}).update({k.encode(): v for k, v in mapping.items()})

    async def hgetall(self, key):
        return dict(self.store.get(key, {}))

    async def delete(self, key):
        self.store.pop(key, None)

    async def set(self, key, value, nx=False, ex=None):
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True


@pytest.fixture(autouse=True)
def reset_redis_singleton():
    RedisStateManager._instance = None
    yield
    RedisStateManager._instance = None


async def _populated(state):
    await state.update_telemetry_raw([[7000, 0, 0, 0, 7.5, 0], [0, 7000, 0, -7.5, 0, 0]], [[7100, 0, 0, 0, 7.4, 0]],
                                     ["SAT-1", "SAT-2"], ["DEB-1"], TS)
    await state.add_maneuver((state.now_ts + 100, "SAT-1", 0.0, 0.001, 0.0, "B1", "MANUAL"))
    await state.run_simulation_step(120)
    state.sat_fuel[1] = 12.5
    state.emit("warn", "test", "hello", satellite_id="SAT-2")


@pytest.mark.asyncio
async def test_redis_state_round_trip():
    fake = FakeRedis()
    original = RedisStateManager(client=fake)
    assert isinstance(original, StateManager)
    await _populated(original)
    assert await original.save() is True
    assert await original.save() is False          # unchanged -> skipped
    sat_before = original.sat_buffer[:2].copy()
    history_before = list(original.maneuver_history)

    RedisStateManager._instance = None
    restored = RedisStateManager(client=fake)
    assert restored is not original and not restored.is_ready()
    assert await restored.restore() is True

    assert restored.sat_count == 2 and restored.debris_count == 1
    assert np.array_equal(restored.sat_buffer[:2], sat_before)
    assert restored.sat_fuel[1] == 12.5
    assert restored.sat_id_to_idx == {"SAT-1": 0, "SAT-2": 1}
    assert restored.current_time == original.current_time
    assert restored.maneuver_history == history_before
    assert restored.burns_executed == 1
    assert any(e["message"] == "hello" for e in restored.events)
    assert "restored" in restored.events[-1]["message"]

    # the restored manager keeps simulating
    collisions, _ = await restored.run_simulation_step(60)
    assert collisions == 0


@pytest.mark.asyncio
async def test_redis_restore_without_snapshot_and_locks():
    fake = FakeRedis()
    manager = RedisStateManager(client=fake)
    assert await manager.restore() is False
    assert await manager.acquire_lock() is True
    assert await manager.acquire_lock() is False
    await manager.release_lock()
    assert await manager.acquire_lock() is True


@pytest.mark.asyncio
async def test_mission_archive_persists_maneuvers_and_events(tmp_path):
    path = str(tmp_path / "archive.db")
    StateManager._instance = None
    state = StateManager()
    archive = MissionArchive(path).attach(state)
    await _populated(state)
    archive.flush()

    maneuvers = archive.maneuvers()
    assert [m["burn_id"] for m in maneuvers] == ["B1"]
    assert maneuvers[0]["status"] == "executed" and maneuvers[0]["maneuver_type"] == "MANUAL"
    assert maneuvers[0]["fuel_kg"] > 0

    warn = archive.events(level="warn")
    assert warn[0]["message"] == "hello" and warn[0]["satellite_id"] == "SAT-2"
    assert len(archive.events()) >= 3
    archive.close()

    # survives a restart
    reopened = MissionArchive(path)
    assert reopened.maneuvers(satellite_id="SAT-1")[0]["burn_id"] == "B1"
    reopened.close()


def test_legacy_pending_maneuver_helpers(tmp_path):
    import sqlite3
    path = str(tmp_path / "legacy.db")
    init_db(path)
    add_pending_maneuver(1.0, "SAT-1", 0.0, 0.001, 0.0, "B-LEGACY", path=path)
    rows = sqlite3.connect(path).execute("SELECT burn_id, sat_id FROM pending_maneuvers").fetchall()
    assert rows == [("B-LEGACY", "SAT-1")]
