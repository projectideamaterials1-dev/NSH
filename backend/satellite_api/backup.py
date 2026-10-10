"""
backup.py
---------
Consistent backup / restore / verification of mission state:

* the Redis snapshot hash (`acm:state` - buffers, CDMs, queue, events, planner locks), exported
  field by field and base64-encoded so binary NumPy buffers survive JSON;
* the SQLite mission archive, copied with SQLite's online backup API (safe while the backend is
  writing to it);
* the saved runtime configuration (data/config.json), when present.

Every file is checksummed in manifest.json; `verify` re-checks the checksums, runs SQLite's
integrity check and confirms the snapshot decodes. Used by scripts/backup.py and exercised
end-to-end (backup -> wipe -> restore -> the state manager reloads it) in
tests/integration/test_backup_restore.py, which CI also runs against a real Redis.
"""
import base64
import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from satellite_api.state_redis import SNAPSHOT_KEY

FORMAT_VERSION = 1
REDIS_FILE = "redis_state.json"
ARCHIVE_FILE = "acm_archive.db"
CONFIG_FILE = "config.json"
REQUIRED_FIELDS = ("meta", "sat", "nominal", "fuel", "cooldown", "debris")


class BackupError(RuntimeError):
    pass


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _key(k) -> str:
    return k.decode() if isinstance(k, bytes) else str(k)


def backup(out_dir: Path, redis_client=None, db_path: Optional[Path] = None, config_path: Optional[Path] = None,
           key: str = SNAPSHOT_KEY) -> dict:
    """Writes a backup into `out_dir` (created; must be empty). `redis_client` is a synchronous
    redis-py style client (hgetall). Returns the manifest."""
    out_dir = Path(out_dir)
    if out_dir.exists() and any(out_dir.iterdir()):
        raise BackupError(f"{out_dir} is not empty")
    out_dir.mkdir(parents=True, exist_ok=True)
    files = {}

    if redis_client is not None:
        raw = redis_client.hgetall(key)
        if raw:
            payload = {_key(k): base64.b64encode(v if isinstance(v, bytes) else str(v).encode()).decode()
                       for k, v in raw.items()}
            (out_dir / REDIS_FILE).write_text(json.dumps({"key": key, "fields": payload}))
            files[REDIS_FILE] = {"fields": sorted(payload)}

    if db_path is not None and Path(db_path).exists():
        src = sqlite3.connect(str(db_path))
        dst = sqlite3.connect(str(out_dir / ARCHIVE_FILE))
        try:
            src.backup(dst)        # consistent copy even while the archive writer is active
        finally:
            dst.close()
            src.close()
        files[ARCHIVE_FILE] = {}

    if config_path is not None and Path(config_path).exists():
        shutil.copy2(config_path, out_dir / CONFIG_FILE)
        files[CONFIG_FILE] = {}

    if not files:
        raise BackupError("Nothing to back up (no Redis snapshot, archive or config found)")
    for name in files:
        files[name]["sha256"] = _sha256(out_dir / name)
        files[name]["bytes"] = (out_dir / name).stat().st_size
    manifest = {"format": FORMAT_VERSION, "created_at": datetime.now(timezone.utc).isoformat(), "files": files}
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest


def verify(backup_dir: Path) -> dict:
    """Checks a backup without touching live state. Raises BackupError on any problem."""
    backup_dir = Path(backup_dir)
    try:
        manifest = json.loads((backup_dir / "manifest.json").read_text())
    except (OSError, ValueError) as e:
        raise BackupError(f"Unreadable manifest: {e}") from e
    if manifest.get("format") != FORMAT_VERSION:
        raise BackupError(f"Unsupported backup format {manifest.get('format')}")
    report = {"created_at": manifest["created_at"], "files": {}}
    for name, info in manifest["files"].items():
        path = backup_dir / name
        if not path.exists():
            raise BackupError(f"Missing {name}")
        if _sha256(path) != info["sha256"]:
            raise BackupError(f"Checksum mismatch for {name}")
        report["files"][name] = "checksum ok"
    if ARCHIVE_FILE in manifest["files"]:
        conn = sqlite3.connect(str(backup_dir / ARCHIVE_FILE))
        try:
            result = conn.execute("PRAGMA integrity_check").fetchone()[0]
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        finally:
            conn.close()
        if result != "ok":
            raise BackupError(f"Archive integrity check failed: {result}")
        report["files"][ARCHIVE_FILE] += f", integrity ok, tables {sorted(tables)}"
    if REDIS_FILE in manifest["files"]:
        data = json.loads((backup_dir / REDIS_FILE).read_text())
        missing = [f for f in REQUIRED_FIELDS if f not in data["fields"]]
        if missing:
            raise BackupError(f"Snapshot is missing fields {missing}")
        meta = json.loads(base64.b64decode(data["fields"]["meta"]))
        report["files"][REDIS_FILE] += (f", snapshot of {len(meta.get('sat_ids', []))} satellites / "
                                        f"{len(meta.get('debris_ids', []))} objects at {meta.get('current_time')}")
    return report


def restore(backup_dir: Path, redis_client=None, db_path: Optional[Path] = None, config_path: Optional[Path] = None,
            force: bool = False) -> dict:
    """Restores a verified backup. Stop the backend first: a running leader would overwrite the
    restored snapshot with its own state on its next autosave. Refuses to overwrite an existing
    Redis snapshot unless `force`."""
    backup_dir = Path(backup_dir)
    verify(backup_dir)
    manifest = json.loads((backup_dir / "manifest.json").read_text())
    restored = []

    if REDIS_FILE in manifest["files"] and redis_client is not None:
        data = json.loads((backup_dir / REDIS_FILE).read_text())
        key = data["key"]
        if redis_client.exists(key) and not force:
            raise BackupError(f"Redis key {key} already holds a snapshot; pass force=True to replace it")
        mapping = {k: base64.b64decode(v) for k, v in data["fields"].items()}
        redis_client.delete(key)
        redis_client.hset(key, mapping=mapping)
        restored.append(f"redis:{key}")

    if ARCHIVE_FILE in manifest["files"] and db_path is not None:
        db_path = Path(db_path)
        db_path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(db_path.parent), suffix=".restore")
        os.close(fd)
        shutil.copy2(backup_dir / ARCHIVE_FILE, tmp)
        for suffix in ("-wal", "-shm"):       # stale WAL files would be replayed onto the restored DB
            Path(str(db_path) + suffix).unlink(missing_ok=True)
        os.replace(tmp, db_path)
        restored.append(str(db_path))

    if CONFIG_FILE in manifest["files"] and config_path is not None:
        Path(config_path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(backup_dir / CONFIG_FILE, config_path)
        restored.append(str(config_path))
    return {"restored": restored, "from": str(backup_dir), "created_at": manifest["created_at"]}
