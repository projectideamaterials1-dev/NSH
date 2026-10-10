"""Backup -> wipe -> restore -> reload, end to end.

Runs against in-process fakes by default. With REDIS_TEST_URL set (CI's backup-restore job
starts a real Redis service), the same test exercises a real server, so "the volume exists" is
not the only evidence that backups work.
"""
import json
import os
import sqlite3

import numpy as np
import pytest

from satellite_api.backup import BackupError, backup, restore, verify
from satellite_api.db import MissionArchive
from satellite_api.state_redis import RedisStateManager

TS = "2026-01-01T00:00:00.000Z"
KEY = "acm:test-backup"
REDIS_TEST_URL = os.environ.get("REDIS_TEST_URL")


class _Store:
    def __init__(self):
        self.data = {}


class AsyncFake:
    def __init__(self, store):
        self.s = store.data

    async def hset(self, key, mapping):
        self.s.setdefault(key, {}).update({(k.encode() if isinstance(k, str) else k): v for k, v in mapping.items()})

    async def hgetall(self, key):
        return dict(self.s.get(key, {}))

    async def delete(self, key):
        self.s.pop(key, None)

    async def set(self, key, value, nx=False, ex=None):
        if nx and key in self.s:
            return None
        self.s[key] = value
        return True

    async def get(self, key):
        return self.s.get(key)


class SyncFake:
    def __init__(self, store):
        self.s = store.data

    def hgetall(self, key):
        return dict(self.s.get(key, {}))

    def hset(self, key, mapping):
        self.s.setdefault(key, {}).update({(k.encode() if isinstance(k, str) else k): v for k, v in mapping.items()})

    def exists(self, key):
        return int(key in self.s)

    def delete(self, key):
        self.s.pop(key, None)


@pytest.fixture
def clients():
    if REDIS_TEST_URL:
        import redis
        import redis.asyncio as aredis
        sync = redis.Redis.from_url(REDIS_TEST_URL)
        sync.delete(KEY)
        yield aredis.from_url(REDIS_TEST_URL), sync
        sync.delete(KEY)
    else:
        store = _Store()
        yield AsyncFake(store), SyncFake(store)


@pytest.fixture(autouse=True)
def reset_singleton():
    RedisStateManager._instance = None
    yield
    RedisStateManager._instance = None


@pytest.mark.asyncio
async def test_backup_restore_round_trip(clients, tmp_path):
    async_client, sync_client = clients
    db_path = tmp_path / "live" / "acm_archive.db"
    db_path.parent.mkdir()
    config_path = tmp_path / "live" / "config.json"
    config_path.write_text(json.dumps({"maxDeltaV": 12.5}))

    original = RedisStateManager(client=async_client, key=KEY)
    archive = MissionArchive(str(db_path)).attach(original)
    await original.update_telemetry_raw([[7000, 0, 0, 0, 7.5, 0], [0, 7000, 0, -7.5, 0, 0]],
                                        [[7100, 0, 0, 0, 7.4, 0]], ["SAT-1", "SAT-2"], ["DEB-1"], TS)
    await original.add_maneuver((original.now_ts + 100, "SAT-1", 0.0, 0.001, 0.0, "B1", "MANUAL"))
    await original.run_simulation_step(150)
    original.sat_fuel[1] = 12.5
    original.emit("warn", "test", "before backup", satellite_id="SAT-2")
    assert await original.save(force=True)
    archive.flush()
    archive.close()
    expected_sat = original.sat_buffer[:2].copy()

    backup_dir = tmp_path / "backup"
    manifest = backup(backup_dir, sync_client, db_path, config_path, key=KEY)
    assert set(manifest["files"]) == {"redis_state.json", "acm_archive.db", "config.json"}
    report = verify(backup_dir)
    assert "2 satellites" in report["files"]["redis_state.json"]
    assert "integrity ok" in report["files"]["acm_archive.db"]

    # Disaster: snapshot gone, archive file gone, config gone.
    sync_client.delete(KEY)
    db_path.unlink()
    config_path.unlink()

    result = restore(backup_dir, sync_client, db_path, config_path)
    assert len(result["restored"]) == 3

    RedisStateManager._instance = None
    reloaded = RedisStateManager(client=async_client, key=KEY)
    assert await reloaded.restore()
    assert [reloaded.idx_to_sat_id[i] for i in range(2)] == ["SAT-1", "SAT-2"]
    np.testing.assert_allclose(reloaded.sat_buffer[:2], expected_sat)
    assert reloaded.sat_fuel[1] == pytest.approx(12.5)
    assert any(e["message"] == "before backup" for e in reloaded.events)

    conn = sqlite3.connect(str(db_path))
    try:
        executed = conn.execute("SELECT COUNT(*) FROM maneuver_history WHERE status='executed'").fetchone()[0]
        events = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    finally:
        conn.close()
    assert executed == 1 and events >= 1
    assert json.loads(config_path.read_text()) == {"maxDeltaV": 12.5}


def test_restore_refuses_to_clobber_and_verify_catches_tampering(clients, tmp_path):
    _, sync_client = clients
    sync_client.hset(KEY, mapping={"meta": json.dumps({"sat_ids": []}).encode(), "sat": b"", "nominal": b"", "fuel": b"",
                                   "cooldown": b"", "debris": b""})
    backup_dir = tmp_path / "b"
    backup(backup_dir, sync_client, key=KEY)
    with pytest.raises(BackupError, match="already holds"):
        restore(backup_dir, sync_client)
    restore(backup_dir, sync_client, force=True)

    with pytest.raises(BackupError, match="not empty"):
        backup(backup_dir, sync_client, key=KEY)

    (backup_dir / "redis_state.json").write_text("{}")
    with pytest.raises(BackupError, match="Checksum mismatch"):
        verify(backup_dir)


def _make_db(path):
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE t (x)")
    conn.commit()
    conn.close()


def test_scheduled_cycle_verifies_prunes_and_reports_status(tmp_path, monkeypatch):
    from satellite_api.backup import parse_interval, read_status, run_once
    assert parse_interval("6h") == 21600 and parse_interval("30m") == 1800 and parse_interval("90") == 90
    db = tmp_path / "acm_archive.db"
    _make_db(db)
    out = tmp_path / "backups"
    names = []
    for _ in range(4):                       # several cycles within one second: names must not collide
        status = run_once(out, None, db, None, keep=2)
        assert status["ok"], status
        names.append(status["name"])
    assert len(set(names)) == 4
    kept = sorted(p.name for p in out.iterdir() if p.is_dir())
    assert set(kept) == set(names[-2:])                # the two NEWEST survive pruning
    assert read_status(out)["last_success"] == status["time"]

    # A failing cycle is recorded but keeps the last success for the staleness alert.
    db.unlink()
    failed = run_once(out, None, db, None, keep=2)
    assert failed["ok"] is False and "Nothing to back up" in failed["error"]
    assert failed["last_success"] == status["time"]


@pytest.mark.asyncio
async def test_backup_status_is_exported_as_metrics(client, tmp_path, monkeypatch):
    from satellite_api.backup import run_once
    db = tmp_path / "acm_archive.db"
    _make_db(db)
    monkeypatch.setenv("BACKUP_DIR", str(tmp_path / "b"))
    run_once(tmp_path / "b", None, db, None)
    body = (await client.get("/metrics")).text
    assert "acm_backup_last_ok 1.0" in body and "acm_backup_last_success_timestamp_seconds" in body
