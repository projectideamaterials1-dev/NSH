"""
realworld/live.py
-----------------
RealWorldService: loads real satellites and tracked objects from the CelesTrak catalog into the
engine and, in live mode, keeps the simulation clock locked to real UTC.

Live mode loop (every TICK_S of wall time):
  * the simulation is stepped forward to "now" with the normal engine step (RK4 + J2, continuous
    collision detection, queued burns executed on time), so the autopilot and burn planner work
    exactly as in simulation mode;
  * every RESYNC_S the objects are re-anchored to SGP4 at the current time: all tracked objects, and
    every satellite that has not manoeuvred since it was last anchored (its nominal station-keeping
    slot is reset too). Satellites that have burned keep their simulated orbit;
  * every catalog.CACHE_TTL_S the element sets are re-fetched from CelesTrak and re-anchored;
  * if the clock is more than MAX_CATCHUP_S behind (e.g. the backend was busy or live mode was just
    switched on), objects are re-anchored at "now" instead of integrating the gap.
"""
import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional

import numpy as np

from sgp4.api import SatrecArray, jday

from satellite_api.acm.conjunctions import _approach_angle_deg
from satellite_api.physics_engine import propagate_states
from satellite_api.realworld import catalog
from satellite_api.realworld.catalog import CatalogError, CatalogObject
from satellite_api.timeutils import iso_z

logger = logging.getLogger(__name__)

TICK_S = 1.0
RESYNC_S = 300.0
MAX_CATCHUP_S = 900.0
MAX_SATELLITES = 500
MAX_OBJECTS = 20000


REFINE_HALF_WINDOW_S = 150.0
ATTACHED_KM = 0.5            # objects this close with ...
ATTACHED_REL_KMS = 0.002     # ... this little relative velocity are docked / berthed, not colliding


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Sgp4Refiner:
    """Recomputes screened conjunctions with SGP4 when both objects fly their published orbits.

    The engine screens with RK4 + J2 only, which drifts from SGP4 by ~0.4 km (median) after 1 h and
    ~1-5 km after 3 h in LEO (drag). The coarse screen therefore runs with a radius widened by
    `margin_km(horizon)`, and each candidate's TCA, miss distance and relative velocity are then
    recomputed from the element sets and filtered at the real warning radius.
    """

    def __init__(self, service: "RealWorldService"):
        self.service = service

    @staticmethod
    def margin_km(horizon_s: float) -> float:
        return min(15.0, 3.0 * horizon_s / 3600.0)

    def snapshot(self) -> dict:
        """Satrecs of objects that currently follow their element sets. Caller holds the state lock."""
        svc, state = self.service, self.service.state
        return {
            "satellites": {sid: o.satrec for sid, o in svc.fleet.items()
                           if sid in state.sat_id_to_idx and not svc._maneuvered(sid)},
            "objects": {did: o.satrec for did, o in svc.objects.items()},
        }

    @staticmethod
    def refine(predictions: List[dict], snapshot: dict, warning_km: float) -> List[dict]:
        offsets = np.arange(-REFINE_HALF_WINDOW_S, REFINE_HALF_WINDOW_S + 0.5, 1.0)
        out = []
        for p in predictions:
            sat = snapshot["satellites"].get(p["satellite_id"])
            other = (snapshot["objects"] if p["object_type"] == "DEBRIS" else snapshot["satellites"]).get(p["object_id"])
            if sat is None or other is None:
                if p["miss_distance_km"] <= warning_km:
                    out.append({**p, "propagator": "J2"})
                continue
            when = datetime.fromtimestamp(p["tca_ts"], tz=timezone.utc)
            jd0, fr0 = jday(when.year, when.month, when.day, when.hour, when.minute, when.second + when.microsecond / 1e6)
            fr = fr0 + offsets / 86400.0
            err, r, v = SatrecArray([sat, other]).sgp4(np.full(len(offsets), jd0), fr)
            if err.any():
                if p["miss_distance_km"] <= warning_km:
                    out.append({**p, "propagator": "J2"})
                continue
            rel = r[1] - r[0]
            seg = rel[1:] - rel[:-1]
            dd = np.einsum("ij,ij->i", seg, seg)
            frac = np.clip(-np.einsum("ij,ij->i", rel[:-1], seg) / np.maximum(dd, 1e-12), 0.0, 1.0)
            dist = np.linalg.norm(rel[:-1] + frac[:, None] * seg, axis=1)
            k = int(np.argmin(dist))
            if k in (0, len(dist) - 1):          # closest approach outside the window: keep the engine result
                if p["miss_distance_km"] <= warning_km:
                    out.append({**p, "propagator": "J2"})
                continue
            if dist[k] > warning_km:
                continue
            j = k + 1 if frac[k] > 0.5 else k
            v_rel = v[1, j] - v[0, j]
            out.append({
                **p,
                "tca_ts": p["tca_ts"] + float(offsets[k] + frac[k]),
                "miss_distance_km": float(dist[k]),
                "relative_velocity_kms": float(np.linalg.norm(v_rel)),
                "approach_angle_deg": _approach_angle_deg(r[0, j], v[0, j], v_rel),
                "propagator": "SGP4",
            })
        return out


