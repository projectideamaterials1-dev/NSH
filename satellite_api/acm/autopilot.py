"""
acm/autopilot.py
----------------
Closed-loop autonomy: screen -> decide -> schedule.

ConjunctionService.run_cycle():
  1. copies the state buffers (under the lock) and screens them for close approaches
     in a worker thread (acm.conjunctions.screen);
  2. merges predictions into the CDM registry (events for new/escalated/cleared threats);
  3. if the autopilot is enabled, plans with AutonomousBrain using the selected avoidance
     plugin (evasion + recovery, station-keeping return, end-of-life graveyard), validates
     every sequence with acm.scheduler and queues accepted burns.
A background task (started by the FastAPI lifespan) runs full cycles whenever simulation time has
advanced by CONFIG.cdmScreenIntervalSeconds or telemetry/burns changed, and in between re-runs the
(cheap) planner every PLAN_INTERVAL_S of simulation time while threats are open, so burns are
uplinked as soon as a threatened satellite enters ground-station contact.
"""
import asyncio
import logging
import time
from collections import defaultdict
from typing import Dict, Optional

from satellite_api.acm.brain import AutonomousBrain, Conjunction
from satellite_api.acm.conjunctions import screen
from satellite_api.acm.plugins import get_plugin
from satellite_api.acm.scheduler import BurnRequest, evaluate_sequence, queue_burns
from satellite_api.config import CONFIG
from satellite_api.ground_stations import brain_stations, has_los
from satellite_api.physics_engine import ENGINE_NAME, process_conjunctions
from satellite_api.timeutils import iso_z

logger = logging.getLogger(__name__)

EVASION_TYPES = ("PHASING_PROGRADE", "PHASING_RETROGRADE", "RADIAL_SHUNT")
PLAN_INTERVAL_S = 20.0          # sim seconds between planner-only passes
REJECT_EVENT_THROTTLE_S = 600.0  # repeat an identical rejection event at most this often (sim seconds)


