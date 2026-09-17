"""
db.py
-----
SQLite mission archive. Every maneuver record (pending/executed/rejected/cancelled) and every
operator event is appended to a local database so the history survives restarts and can be
queried (GET /api/archive/maneuvers, GET /api/archive/events).

Writes go through a single background thread so the simulation loop never blocks on disk I/O.
Enabled by default at <DATA_DIR>/acm_archive.db; set ACM_ARCHIVE=0 to disable or
ACM_DB_PATH to choose the file.
"""
import json
import logging
import os
import queue
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from satellite_api.timeutils import data_dir

logger = logging.getLogger(__name__)

DB_PATH = os.environ.get("ACM_DB_PATH") or str(data_dir() / "acm_archive.db")

SCHEMA = [
    '''
    CREATE TABLE IF NOT EXISTS pending_maneuvers (
        burn_id TEXT PRIMARY KEY,
        ts REAL,
        sat_id TEXT,
        dvx REAL,
        dvy REAL,
        dvz REAL
    )
    ''',
    '''
    CREATE TABLE IF NOT EXISTS maneuver_history (
        burn_id TEXT,
        satellite_id TEXT,
        burnTime TEXT,
        dvx REAL, dvy REAL, dvz REAL,
        status TEXT,
        maneuver_type TEXT,
        delta_v_mps REAL,
        fuel_kg REAL,
        lat REAL,
        lon REAL,
        reason TEXT,
        actor TEXT,
        recorded_at TEXT,
        PRIMARY KEY (burn_id, status)
    )
    ''',
    '''
    CREATE TABLE IF NOT EXISTS events (
        id INTEGER,
        session TEXT,
        sim_time TEXT,
        wall_time TEXT,
        level TEXT,
        category TEXT,
        satellite_id TEXT,
        message TEXT,
        data TEXT,
        PRIMARY KEY (session, id)
    )
    ''',
    "CREATE INDEX IF NOT EXISTS idx_history_sat ON maneuver_history (satellite_id)",
    "CREATE INDEX IF NOT EXISTS idx_events_level ON events (level)",
]


def _connect(path: str) -> sqlite3.Connection:
    if path != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(path: Optional[str] = None):
    conn = _connect(path or DB_PATH)
    cursor = conn.cursor()
    for statement in SCHEMA:
        cursor.execute(statement)
    # Additive migration for databases created before the actor column existed.
    try:
        cursor.execute("ALTER TABLE maneuver_history ADD COLUMN actor TEXT")
    except sqlite3.OperationalError:
        pass  # already has the column
    conn.commit()
    conn.close()


