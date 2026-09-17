"""
state.py
--------
The unified Zero-Copy memory manager for the Autonomous Constellation Manager.
Maintains contiguous NumPy arrays for the physics engine to mutate in-place, plus the
operational layer on top: conjunction registry (CDMs), event feed, station-keeping and
mission metrics.
"""

import asyncio
import logging
import math
from collections import deque
from datetime import datetime, timezone
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np

from satellite_api.acm.conjunctions import CDMRegistry
from satellite_api.config import CONFIG
from satellite_api.coordinates import convert_states_to_lla
from satellite_api.physics_engine import process_conjunctions, propagate_states
from satellite_api.timeutils import iso_z, parse_iso_utc

# ============================================================================
# ORBITAL & SPACECRAFT CONSTANTS (EXACT NSH 2026 VALUES; runtime values in config.CONFIG)
# ============================================================================
MU_EARTH = 398600.4418
R_EARTH = 6378.137
I_SP = 300.0
G0 = 9.80665
INITIAL_FUEL = 50.0         # kg
DRY_MASS = 500.0            # kg
COOLDOWN_LIMIT = 600.0      # seconds
STATION_KEEPING_RADIUS_KM = 10.0
COLLISION_THRESHOLD_KM = 0.100

INITIAL_SAT_CAPACITY = 100
INITIAL_DEBRIS_CAPACITY = 15000
MAX_HISTORY = 5000
MAX_EVENTS = 1000
EVASION_TYPES = {"PHASING_PROGRADE", "PHASING_RETROGRADE", "RADIAL_SHUNT"}

logger = logging.getLogger(__name__)

# Queue entry: (burn_ts, sat_id, dvx, dvy, dvz, burn_id, maneuver_type, actor)
Maneuver = Tuple[float, str, float, float, float, str, str, str]


def _unpack_maneuver(maneuver: tuple) -> Maneuver:
    if len(maneuver) >= 6:
        burn_ts, sat_id, dvx, dvy, dvz, burn_id = maneuver[:6]
    else:
        burn_ts, sat_id, dvx, dvy, dvz = maneuver
        burn_id = f"PENDING_{sat_id}_{int(burn_ts)}"
    maneuver_type = maneuver[6] if len(maneuver) >= 7 else "EXTERNAL"
    # Older/short queue tuples (pre-actor-tracking, or the low-level test helper) have no
    # actor - "unknown" rather than a fabricated identity.
    actor = maneuver[7] if len(maneuver) >= 8 else "unknown"
    return float(burn_ts), sat_id, float(dvx), float(dvy), float(dvz), burn_id, maneuver_type, actor


def fuel_for_burn(dv_mps: float, wet_mass_kg: float) -> float:
    """Tsiolkovsky propellant mass for an impulsive burn."""
    return wet_mass_kg * (1.0 - math.exp(-abs(dv_mps) / (I_SP * G0)))


def _grow(arr: np.ndarray, new_len: int, fill) -> np.ndarray:
    shape = (new_len,) + arr.shape[1:]
    out = np.full(shape, fill, dtype=arr.dtype)
    out[:arr.shape[0]] = arr
    return out


