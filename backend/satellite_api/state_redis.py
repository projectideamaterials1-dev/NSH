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
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np

from satellite_api.state import StateManager

logger = logging.getLogger(__name__)

# Kinds of state.emit()/listener notifications that warrant an immediate (non-periodic)
# snapshot instead of waiting for the next autosave tick: burn lifecycle changes and
# conjunction (CDM) transitions are exactly the events an operator can't afford to lose
# on an ungraceful restart. Anything else still gets picked up within one autosave interval.
_IMMEDIATE_SAVE_CATEGORIES = {"conjunction", "collision"}

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
        self.leader_key = f"{key}:leader"
        self._leader_token = uuid.uuid4().hex
        self._leader_task: Optional[asyncio.Task] = None
        self.is_leader = False
        self._autosave_task: Optional[asyncio.Task] = None
        self._last_saved_version: Tuple = ()
        # External components (e.g. the autopilot's in-memory planner locks) that need to be
        # captured/restored alongside the core snapshot but live outside StateManager, to avoid
        # this generic state layer importing the ACM planning layer. See register_snapshot_hook().
        self._external_snapshot_hooks: Dict[str, Tuple[Callable[[], dict], Callable[[dict], None]]] = {}
        self.listeners.append(self._on_mutation)
        self._redis_configured = True

    # ── distributed lock helpers (also used for leader election - see is_leader/_leader_loop) ──
    async def acquire_lock(self, timeout: int = 5) -> bool:
        return bool(await self.redis.set(self.lock_key, "locked", nx=True, ex=timeout))

    async def release_lock(self):
        await self.redis.delete(self.lock_key)

    # ── leader election ───────────────────────────────────────────────────────
    # Running >1 replica against the same Redis is only safe if exactly one of them runs the
    # autopilot/screening background loops (see main.py); every other replica must serve
    # reads only. This is a Redis lock with a per-instance token, not a full consensus
    # protocol (no Raft/Paxos, no fencing tokens on writes) - it's "good enough" leader
    # election for a single-Redis deployment, not a guarantee against every partition scenario.
    @staticmethod
    def _decode(value) -> Optional[str]:
        if value is None:
            return None
        return value.decode() if isinstance(value, bytes) else value

    async def _try_acquire_leadership(self, ttl_s: int) -> bool:
        return bool(await self.redis.set(self.leader_key, self._leader_token, nx=True, ex=ttl_s))

    async def _renew_leadership(self, ttl_s: int) -> bool:
        current = self._decode(await self.redis.get(self.leader_key))
        if current is None:
            return await self._try_acquire_leadership(ttl_s)
        if current != self._leader_token:
            return False
        await self.redis.set(self.leader_key, self._leader_token, ex=ttl_s)
        return True

    async def _leader_loop(self, ttl_s: float, interval_s: float, on_gain, on_lose):
        while True:
            try:
                was_leader = self.is_leader
                gained = await (self._renew_leadership(int(ttl_s)) if was_leader
                                else self._try_acquire_leadership(int(ttl_s)))
                self.is_leader = gained
                if gained and not was_leader:
                    logger.info(f"Acquired leader lock ({self.leader_key}); starting autopilot loops")
                    if on_gain is not None:
                        await on_gain()
                elif not gained and was_leader:
                    logger.warning(f"Lost leader lock ({self.leader_key}); stopping autopilot loops")
                    if on_lose is not None:
                        await on_lose()
                if not gained:
                    # Only the leader advances the simulation and writes to Redis; a follower
                    # must keep re-pulling that snapshot or its reads would freeze at whatever
                    # it last saw (its own one-time startup restore) instead of tracking the
                    # live mission.
                    try:
                        await self.restore(quiet=True)
                    except Exception as e:
                        logger.warning(f"Follower resync from Redis failed: {e}")
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"Leader election tick failed: {e}")
                if self.is_leader and on_lose is not None:
                    try:
                        await on_lose()
                    except Exception:
                        logger.exception("on_lose callback failed while handling a leader-election error")
                self.is_leader = False
            await asyncio.sleep(interval_s)

    def start_leader_election(self, ttl_s: float = 15.0, interval_s: float = 5.0,
                              on_gain: Optional[Callable] = None, on_lose: Optional[Callable] = None):
        """on_gain/on_lose are optional async callbacks invoked on leadership transitions,
        e.g. to start/stop the autopilot and real-world tracking background loops."""
        if self._leader_task is None or self._leader_task.done():
            self._leader_task = asyncio.create_task(self._leader_loop(ttl_s, interval_s, on_gain, on_lose))

    async def stop_leader_election(self):
        if self._leader_task:
            self._leader_task.cancel()
            try:
                await self._leader_task
            except asyncio.CancelledError:
                pass
            self._leader_task = None
        if self.is_leader:
            current = self._decode(await self.redis.get(self.leader_key))
            if current == self._leader_token:
                await self.redis.delete(self.leader_key)
        self.is_leader = False

    def register_snapshot_hook(self, name: str, snapshot_fn: Callable[[], dict], restore_fn: Callable[[dict], None]):
        """Registers an external component's state to be included in save()/restore().

        `snapshot_fn()` must return a JSON-serializable dict; `restore_fn(payload)` is called
        with that same dict (or not called at all if no snapshot for `name` exists yet).
        """
        self._external_snapshot_hooks[name] = (snapshot_fn, restore_fn)

    def _on_mutation(self, kind: str, payload: dict):
        """Listener callback (state.py's generic persistence hook): triggers an out-of-band
        snapshot for state changes that shouldn't wait for the next periodic autosave."""
        if kind == "maneuver" or (kind == "event" and payload.get("category") in _IMMEDIATE_SAVE_CATEGORIES):
            try:
                asyncio.get_running_loop()
            except RuntimeError:
                return  # no event loop available (e.g. during interpreter shutdown)
            asyncio.create_task(self._immediate_save())

    async def _immediate_save(self):
        try:
            await self.save()
        except Exception as e:
            logger.warning(f"Immediate Redis save failed: {e}")

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
                "attached_pairs": [sorted(pair) for pair in self.attached_pairs],
                "counters": {k: getattr(self, k) for k in _COUNTERS},
                "external": {name: snap_fn() for name, (snap_fn, _) in self._external_snapshot_hooks.items()},
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

    async def restore(self, quiet: bool = False) -> bool:
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
            self.attached_pairs = {frozenset(pair) for pair in meta.get("attached_pairs", [])}
            for k, v in meta["counters"].items():
                setattr(self, k, float("-inf") if v in (None, "-inf") and k == "last_telemetry_ts" else v)
            self.active_cdm_warnings = len(self.cdms.open())
            self.is_initialized = n + m > 0
            self._last_saved_version = self._version()
            external = meta.get("external", {})
            for name, (_, restore_fn) in self._external_snapshot_hooks.items():
                if name in external:
                    try:
                        restore_fn(external[name])
                    except Exception as e:
                        logger.warning(f"Restoring external snapshot '{name}' failed: {e}")
            if not quiet:
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