class Autopilot:
    def __init__(self):
        self.brain = AutonomousBrain()
        self.stations = brain_stations()
        self.last_plan_summary: Dict[str, int] = {}
        self._last_reject: Dict[str, tuple] = {}

    def reset(self):
        self.brain = AutonomousBrain()

    def plan_and_schedule(self, state) -> Dict[str, int]:
        """Runs the planner on the current state and queues validated burns. Caller holds the lock."""
        summary = {"sequences_planned": 0, "sequences_scheduled": 0, "sequences_rejected": 0}
        n = state.sat_count
        if n == 0 or state.current_time is None:
            return summary
        now = state.current_time
        now_ts = now.timestamp()
        plugin = get_plugin(CONFIG.avoidanceStrategy)

        conjunctions = []
        for cdm in state.cdms.open():
            idx = state.sat_id_to_idx.get(cdm["satellite_id"])
            if idx is None or cdm["status"] != "ACTIVE" or cdm["tca_ts"] <= now_ts:
                continue
            conjunctions.append(Conjunction(
                sat_idx=idx, debris_idx=0, tca_seconds=cdm["tca_ts"] - now_ts,
                miss_distance_km=cdm["miss_distance_km"], relative_velocity_kms=cdm["relative_velocity_kms"],
                risk_score=1.0 if cdm["risk"] == "CRITICAL" else 0.5,
            ))

        sat_states = state.sat_buffer[:n].copy()
        nominal = state.nominal_buffer[:n].copy()
        fuels = [float(f) for f in state.sat_fuel[:n]]
        eol_idx = {state.sat_id_to_idx[s] for s in state.eol_satellites if s in state.sat_id_to_idx}
        self.brain.eol_scheduled |= eol_idx

        plans = self.brain.plan_evasion(sat_states, nominal, fuels, conjunctions, now, self.stations,
                                        evasion_mode=plugin.mode)

        # End-of-life: retire satellites at the fuel threshold while they are in contact.
        planned_sats = {p.sat_idx for p in plans}
        for i in range(n):
            if (fuels[i] <= CONFIG.eolFuelThreshold and i not in self.brain.eol_scheduled and i not in planned_sats
                    and has_los(sat_states[i, :3], now_ts)):
                p = self.brain.plan_eol(i, sat_states[i], fuels[i], max_dv_kms=CONFIG.maxDeltaV / 1000.0)
                if p:
                    plans.append(p)

        by_sat = defaultdict(list)
        for p in plans:
            by_sat[p.sat_idx].append(p)

        for idx, seq in by_sat.items():
            sid = state.idx_to_sat_id[idx]
            summary["sequences_planned"] += 1
            burns = []
            for k, p in enumerate(sorted(seq, key=lambda p: p.burn_time_offset_s)):
                dv = p.delta_v_eci_dict
                burns.append(BurnRequest(
                    burn_id=f"AUTO-{sid}-{p.maneuver_type.value}-{int(now_ts + p.burn_time_offset_s)}-{k}",
                    ts=now_ts + p.burn_time_offset_s, dv_kms=(dv["x"], dv["y"], dv["z"]),
                    maneuver_type=p.maneuver_type.value,
                ))
            evaluation = evaluate_sequence(state, sid, burns)
            is_evasion = any(b.maneuver_type in EVASION_TYPES for b in burns)
            is_eol = any(b.maneuver_type == "EOL_GRAVEYARD" for b in burns)
            if evaluation.accepted:
                queue_burns(state, sid, burns, source="autopilot")
                self._last_reject.pop(sid, None)
                summary["sequences_scheduled"] += 1
                end_ts = burns[-1].ts + 1.0
                mode = "GRAVEYARD" if is_eol else ("EVADING" if is_evasion else "RECOVERING")
                state.sat_modes[sid] = {"mode": mode, "until_ts": float("inf") if is_eol else end_ts}
                if is_evasion:
                    linked = state.cdms.link_mitigation(sid, [b.burn_id for b in burns], now_ts)
                    state.emit("ok", "autopilot", f"Avoidance planned ({plugin.name()}): {len(burns)} burns, "
                               f"{evaluation.fuel_needed_kg:.3f} kg", satellite_id=sid, cdm_ids=linked)
                elif is_eol:
                    state.emit("warn", "autopilot", "End-of-life graveyard burn scheduled", satellite_id=sid)
                else:
                    state.emit("info", "autopilot", "Station-keeping return scheduled", satellite_id=sid)
            else:
                summary["sequences_rejected"] += 1
                # Release the planner lock so the next cycle can try again (e.g. after LOS returns).
                self.brain.locked_satellites.pop(idx, None)
                if is_eol:
                    self.brain.eol_scheduled.discard(idx)
                previous = self._last_reject.get(sid)
                if previous is None or previous[0] != evaluation.reason or now_ts - previous[1] >= REJECT_EVENT_THROTTLE_S:
                    self._last_reject[sid] = (evaluation.reason, now_ts)
                    state.emit("warn", "autopilot", f"Planned sequence rejected: {evaluation.reason.replace('_', ' ').lower()}",
                               satellite_id=sid, reason=evaluation.reason)
        self.last_plan_summary = summary
        return summary