class RealWorldService:
    def __init__(self, state):
        self.state = state
        self.live = False
        self.fleet: Dict[str, CatalogObject] = {}      # engine satellite id -> catalog entry
        self.objects: Dict[str, CatalogObject] = {}    # engine debris id -> catalog entry
        self.request: Optional[dict] = None
        self.source_info: Dict[str, dict] = {}
        self.warnings: List[str] = []
        self.loaded_at: Optional[float] = None
        self.last_resync_wall: Optional[float] = None
        self.last_resync_sim: Optional[float] = None
        self.last_refresh_wall: Optional[float] = None
        self.last_error: Optional[str] = None
        self.skipped = {"stale": 0, "propagation": 0, "duplicate": 0}
        self._anchor_fuel: Dict[str, float] = {}
        self._task: Optional[asyncio.Task] = None
        self._load_lock: Optional[asyncio.Lock] = None

    # ── loading ────────────────────────────────────────────────────────────────
    @property
    def _lock(self) -> asyncio.Lock:
        if self._load_lock is None:
            self._load_lock = asyncio.Lock()
        return self._load_lock

    def _fetch(self, request: dict, force: bool) -> tuple:
        """Blocking: resolves the requested sources into (fleet objects, tracked objects)."""
        info, warnings = {}, []

        def resolve(keys: List[str]) -> List[CatalogObject]:
            out = []
            for key in keys:
                try:
                    objs, meta = catalog.fetch_source(key, force)
                    info[key] = {**meta, "count": len(objs)}
                    if meta.get("stale"):
                        warnings.append(f"{catalog.SOURCES[key].label}: CelesTrak unreachable, using cached data from {meta['fetched_at']}")
                    out.extend(objs)
                except CatalogError as e:
                    info[key] = {"error": str(e)}
                    warnings.append(f"{catalog.SOURCES[key].label if key in catalog.SOURCES else key}: {e}")
            return out

        fleet = resolve(request["fleet"])
        if request["norad_ids"]:
            extra, errors = catalog.fetch_norad_ids(request["norad_ids"], force)
            fleet.extend(extra)
            warnings.extend(errors)
        objects = resolve(request["objects"])
        return fleet, objects, info, warnings

    def _select(self, candidates: List[CatalogObject], limit: int, exclude: set, when: datetime):
        """Drops duplicates, stale element sets and objects SGP4 cannot propagate; keeps `limit` (newest first)."""
        seen, fresh = set(exclude), []
        for obj in candidates:
            if obj.norad_id in seen:
                self.skipped["duplicate"] += 1
                continue
            seen.add(obj.norad_id)
            if obj.age_days(when) > catalog.MAX_ELEMENT_AGE_DAYS:
                self.skipped["stale"] += 1
                continue
            fresh.append(obj)
        states, ok = catalog.propagate(fresh, when)
        self.skipped["propagation"] += int((~ok).sum())
        chosen = [(o, s) for o, s, good in zip(fresh, states, ok) if good]
        chosen.sort(key=lambda pair: (-pair[0].epoch.timestamp(), pair[0].norad_id))
        return chosen[:limit], max(0, len(chosen) - limit)

    async def load(self, fleet: List[str], objects: List[str], norad_ids: List[int], max_satellites: int = 60,
                   max_objects: int = 5000, replace: bool = True, live: Optional[bool] = None, force: bool = False,
                   conjunction_service=None) -> dict:
        unknown = [k for k in fleet + objects if k not in catalog.SOURCES]
        if unknown:
            raise ValueError(f"Unknown sources: {unknown}. See GET /api/catalog/sources")
        if not (fleet or norad_ids):
            raise ValueError("Select at least one fleet source or NORAD id")
        request = {"fleet": list(dict.fromkeys(fleet)), "objects": list(dict.fromkeys(objects)),
                   "norad_ids": list(dict.fromkeys(int(n) for n in norad_ids)),
                   "max_satellites": int(min(max_satellites, MAX_SATELLITES)),
                   "max_objects": int(min(max_objects, MAX_OBJECTS)), "replace": replace}
        async with self._lock:
            fleet_objs, tracked_objs, info, warnings = await asyncio.to_thread(self._fetch, request, force)
            state = self.state
            go_live = self.live if live is None else live
            when = _utcnow() if (go_live or replace or not state.is_ready() or state.current_time is None) \
                else state.current_time

            self.skipped = {"stale": 0, "propagation": 0, "duplicate": 0}
            chosen_fleet, dropped_fleet = self._select(fleet_objs, request["max_satellites"], set(), when)
            fleet_norads = {o.norad_id for o, _ in chosen_fleet}
            chosen_objs, dropped_objs = self._select(tracked_objs, request["max_objects"], fleet_norads, when)
            if dropped_fleet:
                warnings.append(f"{dropped_fleet} more satellites available; raise max_satellites to include them")
            if dropped_objs:
                warnings.append(f"{dropped_objs} more tracked objects available; raise max_objects to include them")
            if not chosen_fleet:
                raise CatalogError("No usable satellites: " + ("; ".join(warnings) or "the selected sources are empty"))

            if not replace and state.is_ready() and state.current_time is not None and state.current_time != when:
                await self.resync(when)      # bring the objects already tracked to the new epoch first
            async with state.lock:
                if replace:
                    state.clear_objects()
                    self.fleet, self.objects = {}, {}
                    if conjunction_service is not None:
                        conjunction_service.refiner = Sgp4Refiner(self)
                        conjunction_service.autopilot.reset()
                        conjunction_service._last_sim_ts = None
                        conjunction_service._last_plan_ts = None
                # IDs derive from catalog names, so re-loading the same objects (e.g. after a restart restored
                # the mission from Redis) updates their rows and keeps fuel, burns and history.
                sat_ids = catalog.assign_ids([o for o, _ in chosen_fleet])
                deb_ids = catalog.assign_ids([o for o, _ in chosen_objs])

            await state.update_telemetry_raw(
                [s.tolist() for _, s in chosen_fleet], [s.tolist() for _, s in chosen_objs],
                sat_ids, deb_ids, iso_z(when))

            async with state.lock:
                state.last_telemetry_ts = when.timestamp()
                for sid, (obj, s) in zip(sat_ids, chosen_fleet):
                    self.fleet[sid] = obj
                    idx = state.sat_id_to_idx[sid]
                    state.nominal_buffer[idx] = s            # slot = the published orbit
                for did, (obj, _) in zip(deb_ids, chosen_objs):
                    self.objects[did] = obj
                self._update_attached()
                self._snapshot_fuel()
                self.request, self.source_info, self.warnings = request, info, warnings
                self.loaded_at = self.last_refresh_wall = self.last_resync_wall = time.time()
                self.last_resync_sim = when.timestamp()
                self.last_error = None
                labels = ", ".join(catalog.SOURCES[k].label for k in request["fleet"]) or "NORAD ids"
                attached = f"; {len(state.attached_pairs)} docked/attached pairs excluded from collision checks" \
                    if state.attached_pairs else ""
                state.emit("info", "catalog", f"Loaded {len(chosen_fleet)} real satellites ({labels}) and "
                           f"{len(chosen_objs)} tracked objects from CelesTrak; element sets propagated with SGP4{attached}")
            if conjunction_service is not None and conjunction_service.refiner is None:
                conjunction_service.refiner = Sgp4Refiner(self)
            if go_live != self.live:
                await self.set_live(go_live)
            return self.status()

    # ── live mode ──────────────────────────────────────────────────────────────
    async def set_live(self, enabled: bool):
        state = self.state
        if enabled and not state.is_ready():
            raise ValueError("Load data first (POST /api/catalog/load or /api/telemetry)")
        if enabled == self.live:
            return
        self.live = enabled
        async with state.lock:
            state.emit("info", "live", "Live mode on: simulation clock locked to real UTC" if enabled
                       else "Live mode off: simulation clock paused")
        if enabled:
            await self.resync(_utcnow())

    def _snapshot_fuel(self):
        state = self.state
        self._anchor_fuel = {sid: float(state.sat_fuel[state.sat_id_to_idx[sid]])
                             for sid in self.fleet if sid in state.sat_id_to_idx}

    def _maneuvered(self, sid: str) -> bool:
        state = self.state
        idx = state.sat_id_to_idx[sid]
        return (float(state.sat_fuel[idx]) < self._anchor_fuel.get(sid, float("inf")) - 1e-9
                or sid in state.eol_satellites
                or any(m[1] == sid for m in state.maneuver_queue)
                or state.satellite_mode(sid) not in ("NOMINAL",))

    async def resync(self, when: datetime) -> dict:
        """Re-anchors catalog objects to SGP4 at `when` (moving the clock there if needed)."""
        state = self.state
        async with state.lock:
            if not state.is_ready() or state.current_time is None:
                return {"anchored": 0}
            dt = when.timestamp() - state.now_ts
            sats = [(sid, obj) for sid, obj in self.fleet.items() if sid in state.sat_id_to_idx and not self._maneuvered(sid)]
            debs = [(did, obj) for did, obj in self.objects.items() if did in state.debris_id_to_idx]
            if dt > 1e-6:
                # Rows that are not re-anchored below (manoeuvred satellites, objects from /api/telemetry)
                # follow the engine's J2 model across the gap.
                self._propagate_rows(state.sat_buffer, state.sat_count, {state.sat_id_to_idx[s] for s, _ in sats}, dt)
                self._propagate_rows(state.debris_buffer, state.debris_count, {state.debris_id_to_idx[d] for d, _ in debs}, dt)
                state._advance_clock_and_ghosts(dt)
                state._execute_due_maneuvers(when.timestamp())
            state.current_time = when

            anchored = 0
            if sats:
                vecs, ok = catalog.propagate([o for _, o in sats], when)
                idx = np.array([state.sat_id_to_idx[sid] for sid, _ in sats])
                state.sat_buffer[idx[ok]] = vecs[ok]
                state.nominal_buffer[idx[ok]] = vecs[ok]
                anchored += int(ok.sum())
                if dt > 1e-6 and (~ok).any():
                    # SGP4 failed for these rows (decayed/invalid elements, etc.) -
                    # fall back to the engine's own J2 propagation across the gap
                    # instead of leaving them frozen while the clock moves on.
                    failed = idx[~ok]
                    work = state.sat_buffer[failed].copy()
                    propagate_states(work, dt)
                    state.sat_buffer[failed] = work
            if debs:
                vecs, ok = catalog.propagate([o for _, o in debs], when)
                idx = np.array([state.debris_id_to_idx[did] for did, _ in debs])
                state.debris_buffer[idx[ok]] = vecs[ok]
                anchored += int(ok.sum())
                if dt > 1e-6 and (~ok).any():
                    failed = idx[~ok]
                    work = state.debris_buffer[failed].copy()
                    propagate_states(work, dt)
                    state.debris_buffer[failed] = work
            state.last_telemetry_ts = when.timestamp()
            state.telemetry_version += 1
            self._update_attached()
            self._snapshot_fuel()
            self.last_resync_wall, self.last_resync_sim = time.time(), when.timestamp()
            return {"anchored": anchored, "clock_jump_s": round(dt, 3)}

    def _update_attached(self):
        """Finds catalog objects flying as one body (NORAD gives docked vehicles the station's elements).
        Caller holds the state lock."""
        state = self.state
        n = state.sat_count
        pairs = set()
        if n:
            sats = state.sat_buffer[:n]
            others = [(sats, state.idx_to_sat_id), (state.debris_buffer[:state.debris_count], state.idx_to_debris_id)]
            for i in range(n):
                sid = state.idx_to_sat_id[i]
                if sid not in self.fleet:
                    continue
                for buf, id_map in others:
                    if not len(buf):
                        continue
                    close = np.nonzero((np.linalg.norm(buf[:, :3] - sats[i, :3], axis=1) < ATTACHED_KM)
                                       & (np.linalg.norm(buf[:, 3:] - sats[i, 3:], axis=1) < ATTACHED_REL_KMS))[0]
                    for j in close:
                        other = id_map[int(j)]
                        if other != sid and (other in self.fleet or other in self.objects):
                            pairs.add(frozenset((sid, other)))
        state.attached_pairs = pairs

    @staticmethod
    def _propagate_rows(buffer: np.ndarray, count: int, skip: set, dt: float):
        rows = np.array([i for i in range(count) if i not in skip], dtype=np.int64)
        if len(rows):
            work = buffer[rows].copy()
            propagate_states(work, dt)
            buffer[rows] = work

    async def refresh(self, force: bool = False) -> dict:
        """Re-fetches the element sets of the loaded sources and re-anchors (keeps fuel, burns and history)."""
        if not self.request:
            raise ValueError("Nothing loaded yet")
        fleet_objs, tracked_objs, info, warnings = await asyncio.to_thread(self._fetch, self.request, force)
        by_norad = {o.norad_id: o for o in fleet_objs + tracked_objs}
        async with self._lock:
            updated = 0
            for table in (self.fleet, self.objects):
                for key, old in list(table.items()):
                    new = by_norad.get(old.norad_id)
                    if new is not None and new.epoch >= old.epoch:
                        new.source = old.source
                        table[key] = new
                        updated += new.epoch > old.epoch
            self.source_info, self.warnings = info, warnings
            self.last_refresh_wall = time.time()
        when = _utcnow() if self.live else self.state.current_time
        result = await self.resync(when)
        async with self.state.lock:
            self.state.emit("info", "catalog", f"Element sets refreshed from CelesTrak ({updated} newer)")
        return {**result, "updated": updated}

    async def tick(self):
        state = self.state
        if not self.live or not state.is_ready() or state.current_time is None:
            return
        now = _utcnow()
        lag = now.timestamp() - state.now_ts
        if self.request and self.last_refresh_wall and time.time() - self.last_refresh_wall >= catalog.CACHE_TTL_S:
            await self.refresh()
        elif lag > MAX_CATCHUP_S or lag < -1.0:
            await self.resync(now)
        elif lag >= 0.5:
            await state.run_simulation_step(lag)
            if self.last_resync_sim is None or state.now_ts - self.last_resync_sim >= RESYNC_S:
                await self.resync(state.current_time)

    async def _loop(self):
        while True:
            try:
                await self.tick()
                self.last_error = None
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error(f"Live sync failed: {e}", exc_info=True)
                self.last_error = str(e)
                await asyncio.sleep(5.0)
            await asyncio.sleep(TICK_S)

    def start(self):
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._loop())

    async def stop(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    # ── views ──────────────────────────────────────────────────────────────────
    def status(self) -> dict:
        state = self.state
        now = _utcnow()
        ages = [o.age_days(now) * 24 for o in list(self.fleet.values()) + list(self.objects.values())]
        lag = (now.timestamp() - state.now_ts) if state.current_time is not None else None
        return {
            "live": self.live,
            "loaded": bool(self.request),
            "request": self.request,
            "satellites": len(self.fleet),
            "tracked_objects": len(self.objects),
            "attached_pairs": len(state.attached_pairs),
            "sources": self.source_info,
            "warnings": self.warnings,
            "skipped": self.skipped,
            "element_age_hours": {"median": round(float(np.median(ages)), 1), "max": round(float(max(ages)), 1)} if ages else None,
            "loaded_at": iso_z(self.loaded_at) if self.loaded_at else None,
            "last_resync": iso_z(self.last_resync_wall) if self.last_resync_wall else None,
            "last_refresh": iso_z(self.last_refresh_wall) if self.last_refresh_wall else None,
            "next_refresh": iso_z(self.last_refresh_wall + catalog.CACHE_TTL_S) if self.last_refresh_wall else None,
            "clock_lag_s": round(lag, 2) if lag is not None else None,
            "last_error": self.last_error,
            "propagator": "SGP4 (element sets) + RK4/J2 engine between re-anchors",
            "data_source": "CelesTrak GP (NORAD element sets)",
        }

    def object_info(self, object_id: str) -> Optional[dict]:
        obj = self.fleet.get(object_id) or self.objects.get(object_id)
        if obj is None:
            return None
        info = obj.to_dict()
        info["id"] = object_id
        info["kind"] = "satellite" if object_id in self.fleet else "tracked_object"
        if object_id in self.fleet:
            info["maneuvered_since_anchor"] = self._maneuvered(object_id) if object_id in self.state.sat_id_to_idx else None
        return info


def get_service(app, state) -> RealWorldService:
    service = getattr(app.state, "realworld", None)
    if service is None or service.state is not state:
        if service is not None:
            service.live = False
        service = RealWorldService(state)
        app.state.realworld = service
    return service
