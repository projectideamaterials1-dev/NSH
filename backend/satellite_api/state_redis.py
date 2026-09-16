"""
state_redis.py
--------------
Redis-backed state manager.

RedisStateManager is the full in-memory StateManager (same physics, same zero-copy buffers)
plus durable snapshots in Redis: the complete mission state (object vectors, nominal slots,
fuel, cooldowns, maneuver queue/history, CDMs, events and metric counters) is written to a
Redis hash periodically and on shutdown, and restored on startup. A crashed or redeployed
backend therefore resumes the mission where it left off.

Used automatically by main.py when REDIS_URL is set (requires the `redis` package).
"""
import asyncio
import json
import logging
from collections import deque
from datetime import datetime, timezone
from typing import List, Optional, Tuple

import numpy as np

from satellite_api.state import StateManager

logger = logging.getLogger(__name__)

SNAPSHOT_KEY = "acm:state"
SNAPSHOT_VERSION = 1
_COUNTERS = ("total_collisions", "telemetry_version", "burn_version", "sk_in_box_sat_seconds",
             "sk_total_sat_seconds", "total_fuel_used_kg", "avoidance_burns_executed", "burns_executed",
             "burns_rejected", "sim_seconds_elapsed", "event_seq", "last_telemetry_ts")


class RedisStateManager(StateManager):
    _instance = None  # separate singleton from the plain StateManager

    def __init__(self, redis_url: str = "redis://localhost:6379", client=None, key: str = SNAPSHOT_KEY):
        if getattr(self, "_redis_configured", False):
            return
        if client is None:
            try:
                import redis.asyncio as redis
            except ImportError as e:  # pragma: no cover - depends on environment
                raise RuntimeError("REDIS_URL is set but the 'redis' package is not installed "
                                   "(pip install redis)") from e
            client = redis.from_url(redis_url, decode_responses=False)
        self.redis = client
        self.redis_url = redis_url
        self.key = key
        self.lock_key = f"{key}:lock"
        self._autosave_task: Optional[asyncio.Task] = None
        self._last_saved_version: Tuple = ()
        self._redis_configured = True

    # ── distributed lock helpers (kept for multi-process coordination) ───────
    async def acquire_lock(self, timeout: int = 5) -> bool:
        return bool(await self.redis.set(self.lock_key, "locked", nx=True, ex=timeout))

    async def release_lock(self):
        await self.redis.delete(self.lock_key)

    # ── snapshot ──────────────────────────────────────────────────────────────
    def _version(self) -> Tuple:
        return (self.telemetry_version, self.burn_version, self.event_seq,
                self.current_time.timestamp() if self.current_time else None)

    async def save(self, force: bool = False) -> bool:
        async with self.lock:
            if not self.is_initialized:
                return False
            version = self._version()
            if not force and version == self._last_saved_version:
                return False
            n, m = self.sat_count, self.debris_count
            meta = {
                "version": SNAPSHOT_VERSION,
                "saved_at": datetime.now(timezone.utc).isoformat(),
                "current_time": self.current_time.isoformat() if self.current_time else None,
                "sat_ids": [self.idx_to_sat_id[i] for i in range(n)],
                "debris_ids": [self.idx_to_debris_id[i] for i in range(m)],
                "maneuver_queue": [list(q) for q in self.maneuver_queue],
                "maneuver_history": self.maneuver_history[-2000:],
                "cdms": self.cdms.items, "cdm_seq": self.cdms._seq,
                "events": list(self.events)[-300:],
                "collision_log": list(self.collision_log),
                "sat_modes": {k: {**v, "until_ts": v["until_ts"] if v["until_ts"] != float("inf") else None}
                              for k, v in self.sat_modes.items()},
                "eol_satellites": sorted(self.eol_satellites),
                "counters": {k: getattr(self, k) for k in _COUNTERS},
            }
            mapping = {
                "meta": json.dumps(meta, default=str).encode(),
                "sat": self.sat_buffer[:n].tobytes(),
                "nominal": self.nominal_buffer[:n].tobytes(),
                "fuel": self.sat_fuel[:n].tobytes(),
                "cooldown": self.sat_cooldown_timers[:n].tobytes(),
                "outside_box": self.sat_outside_box[:n].astype(np.int8).tobytes(),
                "fuel_alert": self.sat_fuel_alert[:n].tobytes(),
                "debris": self.debris_buffer[:m].tobytes(),
            }
            self._last_saved_version = version
        await self.redis.hset(self.key, mapping=mapping)
        return True

    async def restore(self) -> bool:
        raw = await self.redis.hgetall(self.key)
        if not raw:
            return False
        raw = {(k.decode() if isinstance(k, bytes) else k): v for k, v in raw.items()}
        meta = json.loads(raw["meta"])
        if meta.get("version") != SNAPSHOT_VERSION:
            logger.warning("Ignoring Redis snapshot with incompatible version")
            return False

        def arr(name, dtype, cols=None):
            a = np.frombuffer(raw[name], dtype=dtype).copy()
            return a.reshape(-1, cols) if cols else a

        async with self.lock:
            sat_ids: List[str] = meta["sat_ids"]
            deb_ids: List[str] = meta["debris_ids"]
            n, m = len(sat_ids), len(deb_ids)
            self.sat_count = self.debris_count = 0
            self._ensure_sat_capacity(n)
            self._ensure_debris_capacity(m)
            self.sat_buffer[:n] = arr("sat", np.float64, 6)
            self.nominal_buffer[:n] = arr("nominal", np.float64, 6)
            self.sat_fuel[:n] = arr("fuel", np.float64)
            self.sat_cooldown_timers[:n] = arr("cooldown", np.float64)
            self.sat_outside_box[:n] = arr("outside_box", np.int8).astype(bool)
            self.sat_fuel_alert[:n] = arr("fuel_alert", np.int8)
            self.debris_buffer[:m] = arr("debris", np.float64, 6)
            self.sat_id_to_idx = {s: i for i, s in enumerate(sat_ids)}
            self.idx_to_sat_id = dict(enumerate(sat_ids))
            self.debris_id_to_idx = {d: i for i, d in enumerate(deb_ids)}
            self.idx_to_debris_id = dict(enumerate(deb_ids))
            self.sat_count, self.debris_count = n, m
            self.current_time = datetime.fromisoformat(meta["current_time"]) if meta["current_time"] else None
            self.maneuver_queue = [tuple(q) for q in meta["maneuver_queue"]]
            self.maneuver_history = meta["maneuver_history"]
            self.cdms.items = meta["cdms"]
            self.cdms._seq = meta["cdm_seq"]
            self.events = deque(meta["events"], maxlen=self.events.maxlen)
            self.collision_log = deque([tuple(c) for c in meta["collision_log"]], maxlen=self.collision_log.maxlen)
            self.sat_modes = {k: {**v, "until_ts": v["until_ts"] if v["until_ts"] is not None else float("inf")}
                              for k, v in meta["sat_modes"].items()}
            self.eol_satellites = set(meta["eol_satellites"])
            for k, v in meta["counters"].items():
                setattr(self, k, float("-inf") if v in (None, "-inf") and k == "last_telemetry_ts" else v)
            self.active_cdm_warnings = len(self.cdms.open())
            self.is_initialized = n + m > 0
            self._last_saved_version = self._version()
            self.emit("info", "system", f"Mission state restored from Redis ({n} satellites, {m} debris)")
        return True

    async def clear(self):
        await self.redis.delete(self.key)

    # ── autosave ──────────────────────────────────────────────────────────────
    async def _autosave_loop(self, interval_s: float):
        while True:
            await asyncio.sleep(interval_s)
            try:
                await self.save()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"Redis autosave failed: {e}")

    def start_autosave(self, interval_s: float = 10.0):
        if self._autosave_task is None or self._autosave_task.done():
            self._autosave_task = asyncio.create_task(self._autosave_loop(interval_s))

    async def stop_autosave(self, final_save: bool = True):
        if self._autosave_task:
            self._autosave_task.cancel()
            try:
                await self._autosave_task
            except asyncio.CancelledError:
                pass
            self._autosave_task = None
        if final_save:
            try:
                await self.save(force=True)
            except Exception as e:
                logger.warning(f"Final Redis save failed: {e}")