class StateManager:
    _instance = None

    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            import os
            import sys
            if int(os.environ.get("UVICORN_WORKERS", 1) or 1) > 1:
                print(f"⚠️ Warning: Running with multiple workers (UVICORN_WORKERS={os.environ['UVICORN_WORKERS']}) "
                      "- state will be duplicated!", file=sys.stderr)
            inst = super(StateManager, cls).__new__(cls)
            inst._reset()
            cls._instance = inst
        return cls._instance

    def _reset(self):
        self._lock: Optional[asyncio.Lock] = None
        self._lock_loop = None

        # ── 1. Kinematic State Buffers (ECI Frame: x,y,z,vx,vy,vz) ─────────
        self.sat_buffer = np.zeros((INITIAL_SAT_CAPACITY, 6), dtype=np.float64)
        self.nominal_buffer = np.zeros((INITIAL_SAT_CAPACITY, 6), dtype=np.float64)
        self.debris_buffer = np.zeros((INITIAL_DEBRIS_CAPACITY, 6), dtype=np.float64)

        # ── 2. Constraint Tracking Arrays (1D) ─────────────────────────────
        self.sat_fuel = np.full((INITIAL_SAT_CAPACITY,), INITIAL_FUEL, dtype=np.float64)
        self.sat_cooldown_timers = np.zeros((INITIAL_SAT_CAPACITY,), dtype=np.float64)
        self.sat_outside_box = np.zeros((INITIAL_SAT_CAPACITY,), dtype=bool)
        self.sat_fuel_alert = np.zeros((INITIAL_SAT_CAPACITY,), dtype=np.int8)  # 0 ok, 1 low, 2 EOL

        # ── 3. Bi-Directional ID Mapping ───────────────────────────────────
        self.sat_id_to_idx: Dict[str, int] = {}
        self.idx_to_sat_id: Dict[int, str] = {}
        self.debris_id_to_idx: Dict[str, int] = {}
        self.idx_to_debris_id: Dict[int, str] = {}

        # ── 4. Temporal Maneuver Queue ─────────────────────────────────────
        self.maneuver_queue: List[Maneuver] = []
        self.maneuver_history: List[dict] = []

        # ── 5. State Metrics ───────────────────────────────────────────────
        self.sat_count = 0
        self.debris_count = 0
        self.active_cdm_warnings = 0
        self.total_collisions = 0
        self.is_initialized = False
        self.current_time: Optional[datetime] = None
        self.last_telemetry_ts = float("-inf")

        # ── 6. Operations layer ────────────────────────────────────────────
        self.cdms = CDMRegistry()
        self.events: deque = deque(maxlen=MAX_EVENTS)
        self.event_seq = 0
        self.listeners: List[Callable[[str, dict], None]] = []   # persistence hooks (db.py, state_redis.py)
        self.collision_log: deque = deque(maxlen=500)            # (ts, sat_id, object_id)
        self.telemetry_version = 0
        self.burn_version = 0
        self.last_screen: Optional[dict] = None
        self.sat_modes: Dict[str, dict] = {}                     # sat_id -> {"mode", "until_ts"}
        self.eol_satellites: set = set()
        self.sk_in_box_sat_seconds = 0.0
        self.sk_total_sat_seconds = 0.0
        self.total_fuel_used_kg = 0.0
        self.avoidance_burns_executed = 0
        self.burns_executed = 0
        self.burns_rejected = 0
        self.sim_seconds_elapsed = 0.0
        # Pairs of object IDs that are physically attached (e.g. vehicles docked to a station): never
        # reported as collisions or conjunctions. Maintained by realworld.live for catalog objects.
        self.attached_pairs: set = set()

    def is_attached(self, id_a: str, id_b: str) -> bool:
        return bool(self.attached_pairs) and frozenset((id_a, id_b)) in self.attached_pairs

    def clear_objects(self):
        """Removes every tracked object and resets mission counters, keeping the event log, persistence
        listeners and the lock (used when a new catalog replaces the current one). Caller holds the lock."""
        kept = (self._lock, self._lock_loop, self.listeners, self.events, self.event_seq)
        self._reset()
        self._lock, self._lock_loop, self.listeners, self.events, self.event_seq = kept

    @property
    def lock(self) -> asyncio.Lock:
        # asyncio.Lock binds to the running loop; recreate it if the loop changed
        # (e.g. a fresh event loop per test).
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if self._lock is None or (loop is not None and self._lock_loop is not loop):
            self._lock = asyncio.Lock()
            self._lock_loop = loop
        return self._lock

    @property
    def now_ts(self) -> float:
        return self.current_time.timestamp() if self.current_time else 0.0

    # ========================================================================
    # EVENTS
    # ========================================================================
    def emit(self, level: str, category: str, message: str, satellite_id: Optional[str] = None, **data) -> dict:
        """Appends an operator-facing event. level: info | ok | warn | crit."""
        self.event_seq += 1
        event = {
            "id": self.event_seq,
            "sim_time": iso_z(self.current_time) if self.current_time else None,
            "wall_time": iso_z(datetime.now(timezone.utc)),
            "level": level,
            "category": category,
            "message": message,
            "satellite_id": satellite_id,
            "data": data,
        }
        self.events.append(event)
        self._notify("event", event)
        return event

    def notify_pending_maneuver(self, ts: float, sat_id: str, dvx: float, dvy: float, dvz: float, burn_id: str):
        """Records a burn the instant it's queued (before execution) - so a crash between
        'accepted' and 'executed' still leaves a durable trace for reconciliation on restart."""
        self._notify("pending_maneuver", {"ts": ts, "sat_id": sat_id, "dvx": dvx, "dvy": dvy, "dvz": dvz,
                                           "burn_id": burn_id})

    def _notify(self, kind: str, payload: dict):
        for listener in self.listeners:
            try:
                listener(kind, payload)
            except Exception as e:  # persistence must never break the simulation
                logger.warning(f"State listener failed for {kind}: {e}")

    def events_after(self, after_id: int = 0, limit: int = 200) -> List[dict]:
        items = [e for e in self.events if e["id"] > after_id]
        return items[-limit:]

    # ========================================================================
    # TELEMETRY & MEMORY MANAGEMENT
    # ========================================================================
    def _ensure_sat_capacity(self, needed: int):
        cap = self.sat_buffer.shape[0]
        if needed <= cap:
            return
        new_size = max(needed, cap * 2)
        self.sat_buffer = _grow(self.sat_buffer, new_size, 0.0)
        self.nominal_buffer = _grow(self.nominal_buffer, new_size, 0.0)
        self.sat_fuel = _grow(self.sat_fuel, new_size, CONFIG.initialFuel)
        self.sat_cooldown_timers = _grow(self.sat_cooldown_timers, new_size, 0.0)
        self.sat_outside_box = _grow(self.sat_outside_box, new_size, False)
        self.sat_fuel_alert = _grow(self.sat_fuel_alert, new_size, 0)

    def _ensure_debris_capacity(self, needed: int):
        cap = self.debris_buffer.shape[0]
        if needed <= cap:
            return
        self.debris_buffer = _grow(self.debris_buffer, max(needed, cap * 2), 0.0)

    async def update_telemetry_raw(self, sat_data: list, debris_data: list,
                                   sat_ids: list, debris_ids: list, timestamp_str: str):
        """Upserts objects by ID.

        Known objects get their state vectors overwritten (fuel, cooldown and the
        nominal slot are preserved); new objects are appended. New satellites get
        their nominal "ghost" slot initialised from their first reported state.
        """
        async with self.lock:
            self.current_time = parse_iso_utc(timestamp_str)
            new_sats = new_debris = 0

            if sat_ids:
                vecs = np.asarray(sat_data, dtype=np.float64).reshape(-1, 6)
                idxs, new_rows = self._assign_indices(sat_ids, self.sat_id_to_idx, self.idx_to_sat_id, "sat_count")
                self._ensure_sat_capacity(self.sat_count)
                self.sat_buffer[idxs] = vecs
                if new_rows:
                    new_idx = idxs[new_rows]
                    self.nominal_buffer[new_idx] = vecs[new_rows]
                    self.sat_fuel[new_idx] = CONFIG.initialFuel
                    self.sat_cooldown_timers[new_idx] = 0.0
                    self.sat_outside_box[new_idx] = False
                    self.sat_fuel_alert[new_idx] = 0
                    new_sats = len(new_rows)

            if debris_ids:
                vecs = np.asarray(debris_data, dtype=np.float64).reshape(-1, 6)
                idxs, new_rows = self._assign_indices(debris_ids, self.debris_id_to_idx, self.idx_to_debris_id, "debris_count")
                self._ensure_debris_capacity(self.debris_count)
                self.debris_buffer[idxs] = vecs
                new_debris = len(new_rows)

            self.is_initialized = True
            self.telemetry_version += 1
            if new_sats or new_debris:
                self.emit("info", "telemetry", f"Telemetry ingested: {new_sats} new satellites, "
                          f"{new_debris} new objects ({self.sat_count} satellites, {self.debris_count} debris tracked)")

    def _assign_indices(self, ids: list, id_to_idx: Dict[str, int], idx_to_id: Dict[int, str],
                        count_attr: str) -> Tuple[np.ndarray, List[int]]:
        """Maps IDs to buffer rows, allocating rows for unseen IDs.

        Returns (row index per input, positions in the input that were new).
        If an ID repeats within one packet, the last occurrence wins.
        """
        count = getattr(self, count_attr)
        idxs = np.empty(len(ids), dtype=np.int64)
        new_rows = []
        for pos, obj_id in enumerate(ids):
            idx = id_to_idx.get(obj_id)
            if idx is None:
                idx = count
                id_to_idx[obj_id] = idx
                idx_to_id[idx] = obj_id
                count += 1
                new_rows.append(pos)
            idxs[pos] = idx
        setattr(self, count_attr, count)
        return idxs, new_rows

    async def get_state_buffers(self) -> Tuple[np.ndarray, np.ndarray]:
        async with self.lock:
            if not self.is_initialized:
                return np.empty((0, 6)), np.empty((0, 6))
            return (
                self.sat_buffer[:self.sat_count],
                self.debris_buffer[:self.debris_count]
            )

    async def commit_state_buffers(self, updated_sat: np.ndarray, updated_debris: np.ndarray):
        async with self.lock:
            self.sat_buffer[:self.sat_count] = updated_sat
            self.debris_buffer[:self.debris_count] = updated_debris

    # ========================================================================
    # SIMULATION STEP
    # ========================================================================
    def _advance_clock_and_ghosts(self, dt_seconds: float):
        """Advances time, cooldowns and nominal ghost slots (same J2 model as the engine)."""
        n = self.sat_count
        if self.current_time is not None:
            self.current_time = datetime.fromtimestamp(self.current_time.timestamp() + dt_seconds, tz=timezone.utc)
        self.sat_cooldown_timers[:n] = np.maximum(0.0, self.sat_cooldown_timers[:n] - dt_seconds)
        propagate_states(self.nominal_buffer[:n], dt_seconds)
        self.sim_seconds_elapsed += dt_seconds

    def drift_km(self) -> np.ndarray:
        n = self.sat_count
        return np.linalg.norm(self.sat_buffer[:n, :3] - self.nominal_buffer[:n, :3], axis=1)

    def _update_station_keeping(self, dt_seconds: float):
        """Time-weighted uptime accounting and box exit/return alerts."""
        n = self.sat_count
        if n == 0:
            return
        inside = self.drift_km() <= CONFIG.stationKeepingRadius
        self.sk_in_box_sat_seconds += float(inside.sum()) * dt_seconds
        self.sk_total_sat_seconds += n * dt_seconds
        outside = ~inside
        changed = np.nonzero(outside != self.sat_outside_box[:n])[0]
        for i in changed:
            sid = self.idx_to_sat_id[int(i)]
            if sid in self.eol_satellites:
                continue
            if outside[i]:
                self.emit("warn", "station_keeping", f"Left its {CONFIG.stationKeepingRadius:g} km station-keeping box",
                          satellite_id=sid)
            else:
                self.emit("ok", "station_keeping", "Returned to its station-keeping box", satellite_id=sid)
        self.sat_outside_box[:n] = outside

    async def advance_simulation_time(self, dt_seconds: float):
        """Ticks the clock, cooldowns and ghost slots forward without moving real objects."""
        async with self.lock:
            if not self.is_initialized:
                return
            self._advance_clock_and_ghosts(dt_seconds)

    async def run_simulation_step(self, step_seconds: float,
                                  engine: Callable = process_conjunctions) -> Tuple[int, int]:
        """Advances the whole simulation by `step_seconds`.

        The interval is split at scheduled burn times so that every burn is applied
        at (or immediately after) its commanded epoch, even when several burns fall
        inside one long step. Returns (collisions_detected, maneuvers_executed).
        """
        async with self.lock:
            if not self.is_initialized or self.current_time is None:
                return 0, 0

            t = self.current_time.timestamp()
            target = t + step_seconds
            executed = self._execute_due_maneuvers(t)
            collision_pairs = set()

            while t < target - 1e-9:
                next_t = min((m[0] for m in self.maneuver_queue if t < m[0] < target), default=target)
                dt = next_t - t
                sat_view = self.sat_buffer[:self.sat_count]
                deb_view = self.debris_buffer[:self.debris_count]
                _, _, collisions = await asyncio.to_thread(
                    engine, sat_view, deb_view, COLLISION_THRESHOLD_KM, dt
                )
                for row in np.asarray(collisions).reshape(-1, 5):
                    key = (int(row[0]), int(row[1]), int(row[2]))
                    event_ts = t + float(row[4])
                    # The same encounter can be reported by adjacent sub-steps when its TCA falls on a boundary.
                    if key in collision_pairs or self.is_attached(*self._pair_ids(key)):
                        continue
                    if not self._recent_collision(key, event_ts):
                        collision_pairs.add(key)
                        self._record_collision(key, event_ts, float(row[3]))
                self._advance_clock_and_ghosts(dt)
                self._update_station_keeping(dt)
                t = next_t
                executed += self._execute_due_maneuvers(t)

            self.total_collisions += len(collision_pairs)
            self.cdms.resolve(t, list(self.collision_log), self.emit)
            self.active_cdm_warnings = len(self.cdms.open())
            return len(collision_pairs), executed

    def _pair_ids(self, key: Tuple[int, int, int]) -> Tuple[str, str]:
        sat_idx, target_idx, is_debris = key
        sat_id = self.idx_to_sat_id.get(sat_idx, f"SAT-{sat_idx}")
        other = (self.idx_to_debris_id if is_debris else self.idx_to_sat_id).get(target_idx, str(target_idx))
        return sat_id, other

    def _recent_collision(self, key: Tuple[int, int, int], ts: float, window_s: float = 120.0) -> bool:
        sat_id, other = self._pair_ids(key)
        return any(sid == sat_id and oid == other and abs(cts - ts) <= window_s for cts, sid, oid in self.collision_log)

    def _record_collision(self, key: Tuple[int, int, int], ts: float, miss_km: float):
        sat_id, other = self._pair_ids(key)
        self.collision_log.append((ts, sat_id, other))
        self.emit("crit", "collision", f"Collision with {other} ({miss_km * 1000:.0f} m)", satellite_id=sat_id,
                  object_id=other, miss_km=miss_km)

    # ========================================================================
    # BURN EXECUTION & COMPLIANCE
    # ========================================================================
    def _record(self, entry: dict):
        self.maneuver_history.append(entry)
        if len(self.maneuver_history) > MAX_HISTORY:
            del self.maneuver_history[:len(self.maneuver_history) - MAX_HISTORY]
        self._notify("maneuver", entry)

    def _maneuver_dict(self, maneuver: Maneuver, status: str, **extra) -> dict:
        burn_ts, sat_id, dvx, dvy, dvz, burn_id, maneuver_type, actor = maneuver
        entry = {
            "burn_id": burn_id,
            "satellite_id": sat_id,
            "burnTime": iso_z(burn_ts),
            "deltaV_vector": {"x": dvx, "y": dvy, "z": dvz},
            "maneuver_type": maneuver_type,
            "duration_seconds": 1,
            "cooldown_start": iso_z(burn_ts),
            "cooldown_end": iso_z(burn_ts + CONFIG.cooldownSeconds),
            "delta_v_magnitude": math.sqrt(dvx ** 2 + dvy ** 2 + dvz ** 2) * 1000.0,
            "fuel_consumed_kg": None,
            "lat": None,
            "lon": None,
            "status": status,
            "actor": actor,
        }
        entry.update(extra)
        return entry

    def _reject_burn(self, maneuver: Maneuver, reason: str):
        self.burns_rejected += 1
        self._record(self._maneuver_dict(maneuver, "rejected", reason=reason))
        self.emit("warn", "maneuver", f"Burn {maneuver[5]} not executed: {reason.replace('_', ' ').lower()}",
                  satellite_id=maneuver[1], burn_id=maneuver[5], reason=reason)

    def _execute_due_maneuvers(self, target_time_ts: float) -> int:
        """Executes queued burns due at or before `target_time_ts`. Caller holds the lock."""
        executed_count = 0
        remaining_queue = []
        self.maneuver_queue.sort(key=lambda m: m[0])

        for raw in self.maneuver_queue:
            maneuver = _unpack_maneuver(raw)
            burn_ts, sat_id, dvx, dvy, dvz, burn_id, maneuver_type, _actor = maneuver
            if burn_ts > target_time_ts + 0.1:
                remaining_queue.append(maneuver)
                continue

            idx = self.sat_id_to_idx.get(sat_id)
            if idx is None:
                logger.warning(f"DROPPED: burn {burn_id} targets unknown satellite {sat_id}")
                self._reject_burn(maneuver, "UNKNOWN_SATELLITE")
                continue

            if self.sat_cooldown_timers[idx] > 0.1:
                logger.warning(f"BLOCKED: {sat_id} attempted burn during cooldown "
                               f"(remaining {self.sat_cooldown_timers[idx]:.1f}s)")
                self._reject_burn(maneuver, "COOLDOWN_ACTIVE")
                continue

            dv_mag_mps = math.sqrt(dvx ** 2 + dvy ** 2 + dvz ** 2) * 1000.0
            required_fuel = fuel_for_burn(dv_mag_mps, CONFIG.dryMass + self.sat_fuel[idx])
            if self.sat_fuel[idx] < required_fuel:
                logger.warning(f"FAILED: {sat_id} insufficient fuel.")
                self._reject_burn(maneuver, "INSUFFICIENT_FUEL")
                continue

            lla = convert_states_to_lla(self.sat_buffer[idx, 0:3].reshape(1, 3), self.current_time)
            lat, lon = lla[0][1], lla[0][2]

            self.sat_buffer[idx, 3] += dvx
            self.sat_buffer[idx, 4] += dvy
            self.sat_buffer[idx, 5] += dvz
            self.sat_fuel[idx] -= required_fuel
            self.sat_cooldown_timers[idx] = CONFIG.cooldownSeconds
            self.total_fuel_used_kg += float(required_fuel)
            self.burns_executed += 1
            if maneuver_type in EVASION_TYPES:
                self.avoidance_burns_executed += 1
            self.burn_version += 1

            self._record(self._maneuver_dict(
                maneuver, "executed",
                fuel_consumed_kg=float(required_fuel), lat=float(lat), lon=float(lon),
            ))
            executed_count += 1
            self.emit("info", "maneuver", f"Burn {burn_id} executed: {dv_mag_mps:.2f} m/s, "
                      f"{required_fuel:.3f} kg used", satellite_id=sat_id, burn_id=burn_id)
            if maneuver_type == "EOL_GRAVEYARD":
                self.eol_satellites.add(sat_id)
                self.sat_modes[sat_id] = {"mode": "GRAVEYARD", "until_ts": float("inf")}
                self.emit("warn", "eol", "End-of-life graveyard burn executed; satellite retired", satellite_id=sat_id)
            self._check_fuel_alert(idx, sat_id)
            logger.info(f"Burn executed on {sat_id} | cost {required_fuel:.4f} kg | "
                        f"fuel remaining {self.sat_fuel[idx]:.2f} kg")

        self.maneuver_queue = remaining_queue
        return executed_count

    def _check_fuel_alert(self, idx: int, sat_id: str):
        fuel = float(self.sat_fuel[idx])
        level = 2 if fuel <= CONFIG.eolFuelThreshold else 1 if fuel <= CONFIG.lowFuelWarning else 0
        if level > self.sat_fuel_alert[idx]:
            if level == 2:
                self.emit("crit", "fuel", f"Propellant at {fuel:.2f} kg — end-of-life threshold reached", satellite_id=sat_id)
            else:
                self.emit("warn", "fuel", f"Low propellant: {fuel:.2f} kg remaining", satellite_id=sat_id)
        self.sat_fuel_alert[idx] = level

    async def execute_pending_maneuvers(self, target_time_ts: float) -> int:
        async with self.lock:
            return self._execute_due_maneuvers(target_time_ts)

    async def add_maneuver(self, maneuver: tuple):
        """Adds a maneuver to the queue. maneuver: (ts, sat_id, dvx, dvy, dvz, burn_id[, maneuver_type[, actor]])"""
        async with self.lock:
            self.maneuver_queue.append(_unpack_maneuver(maneuver))
            self.burn_version += 1

    async def cancel_maneuver(self, burn_id: str, actor: str = "unknown") -> bool:
        """Cancels a pending maneuver by burn_id."""
        async with self.lock:
            cancelled = [m for m in self.maneuver_queue if len(m) >= 6 and m[5] == burn_id]
            if not cancelled:
                return False
            self.maneuver_queue = [m for m in self.maneuver_queue if not (len(m) >= 6 and m[5] == burn_id)]
            self.burn_version += 1
            maneuver = _unpack_maneuver(cancelled[0])
            # Overrides the stored actor with whoever issued *this* cancellation - more useful
            # for a cancelled record than who originally scheduled the (never-executed) burn.
            self._record(self._maneuver_dict(maneuver, "cancelled", actor=actor))
            self.emit("info", "maneuver", f"Burn {burn_id} cancelled by {actor}", satellite_id=maneuver[1],
                      burn_id=burn_id, actor=actor)
            return True

    async def get_all_maneuvers(self) -> List[dict]:
        """Pending maneuvers (soonest first) followed by the execution history."""
        async with self.lock:
            pending = [self._maneuver_dict(_unpack_maneuver(m), "pending")
                       for m in sorted(self.maneuver_queue, key=lambda m: m[0])]
            return pending + list(self.maneuver_history)

    async def calculate_station_keeping_compliance(self) -> dict:
        async with self.lock:
            return self.station_keeping_summary()

    def station_keeping_summary(self) -> dict:
        if not self.is_initialized or self.sat_count == 0:
            return {"uptime_percentage": 0.0, "time_weighted_uptime_percentage": 0.0, "satellites_outside_box": 0}
        inside = self.drift_km() <= CONFIG.stationKeepingRadius
        weighted = (100.0 * self.sk_in_box_sat_seconds / self.sk_total_sat_seconds) if self.sk_total_sat_seconds else 100.0 * inside.mean()
        return {
            "uptime_percentage": round(float(inside.mean() * 100.0), 2),
            "time_weighted_uptime_percentage": round(float(weighted), 2),
            "satellites_outside_box": int((~inside).sum()),
            "box_radius_km": CONFIG.stationKeepingRadius,
        }

    # ========================================================================
    # OPERATIONS VIEWS
    # ========================================================================
    def warning_pairs(self) -> List[dict]:
        return [{
            "cdm_id": c["cdm_id"], "satellite_id": c["satellite_id"], "object_id": c["object_id"],
            "tca": c["tca"], "miss_distance_km": round(c["miss_distance_km"], 4), "risk": c["risk"],
        } for c in self.cdms.open()]

    def satellite_mode(self, sat_id: str) -> str:
        if sat_id in self.eol_satellites:
            return "GRAVEYARD"
        entry = self.sat_modes.get(sat_id)
        if entry and entry["until_ts"] > self.now_ts:
            return entry["mode"]
        if any(m[1] == sat_id for m in self.maneuver_queue):
            return "BURN_QUEUED"
        return "NOMINAL"

    def satellite_details(self) -> List[dict]:
        """Per-satellite operational view (caller holds the lock)."""
        from satellite_api.ground_stations import los_mask
        n = self.sat_count
        if n == 0 or self.current_time is None:
            return []
        lla = convert_states_to_lla(self.sat_buffer[:n], self.current_time, as_array=True)
        radius = np.linalg.norm(self.sat_buffer[:n, :3], axis=1)
        drift = self.drift_km()
        contact = los_mask(self.sat_buffer[:n, :3], self.now_ts)
        threat_by_sat: Dict[str, str] = {}
        for c in self.cdms.open():
            prev = threat_by_sat.get(c["satellite_id"])
            if prev is None or ["WATCH", "WARNING", "CRITICAL"].index(c["risk"]) > ["WATCH", "WARNING", "CRITICAL"].index(prev):
                threat_by_sat[c["satellite_id"]] = c["risk"]
        out = []
        for i in range(n):
            sid = self.idx_to_sat_id[i]
            fuel = float(self.sat_fuel[i])
            out.append({
                "id": sid,
                "lat": round(float(lla[i, 1]), 4),
                "lon": round(float(lla[i, 2]), 4),
                "alt_km": round(float(radius[i] - R_EARTH), 2),
                "fuel_kg": round(fuel, 3),
                "status": "EOL" if fuel <= 0 else ("CRITICAL_FUEL" if fuel <= CONFIG.eolFuelThreshold else "NOMINAL"),
                "mode": self.satellite_mode(sid),
                "drift_km": round(float(drift[i]), 3),
                "in_box": bool(drift[i] <= CONFIG.stationKeepingRadius),
                "cooldown_s": round(float(self.sat_cooldown_timers[i]), 1),
                "in_contact": bool(contact[i]),
                "threat": threat_by_sat.get(sid),
                "queued_burns": sum(1 for m in self.maneuver_queue if m[1] == sid),
            })
        return out

    def metrics(self) -> dict:
        counts = self.cdms.counts()
        sk = self.station_keeping_summary()
        avoided = counts["avoided"]
        return {
            "sim_time": iso_z(self.current_time) if self.current_time else None,
            "sim_seconds_elapsed": round(self.sim_seconds_elapsed, 1),
            "satellites": self.sat_count,
            "debris": self.debris_count,
            "collisions_detected": self.total_collisions,
            "collisions_avoided": avoided,
            "conjunctions": counts,
            "burns_executed": self.burns_executed,
            "burns_rejected": self.burns_rejected,
            "avoidance_burns_executed": self.avoidance_burns_executed,
            "fuel_used_kg": round(self.total_fuel_used_kg, 4),
            "fuel_per_avoidance_kg": round(self.total_fuel_used_kg / avoided, 4) if avoided else None,
            "fleet_fuel_remaining_kg": round(float(self.sat_fuel[:self.sat_count].sum()), 3),
            "station_keeping": sk,
            "eol_satellites": len(self.eol_satellites),
            "last_screen": self.last_screen,
        }

    def is_ready(self) -> bool:
        return self.is_initialized


def get_state() -> StateManager:
    return StateManager()