def add_pending_maneuver(ts, sat_id, dvx, dvy, dvz, burn_id, path: Optional[str] = None):
    conn = _connect(path or DB_PATH)
    cursor = conn.cursor()
    cursor.execute('''
        INSERT OR REPLACE INTO pending_maneuvers (ts, sat_id, dvx, dvy, dvz, burn_id)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (ts, sat_id, dvx, dvy, dvz, burn_id))
    conn.commit()
    conn.close()


class MissionArchive:
    """Subscribes to StateManager notifications and persists them asynchronously."""

    def __init__(self, path: Optional[str] = None):
        self.path = path or DB_PATH
        self.session = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        self._queue: "queue.Queue[Optional[tuple]]" = queue.Queue()
        self._read_conn = None
        self._read_lock = threading.Lock()
        if self.path != ":memory:":
            init_db(self.path)
        self._thread = threading.Thread(target=self._writer, name="mission-archive", daemon=True)
        self._ready = threading.Event()
        self._thread.start()
        self._ready.wait(5)

    # ── wiring ────────────────────────────────────────────────────────────────
    def attach(self, state) -> "MissionArchive":
        if self.handle not in state.listeners:
            state.listeners.append(self.handle)
        return self

    def handle(self, kind: str, payload: dict):
        self._queue.put((kind, dict(payload)))

    def flush(self, timeout: float = 5.0):
        done = threading.Event()
        self._queue.put(("__flush__", {"event": done}))
        done.wait(timeout)

    def close(self):
        self.flush()
        self._queue.put(None)
        self._thread.join(timeout=5)

    # ── writer thread ─────────────────────────────────────────────────────────
    def _writer(self):
        conn = _connect(self.path)
        for statement in SCHEMA:
            conn.execute(statement)
        conn.commit()
        self._write_conn = conn
        if self.path == ":memory:":
            self._read_conn = conn
        self._ready.set()
        while True:
            item = self._queue.get()
            if item is None:
                break
            kind, payload = item
            try:
                if kind == "__flush__":
                    payload["event"].set()
                    continue
                with self._read_lock:
                    if kind == "maneuver":
                        self._write_maneuver(conn, payload)
                    elif kind == "event":
                        self._write_event(conn, payload)
                    elif kind == "pending_maneuver":
                        self._write_pending(conn, payload)
                    conn.commit()
            except Exception:
                # A single malformed payload must never kill this thread: doing so
                # silently stops all future persistence, leaks the input queue
                # (handle() keeps enqueueing forever), and hangs flush()/every
                # archive read for its full timeout from then on.
                logger.exception("Mission archive: dropping unwritable %s payload", kind)
                conn.rollback()
        conn.close()

    @staticmethod
    def _write_pending(conn, p: dict):
        conn.execute('''
            INSERT OR REPLACE INTO pending_maneuvers (burn_id, ts, sat_id, dvx, dvy, dvz)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (p.get("burn_id"), p.get("ts"), p.get("sat_id"), p.get("dvx"), p.get("dvy"), p.get("dvz")))

    _TERMINAL_STATUSES = ("executed", "rejected", "cancelled")

    @classmethod
    def _write_maneuver(cls, conn, m: dict):
        dv = m.get("deltaV_vector") or {}
        conn.execute('''
            INSERT OR REPLACE INTO maneuver_history
            (burn_id, satellite_id, burnTime, dvx, dvy, dvz, status, maneuver_type, delta_v_mps, fuel_kg, lat, lon, reason, actor, recorded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (m.get("burn_id"), m.get("satellite_id"), m.get("burnTime"), dv.get("x"), dv.get("y"), dv.get("z"),
              m.get("status"), m.get("maneuver_type"), m.get("delta_v_magnitude"), m.get("fuel_consumed_kg"),
              m.get("lat"), m.get("lon"), m.get("reason"), m.get("actor"), datetime.now(timezone.utc).isoformat()))
        if m.get("status") in cls._TERMINAL_STATUSES:
            # The burn reached a terminal outcome - it's no longer "pending" for reconciliation.
            conn.execute("DELETE FROM pending_maneuvers WHERE burn_id = ?", (m.get("burn_id"),))

    def _write_event(self, conn, e: dict):
        conn.execute('''
            INSERT OR REPLACE INTO events (id, session, sim_time, wall_time, level, category, satellite_id, message, data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (e["id"], self.session, e.get("sim_time"), e.get("wall_time"), e.get("level"), e.get("category"),
              e.get("satellite_id"), e.get("message"), json.dumps(e.get("data") or {}, default=str)))

    # ── queries ───────────────────────────────────────────────────────────────
    def _reader(self) -> sqlite3.Connection:
        if self._read_conn is None:
            self._read_conn = _connect(self.path)
        return self._read_conn

    def maneuvers(self, satellite_id: Optional[str] = None, status: Optional[str] = None, limit: int = 200) -> List[dict]:
        self.flush()
        sql, args = "SELECT * FROM maneuver_history WHERE 1=1", []
        if satellite_id:
            sql += " AND satellite_id = ?"
            args.append(satellite_id)
        if status:
            sql += " AND status = ?"
            args.append(status)
        sql += " ORDER BY recorded_at DESC LIMIT ?"
        args.append(limit)
        with self._read_lock:
            return [dict(r) for r in self._reader().execute(sql, args).fetchall()]

    def reconcile_on_startup(self) -> List[dict]:
        """Returns pending_maneuvers rows with no terminal maneuver_history record - i.e. burns
        that were accepted but whose outcome (executed/rejected/cancelled) was never recorded,
        most likely because the process crashed between the two. Full simulation state (position,
        fuel, etc.) can't be reconstructed from SQLite alone, so these need manual/operator review
        rather than automatic replay."""
        self.flush()
        with self._read_lock:
            rows = self._reader().execute('''
                SELECT p.* FROM pending_maneuvers p
                WHERE NOT EXISTS (
                    SELECT 1 FROM maneuver_history h
                    WHERE h.burn_id = p.burn_id AND h.status IN ('executed', 'rejected', 'cancelled')
                )
            ''').fetchall()
        orphans = [dict(r) for r in rows]
        if orphans:
            logger.warning(
                "Mission archive: %d pending maneuver(s) have no recorded outcome "
                "(likely an ungraceful shutdown) and need operator review: %s",
                len(orphans), [o["burn_id"] for o in orphans],
            )
        return orphans

    def events(self, level: Optional[str] = None, satellite_id: Optional[str] = None, limit: int = 200) -> List[dict]:
        self.flush()
        sql, args = "SELECT * FROM events WHERE 1=1", []
        if level:
            sql += " AND level = ?"
            args.append(level)
        if satellite_id:
            sql += " AND satellite_id = ?"
            args.append(satellite_id)
        sql += " ORDER BY wall_time DESC, id DESC LIMIT ?"
        args.append(limit)
        with self._read_lock:
            rows = [dict(r) for r in self._reader().execute(sql, args).fetchall()]
        for r in rows:
            r["data"] = json.loads(r["data"] or "{}")
        return rows


def archive_enabled() -> bool:
    return os.environ.get("ACM_ARCHIVE", "1").strip().lower() not in ("0", "false", "off", "no")