class ConjunctionService:
    def __init__(self, state, engine=process_conjunctions):
        self.state = state
        self.engine = engine
        self.autopilot = Autopilot()
        self._task: Optional[asyncio.Task] = None
        self._lock: Optional[asyncio.Lock] = None
        self._lock_loop = None
        self._last_sim_ts = None
        self._last_plan_ts = None
        self._last_versions = (-1, -1)
        self.refiner = None   # realworld.live.Sgp4Refiner once a real catalog is loaded

    @property
    def _cycle_lock(self) -> asyncio.Lock:
        loop = asyncio.get_running_loop()
        if self._lock is None or self._lock_loop is not loop:
            self._lock, self._lock_loop = asyncio.Lock(), loop
        return self._lock

    def default_horizon(self) -> float:
        # The NumPy fallback is ~10x slower than the C++ engine; keep its screens short.
        return CONFIG.cdmHorizonSeconds if ENGINE_NAME == "cpp" else min(CONFIG.cdmHorizonSeconds, 3600.0)

    async def run_cycle(self, horizon_s: Optional[float] = None, plan: Optional[bool] = None) -> dict:
        state = self.state
        async with self._cycle_lock:
            if not state.is_ready() or state.current_time is None or state.sat_count == 0:
                return {"status": "SKIPPED", "reason": "no telemetry"}
            horizon = float(horizon_s or self.default_horizon())
            async with state.lock:
                sats = state.sat_buffer[:state.sat_count].copy()
                debris = state.debris_buffer[:state.debris_count].copy()
                sat_ids = [state.idx_to_sat_id[i] for i in range(state.sat_count)]
                deb_ids = [state.idx_to_debris_id[i] for i in range(state.debris_count)]
                start_ts = state.now_ts
                versions = (state.telemetry_version, state.burn_version)
                refiner = self.refiner
                refine_snapshot = refiner.snapshot() if refiner else None

            t0 = time.perf_counter()
            coarse_km = CONFIG.cdmWarningKm + (refiner.margin_km(horizon) if refiner else 0.0)
            predictions = await asyncio.to_thread(
                screen, sats, debris, sat_ids, deb_ids, start_ts, horizon, coarse_km, self.engine)
            if refiner:
                predictions = await asyncio.to_thread(refiner.refine, predictions, refine_snapshot, CONFIG.cdmWarningKm)
            elapsed = time.perf_counter() - t0
            if state.attached_pairs:
                predictions = [p for p in predictions if not state.is_attached(p["satellite_id"], p["object_id"])]

            async with state.lock:
                stats = state.cdms.apply(predictions, state.now_ts, state.emit)
                state.active_cdm_warnings = len(state.cdms.open())
                do_plan = CONFIG.autopilotEnabled if plan is None else plan
                plan_summary = self.autopilot.plan_and_schedule(state) if do_plan else {}
                if do_plan:
                    self._last_plan_ts = state.now_ts
                state.last_screen = {
                    "screened_at": iso_z(start_ts), "horizon_s": horizon, "warning_km": CONFIG.cdmWarningKm,
                    "duration_s": round(elapsed, 3), "predictions": len(predictions), **stats,
                    "engine": ENGINE_NAME, "autopilot": do_plan, **plan_summary,
                    "propagator": "SGP4 refinement" if refiner else "RK4 + J2",
                }
                self._last_sim_ts = start_ts
                # Versions as of the copy: changes made meanwhile (including burns queued just now)
                # trigger a verification screen on a later cycle.
                self._last_versions = versions
                return {"status": "OK", **state.last_screen}

    def due(self) -> bool:
        state = self.state
        if not state.is_ready() or state.current_time is None or state.sat_count == 0:
            return False
        if self._last_sim_ts is None:
            return True
        advanced = state.now_ts - self._last_sim_ts
        if advanced >= CONFIG.cdmScreenIntervalSeconds or advanced < 0:
            return True
        if state.telemetry_version != self._last_versions[0]:
            return True
        return state.burn_version != self._last_versions[1] and advanced >= 60.0

    def plan_due(self) -> bool:
        """Planner-only pass needed: autopilot on, sim time moved on, and something to act on."""
        state = self.state
        if not CONFIG.autopilotEnabled or not state.is_ready() or state.current_time is None or state.sat_count == 0:
            return False
        if self._last_plan_ts is not None and 0 <= state.now_ts - self._last_plan_ts < PLAN_INTERVAL_S:
            return False
        n = state.sat_count
        if any(c["status"] == "ACTIVE" and c["tca_ts"] > state.now_ts for c in state.cdms.open()):
            return True
        low_fuel = state.sat_fuel[:n] <= CONFIG.eolFuelThreshold
        if low_fuel.any() and any(state.idx_to_sat_id[int(i)] not in state.eol_satellites for i in low_fuel.nonzero()[0]):
            return True
        return bool((state.drift_km() > 6.0).any())

    async def plan_cycle(self) -> dict:
        state = self.state
        async with self._cycle_lock:
            async with state.lock:
                summary = self.autopilot.plan_and_schedule(state)
                self._last_plan_ts = state.now_ts
                return summary

    async def _loop(self):
        while True:
            try:
                if self.due():
                    await self.run_cycle()
                elif self.plan_due():
                    await self.plan_cycle()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error(f"Conjunction screening cycle failed: {e}", exc_info=True)
                await asyncio.sleep(5.0)
            await asyncio.sleep(0.5)

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
