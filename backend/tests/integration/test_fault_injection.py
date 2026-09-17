"""
Fault-injection tests: confirm the system degrades the way Tier-1 durability/HA work is
supposed to make it degrade - fail fast when durability is required but unavailable, keep
running when it's merely best-effort, and fail over cleanly when a leader disappears.
"""
import asyncio
import os
import subprocess
import sys
from pathlib import Path

import pytest

from satellite_api.state_redis import RedisStateManager

BACKEND_ROOT = Path(__file__).resolve().parents[2]


class _FailingRedis:
    """Minimal fake that fails every call, simulating Redis being unreachable/down."""

    async def hset(self, key, mapping):
        raise ConnectionError("simulated Redis outage")

    async def hgetall(self, key):
        raise ConnectionError("simulated Redis outage")

    async def delete(self, key):
        raise ConnectionError("simulated Redis outage")

    async def set(self, key, value, nx=False, ex=None):
        raise ConnectionError("simulated Redis outage")

    async def get(self, key):
        raise ConnectionError("simulated Redis outage")


class _FakeRedis:
    """In-memory stand-in for redis.asyncio's subset of commands used by RedisStateManager."""

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

    async def get(self, key):
        return self.store.get(key)


@pytest.fixture(autouse=True)
def reset_redis_singleton():
    RedisStateManager._instance = None
    yield
    RedisStateManager._instance = None


def test_require_durable_state_fails_fast_in_a_fresh_process():
    """End-to-end, in a real subprocess (like a container restart): REQUIRE_DURABLE_STATE=1
    with no Redis configured must refuse to start rather than silently run in-memory-only."""
    env = dict(os.environ)
    env["REQUIRE_DURABLE_STATE"] = "1"
    env["ACM_BACKGROUND"] = "0"
    env["ACM_ARCHIVE"] = "0"
    env.pop("REDIS_URL", None)
    result = subprocess.run(
        [sys.executable, "-c", "import satellite_api.main"],
        cwd=str(BACKEND_ROOT), env=env, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode != 0
    assert "REQUIRE_DURABLE_STATE" in result.stderr


def test_require_durable_state_off_starts_in_memory_without_redis():
    """The default (REQUIRE_DURABLE_STATE unset) must keep working with no Redis at all -
    durability is a hardening option, not a hard dependency, unless explicitly required."""
    env = dict(os.environ)
    env["ACM_BACKGROUND"] = "0"
    env["ACM_ARCHIVE"] = "0"
    env.pop("REQUIRE_DURABLE_STATE", None)
    env.pop("REDIS_URL", None)
    result = subprocess.run(
        [sys.executable, "-c", "import satellite_api.main; print('OK')"],
        cwd=str(BACKEND_ROOT), env=env, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert "OK" in result.stdout


@pytest.mark.asyncio
async def test_immediate_save_survives_a_mid_session_redis_outage():
    """A burn/CDM event firing while Redis happens to be down must not crash the caller -
    only the periodic/immediate save should be lost, not the simulation."""
    state = RedisStateManager(client=_FailingRedis())
    await state.update_telemetry_raw(
        sat_data=[[7000.0, 0.0, 0.0, 0.0, 7.5, 0.0]], debris_data=[],
        sat_ids=["SAT-1"], debris_ids=[], timestamp_str="2026-01-01T00:00:00.000Z",
    )
    # Directly exercises the same path _on_mutation schedules on a real "maneuver" notification.
    await state._immediate_save()  # must not raise
    assert await state.save() is False  # save() itself also swallows the failure, returns falsy


@pytest.mark.asyncio
async def test_leader_election_fails_over_to_the_surviving_replica():
    """Exactly one of two replicas sharing Redis must be leader at a time, and losing the
    current leader must hand leadership to the other within one lock TTL."""
    fake = _FakeRedis()

    def _new_instance():
        RedisStateManager._instance = None
        inst = RedisStateManager(client=fake)
        inst._redis_configured = False  # bypass the singleton guard for this in-process test
        return inst

    a = _new_instance()
    b = _new_instance()
    RedisStateManager._instance = None

    gained = {"a": 0, "b": 0}
    a.start_leader_election(ttl_s=1.0, interval_s=0.1, on_gain=_incr(gained, "a"))
    b.start_leader_election(ttl_s=1.0, interval_s=0.1, on_gain=_incr(gained, "b"))
    try:
        await asyncio.sleep(0.6)
        assert a.is_leader != b.is_leader, "exactly one replica must be leader"

        leader, follower = (a, b) if a.is_leader else (b, a)
        await leader.stop_leader_election()
        await asyncio.sleep(0.6)
        assert follower.is_leader, "the surviving replica must take over leadership"
    finally:
        await a.stop_leader_election()
        await b.stop_leader_election()


def _incr(counter: dict, key: str):
    async def _cb():
        counter[key] += 1
    return _cb
