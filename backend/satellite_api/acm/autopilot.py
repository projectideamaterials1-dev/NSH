"""
acm/autopilot.py
----------------
Closed-loop autonomy: screen -> decide -> schedule.

ConjunctionService.run_cycle():
  1. copies the state buffers (under the lock) and screens them for close approaches
     in a worker thread (acm.conjunctions.screen);
  2. merges predictions into the CDM registry (events for new/escalated/cleared threats);
  3. if the autopilot is enabled, plans with AutonomousBrain using the selected avoidance
     plugin (evasion + recovery, station-keeping return, end-of-life graveyard). Evasions are
     verified against the post-maneuver trajectory (acm.decision_support.verify_sequence);
     if the primary threat is not cleared or a secondary conjunction appears, the mirrored and
     other-axis alternatives are tried. Every sequence is validated with acm.scheduler, then
     queued (AUTONOMOUS mode) or held as a proposal for an operator (APPROVAL mode). Each
     decision is logged with a plain-language rationale (state.decisions).
A background task (started by the FastAPI lifespan) runs full cycles whenever simulation time has
advanced by CONFIG.cdmScreenIntervalSeconds or telemetry/burns changed, and in between re-runs the
(cheap) planner every PLAN_INTERVAL_S of simulation time while threats are open, so burns are
uplinked as soon as a threatened satellite enters ground-station contact.
"""
import asyncio
import contextlib
import copy
import logging
import math
import time
from collections import defaultdict, deque
from typing import Dict, List, Optional

import numpy as np

from satellite_api.acm.brain import EOL, EVASION, STATION_KEEPING, AutonomousBrain, Conjunction
from satellite_api.acm.conjunctions import annotate_pc, needs_action, screen
from satellite_api.acm.decision_support import (
    rationale_eol, rationale_evasion, rationale_station_keeping, verify_sequence,
)
from satellite_api.acm.fleet_coordinator import coordinate_fleet
from satellite_api.acm.plugins import get_plugin
from satellite_api.compute import planning as compute_planning
from satellite_api.compute import pool as compute_pool
from satellite_api.compute.evasion import evaluate_evasion
from satellite_api.acm.scheduler import BurnRequest, evaluate_sequence, queue_burns
from satellite_api.config import CONFIG
from satellite_api.ground_stations import brain_stations, has_los
from satellite_api.observability import SCREEN_DURATION
from satellite_api.physics_engine import ENGINE_NAME, process_conjunctions
from satellite_api.timeutils import iso_z


def sync_drag_model():
    from satellite_api.state import sync_drag_model as _sync   # state imports this module's siblings
    return _sync()

logger = logging.getLogger(__name__)

EVASION_TYPES = ("PHASING_PROGRADE", "PHASING_RETROGRADE", "RADIAL_SHUNT")
PLAN_INTERVAL_S = 20.0          # sim seconds between planner-only passes
REJECT_EVENT_THROTTLE_S = 600.0  # repeat an identical rejection event at most this often (sim seconds)
DURATION_HISTORY_LEN = 20       # rolling window of recent screen durations, for /api/metrics
SCREEN_FAILING_AFTER = 3        # consecutive failed screening cycles before /health reports "degraded"
# Once a screen has taken as long as the cadence it's meant to run at, the loop is provably
# falling behind (the next screen is already "due" before this one finished). From then on,
# bound the (expensive) refinement pass to priority + closest candidates - see conjunctions.screen -
# until a screen completes quickly enough to prove it has recovered.
MAX_REFINE_WHEN_OVERLOADED = 1000
MAX_EVASION_CANDIDATES = 4      # the planner's choice plus mirrored / other-axis alternatives
MAX_RATIONALES = 5000
MAX_PROPOSALS = 200


class Autopilot:
    def __init__(self):
        self.brain = AutonomousBrain()
        self.stations = brain_stations()
        self._verify_deadline = math.inf    # per planning cycle, see VERIFY_BUDGET_S
        self._unverified = 0
        self.last_plan_summary: Dict[str, int] = {}
        self._last_reject: Dict[str, tuple] = {}
        self._proposal_seq = 0

    def reset(self):
        self.brain = AutonomousBrain()

    def remap_satellites(self, remap: Dict[int, int]):
        """Follows StateManager.remove_satellites: the planner's memory is keyed by buffer row."""
        brain = self.brain
        brain.locked_satellites = {remap[i]: v for i, v in brain.locked_satellites.items() if i in remap}
        brain.eol_scheduled = {remap[i] for i in brain.eol_scheduled if i in remap}

    def snapshot_brain(self) -> dict:
        """JSON-serializable capture of in-memory planner state not held by StateManager,
        for RedisStateManager.register_snapshot_hook() - without it, a restart forgets which
        satellites are mid-maneuver-lock or already EOL-scheduled and could double-plan them."""
        return {
            "locked_satellites": {str(idx): list(value) for idx, value in self.brain.locked_satellites.items()},
            "eol_scheduled": sorted(self.brain.eol_scheduled),
            "proposal_seq": self._proposal_seq,
        }

    def restore_brain(self, payload: dict):
        self.brain.locked_satellites = {
            int(idx): tuple(value) for idx, value in payload.get("locked_satellites", {}).items()
        }
        self.brain.eol_scheduled = set(payload.get("eol_scheduled", []))
        self._proposal_seq = max(self._proposal_seq, int(payload.get("proposal_seq", 0)))

    # ── planning ────────────────────────────────────────────────────────────────
    async def plan_and_schedule(self, state) -> Dict[str, int]:
        """Runs the planner on the current state and queues (or, in APPROVAL mode, proposes)
        validated burns. Caller holds the lock; post-maneuver verification screens run in a
        worker thread meanwhile."""
        summary = {"sequences_planned": 0, "sequences_scheduled": 0, "sequences_rejected": 0,
                   "sequences_proposed": 0}
        n = state.sat_count
        if n == 0 or state.current_time is None:
            return summary
        now = state.current_time
        now_ts = now.timestamp()
        plugin = get_plugin(CONFIG.avoidanceStrategy)
        self.expire_proposals(state)
        pending_sats = {p["satellite_id"] for p in state.proposals.values() if p["status"] == "PENDING"}

        conjunctions, threat_cdms = [], defaultdict(list)
        open_cdms = state.cdms.open()
        # Two fleet satellites closing on each other produce an event for each of them: only one should
        # maneuver (the one whose ID sorts first); the other keeps its event for display only.
        active_pairs = {(c["satellite_id"], c["object_id"]) for c in open_cdms if c["status"] == "ACTIVE"}
        for cdm in open_cdms:
            idx = state.sat_id_to_idx.get(cdm["satellite_id"])
            if idx is None or cdm["status"] != "ACTIVE" or cdm["tca_ts"] <= now_ts:
                continue
            if (cdm["object_id"] in state.sat_id_to_idx and cdm["object_id"] < cdm["satellite_id"]
                    and (cdm["object_id"], cdm["satellite_id"]) in active_pairs):
                continue
            conj = Conjunction(
                sat_idx=idx, debris_idx=0, tca_seconds=cdm["tca_ts"] - now_ts,
                miss_distance_km=cdm["miss_distance_km"], relative_velocity_kms=cdm["relative_velocity_kms"],
                risk_score=1.0 if cdm["risk"] == "CRITICAL" else 0.5,
                pc=cdm.get("pc"), requires_action=needs_action(cdm),
                # Pc-sized clearance: the miss at which Pc falls a decade below the threshold.
                target_clearance_km=_clearance(cdm),
            )
            conjunctions.append(conj)
            if conj.is_threat():
                threat_cdms[idx].append(cdm)

        sat_states = state.sat_buffer[:n].copy()
        nominal = state.nominal_buffer[:n].copy()
        fuels = [float(f) for f in state.sat_fuel[:n]]
        eol_idx = {state.sat_id_to_idx[s] for s in state.eol_satellites if s in state.sat_id_to_idx}
        self.brain.eol_scheduled |= eol_idx

        reported = set(self.brain.skipped_unbound)
        # Worker thread: planning works on the copies above and the planner's own state, and with a
        # whole-catalog fleet it takes seconds - on the event loop it froze the API and telemetry stream.
        self._verify_deadline = time.time() + VERIFY_BUDGET_S     # wall clock: compared in worker processes
        self._unverified = 0
        # In a worker process: planning works on the copies above and the planner's own state, which comes
        # back with the plans. With a whole-catalog fleet it takes seconds of pure Python.
        brain_after, plans = await compute_pool.run(compute_planning.plan, self.brain, sat_states, nominal, fuels,
                                                    conjunctions, now, self.stations, evasion_mode=plugin.mode)
        if brain_after is not self.brain:
            self.brain.__dict__.update(brain_after.__dict__)
        summary["evasions_deferred"] = getattr(self.brain, "evasions_deferred", 0)
        for i in sorted(self.brain.skipped_unbound - reported):
            state.emit("warn", "autopilot", f"{state.idx_to_sat_id[i]}: state is not a bound orbit (bad element set?) - "
                       "station-keeping skipped for it", satellite_id=state.idx_to_sat_id[i])

        # End-of-life: retire satellites at the fuel threshold while they are in contact.
        planned_sats = {p.sat_idx for p in plans}
        for i in range(n):
            if (fuels[i] <= CONFIG.eolFuelThreshold and i not in self.brain.eol_scheduled and i not in planned_sats
                    and has_los(sat_states[i, :3], now_ts)):
                p = self.brain.plan_eol(i, sat_states[i], fuels[i], max_dv_kms=CONFIG.maxDeltaV / 1000.0)
                if p:
                    plans.append(p)

        # A satellite with a proposal awaiting the operator is not re-planned until it is answered.
        if pending_sats:
            for p in plans:
                if state.idx_to_sat_id[p.sat_idx] in pending_sats:
                    self._release(p.sat_idx, p.category == EOL)
            plans = [p for p in plans if state.idx_to_sat_id[p.sat_idx] not in pending_sats]

        # ── Fleet-wide coordination: prioritize + stagger clustered station-keeping burns. ──
        # Never re-times EVASION/EOL plans - see acm/fleet_coordinator.py's module docstring
        # for why staggering (delay-only) can't break evaluate_sequence's validation.
        summary["sk_burns_staggered"] = 0
        if CONFIG.fleetStaggerEnabled and plans:
            drift = np.linalg.norm(sat_states[:, :3] - nominal[:, :3], axis=1)
            coordination = coordinate_fleet(
                plans, drift_km=drift, fuels=fuels, conjunctions=conjunctions,
                now_ts=now_ts, locked_satellites=self.brain.locked_satellites,
            )
            summary["sk_burns_staggered"] = coordination.staggered_count
            for note in coordination.notes:
                state.emit("info", "fleet_coordinator", note.message,
                           satellite_id=state.idx_to_sat_id.get(note.sat_idx), **note.data)

        by_sat = defaultdict(list)
        for p in plans:
            by_sat[p.sat_idx].append(p)

        # IDs as of planning: verification below releases the state lock, and a fleet resize meanwhile can
        # move satellites to other rows - such a plan is dropped (and re-planned next cycle), never misapplied.
        planned_ids = {idx: state.idx_to_sat_id[idx] for idx in by_sat}
        summary["sequences_dropped_state_changed"] = 0
        # Avoidance plans: build every satellite's evaluation job under the lock, then release it once and
        # evaluate them all in parallel in the worker processes (alternatives + post-burn re-screening).
        evasion_jobs = {}
        for idx, seq in by_sat.items():
            if any(p.category == EVASION for p in seq) and not any(p.category == EOL for p in seq):
                evasion_jobs[idx] = self._evasion_job(state, idx, sorted(seq, key=lambda p: p.burn_time_offset_s),
                                                      threat_cdms.get(idx, []), fuels[idx], now_ts)
        evasion_results = {}
        if evasion_jobs:
            async with _released(state.lock):
                results = await asyncio.gather(*(compute_pool.run(evaluate_evasion, job)
                                                 for job in evasion_jobs.values()))
            evasion_results = dict(zip(evasion_jobs, results))

        for idx, seq in by_sat.items():
            sid = planned_ids[idx]
            if state.idx_to_sat_id.get(idx) != sid:
                summary["sequences_dropped_state_changed"] += 1
                continue
            summary["sequences_planned"] += 1
            seq = sorted(seq, key=lambda p: p.burn_time_offset_s)
            kind = EOL if any(p.category == EOL for p in seq) else (
                EVASION if any(p.category == EVASION for p in seq) else STATION_KEEPING)
            candidates = []
            total_dv_mps = sum(float(np.linalg.norm(p.delta_v_rtn)) for p in seq) * 1000.0
            if kind == EVASION:
                seq, rationale, candidates = self._finish_evasion(state, evasion_jobs[idx], evasion_results[idx], now_ts)
                if state.idx_to_sat_id.get(idx) != sid:
                    summary["sequences_dropped_state_changed"] += 1
                    continue
            elif kind == EOL:
                rationale = rationale_eol(fuels[idx], total_dv_mps)
            else:
                rationale = rationale_station_keeping(
                    float(np.linalg.norm(sat_states[idx, :3] - nominal[idx, :3])), total_dv_mps,
                    sum(p.estimated_fuel_kg for p in seq))

            burns = self._burn_requests(sid, seq, now_ts)
            evaluation = evaluate_sequence(state, sid, burns)
            cdm_ids = [c["cdm_id"] for c in threat_cdms.get(idx, [])] if kind == EVASION else []
            if evaluation.accepted and CONFIG.autopilotMode == "APPROVAL":
                self._propose(state, idx, sid, kind, seq, burns, evaluation, rationale, candidates, cdm_ids, now_ts)
                summary["sequences_proposed"] += 1
            elif evaluation.accepted:
                self._commit(state, sid, burns, evaluation, kind, rationale, plugin.name(), actor="autopilot")
                self._last_reject.pop(sid, None)
                summary["sequences_scheduled"] += 1
                state.record_decision(satellite_id=sid, kind=kind, outcome="SCHEDULED", rationale=rationale,
                                      cdm_ids=cdm_ids, candidates=candidates, burns=self._burn_rows(burns),
                                      fuel_kg=round(evaluation.fuel_needed_kg, 4), actor="autopilot")
            else:
                summary["sequences_rejected"] += 1
                # Release the planner lock so the next cycle can try again (e.g. after LOS returns).
                self._release(idx, kind == EOL)
                previous = self._last_reject.get(sid)
                if previous is None or previous[0] != evaluation.reason or now_ts - previous[1] >= REJECT_EVENT_THROTTLE_S:
                    self._last_reject[sid] = (evaluation.reason, now_ts)
                    state.emit("warn", "autopilot", f"Planned sequence rejected: {evaluation.reason.replace('_', ' ').lower()}",
                               satellite_id=sid, reason=evaluation.reason)
                    state.record_decision(satellite_id=sid, kind=kind, outcome="REJECTED", rationale=rationale,
                                          reason=evaluation.reason, cdm_ids=cdm_ids, candidates=candidates,
                                          burns=self._burn_rows(burns), actor="autopilot")
        summary["evasions_unverified"] = self._unverified
        if self._unverified:
            state.emit("warn", "autopilot", f"{self._unverified} avoidance plan(s) this cycle used the planner's "
                       f"plan without post-burn re-screening (verification budget of {VERIFY_BUDGET_S:.0f} s used)")
        self.last_plan_summary = summary
        return summary

    # ── helpers ─────────────────────────────────────────────────────────────────
    def _release(self, idx: int, is_eol: bool = False):
        self.brain.locked_satellites.pop(idx, None)
        if is_eol:
            self.brain.eol_scheduled.discard(idx)

    @staticmethod
    def _burn_requests(sid: str, seq, now_ts: float, actor: str = "autopilot") -> List[BurnRequest]:
        burns = []
        for k, p in enumerate(sorted(seq, key=lambda p: p.burn_time_offset_s)):
            dv = p.delta_v_eci_dict
            burns.append(BurnRequest(
                burn_id=f"AUTO-{sid}-{p.maneuver_type.value}-{int(now_ts + p.burn_time_offset_s)}-{k}",
                ts=now_ts + p.burn_time_offset_s, dv_kms=(dv["x"], dv["y"], dv["z"]),
                maneuver_type=p.maneuver_type.value, actor=actor,
            ))
        return burns

    @staticmethod
    def _burn_rows(burns: List[BurnRequest]) -> List[dict]:
        return [{"burn_id": b.burn_id, "burn_time": iso_z(b.ts), "ts": b.ts, "delta_v_mps": round(b.dv_mps, 4),
                 "maneuver_type": b.maneuver_type} for b in burns]

    def _commit(self, state, sid: str, burns: List[BurnRequest], evaluation, kind: str, rationale: str,
                strategy: str, actor: str):
        for b in burns:
            state.burn_rationale[b.burn_id] = rationale
        while len(state.burn_rationale) > MAX_RATIONALES:
            state.burn_rationale.pop(next(iter(state.burn_rationale)))
        queue_burns(state, sid, burns, source=actor)
        now_ts = state.now_ts
        mode = "GRAVEYARD" if kind == EOL else ("EVADING" if kind == EVASION else "RECOVERING")
        state.sat_modes[sid] = {"mode": mode, "until_ts": float("inf") if kind == EOL else burns[-1].ts + 1.0}
        if kind == EVASION:
            linked = state.cdms.link_mitigation(sid, [b.burn_id for b in burns], now_ts)
            state.emit("ok", "autopilot", f"Avoidance planned ({strategy}): {len(burns)} burns, "
                       f"{evaluation.fuel_needed_kg:.3f} kg", satellite_id=sid, cdm_ids=linked, rationale=rationale)
        elif kind == EOL:
            state.emit("warn", "autopilot", "End-of-life graveyard burn scheduled", satellite_id=sid, rationale=rationale)
        else:
            state.emit("info", "autopilot", "Station-keeping return scheduled", satellite_id=sid, rationale=rationale)

    def _evasion_job(self, state, idx: int, seq, threats: List[dict], fuel_kg: float, now_ts: float) -> dict:
        """Everything evaluate_evasion (compute/evasion.py) needs, copied out of the live state so it can run
        in a worker process with the state lock released. Caller holds the lock."""
        sid = state.idx_to_sat_id[idx]
        threat_rows = sorted(({"object_id": c["object_id"], "miss_distance_km": c["miss_distance_km"],
                               "pc": c.get("pc"), "tca_s": c["tca_ts"] - now_ts, "clearance_km": _clearance(c)}
                              for c in threats),
                             key=lambda t: (-(t["pc"] or 0.0), t["miss_distance_km"]))
        if not threat_rows:     # planner acted on a CDM that closed meanwhile: nothing to verify against
            first = seq[0].burn_time_offset_s
            threat_rows = [{"object_id": "unknown", "miss_distance_km": 0.0, "pc": None, "tca_s": first,
                            "clearance_km": 0.2}]
        verify = CONFIG.verifyManeuvers and bool(threats)
        job = {"sid": sid, "idx": idx, "seq": seq, "threat_rows": threat_rows, "fuel_kg": fuel_kg,
               "sat_state": state.sat_buffer[idx].copy(), "nominal": state.nominal_buffer[idx].copy(),
               "sat_ballistic": float(state.sat_ballistic[idx]), "now_ts": now_ts, "verify": verify,
               "deadline": self._verify_deadline,
               "first_label": _label("radial" if any(p.maneuver_type.value == "RADIAL_SHUNT" for p in seq)
                                     else "transverse", _direction(seq)),
               "max_candidates": MAX_EVASION_CANDIDATES,
               "objects": None, "ids": [], "types": [], "obj_ballistic": None, "horizon_s": 0.0}
        if verify:
            job["objects"], job["ids"], job["types"], job["obj_ballistic"] = _screen_objects(state, idx)
            screen_horizon = CONFIG.cdmHorizonSeconds if ENGINE_NAME == "cpp" else min(CONFIG.cdmHorizonSeconds, 3600.0)
            job["horizon_s"] = max(screen_horizon, max(t["tca_s"] for t in threat_rows) + 600.0)
        return job

    def _finish_evasion(self, state, job: dict, result: dict, now_ts: float):
        """Applies a worker's evaluation: locks the satellite for the chosen plan and writes the rationale.
        Caller holds the lock."""
        sid, idx, plan = job["sid"], job["idx"], result["plan"]
        if result["no_clean"]:
            state.emit("crit", "autopilot", f"No evasion option is fully clean; using {result['chosen']['label']} "
                       f"(least residual risk). Operator review advised.", satellite_id=sid)
        if result["budget_spent"]:
            self._unverified += 1
        self.brain.locked_satellites[idx] = (now_ts + plan[-1].burn_time_offset_s + 1.0, "EVASION")
        rationale = rationale_evasion(job["threat_rows"], result["chosen"], result["rejected"],
                                      result["chosen"]["fuel_kg"])
        if result["budget_spent"]:
            rationale += (" Not re-screened after the burn: this cycle's verification budget went to"
                          " more urgent events.")
        return plan, rationale, result["candidates"]

    # ── human-in-the-loop ───────────────────────────────────────────────────────
    def _propose(self, state, idx, sid, kind, seq, burns, evaluation, rationale, candidates, cdm_ids, now_ts):
        self._release(idx, kind == EOL)
        self._proposal_seq += 1
        pid = f"PRP-{self._proposal_seq:05d}"
        state.proposals[pid] = {
            "proposal_id": pid, "satellite_id": sid, "kind": kind, "status": "PENDING",
            "created_ts": now_ts, "created_at": iso_z(now_ts),
            "expires_ts": now_ts + CONFIG.approvalTimeoutSeconds,
            "expires_at": iso_z(now_ts + CONFIG.approvalTimeoutSeconds),
            "timeout_action": CONFIG.approvalTimeoutAction,
            "rationale": rationale, "cdm_ids": cdm_ids, "candidates": candidates,
            "burns": self._burn_rows(burns), "fuel_kg": round(evaluation.fuel_needed_kg, 4),
            # RTN burns relative to the proposal epoch: re-targeted from the state at approval time
            "_plans": [copy.deepcopy(p) for p in seq],
        }
        while len(state.proposals) > MAX_PROPOSALS:
            oldest = next((k for k, v in state.proposals.items() if v["status"] != "PENDING"), None)
            if oldest is None:
                break
            state.proposals.pop(oldest)
        state.emit("warn", "autopilot", f"{kind.replace('_', ' ').title()} proposal {pid} awaiting operator approval "
                   f"(times out in {CONFIG.approvalTimeoutSeconds / 60:.0f} sim min: {CONFIG.approvalTimeoutAction.lower()})",
                   satellite_id=sid, proposal_id=pid, rationale=rationale)
        state.record_decision(satellite_id=sid, kind=kind, outcome="PROPOSED", rationale=rationale, cdm_ids=cdm_ids,
                              candidates=candidates, burns=self._burn_rows(burns), proposal_id=pid,
                              fuel_kg=round(evaluation.fuel_needed_kg, 4), actor="autopilot")

    def approve(self, state, proposal_id: str, actor: str) -> dict:
        """Re-targets the proposed burns from the current state and queues them. Caller holds the lock."""
        prop = _pending(state, proposal_id)
        sid = prop["satellite_id"]
        idx = state.sat_id_to_idx.get(sid)
        if idx is None:
            prop["status"] = "FAILED"
            raise ValueError("Satellite no longer tracked")
        now_ts = state.now_ts
        plans = [copy.deepcopy(p) for p in prop["_plans"]]
        self.brain._generate_sequential_eci(plans, state.sat_buffer[idx, :3].copy(), state.sat_buffer[idx, 3:6].copy())
        burns = self._burn_requests(sid, plans, now_ts, actor=actor)
        evaluation = evaluate_sequence(state, sid, burns)
        if not evaluation.accepted:
            prop.update(status="FAILED", answered_at=iso_z(now_ts), answered_by=actor, reason=evaluation.reason)
            state.emit("warn", "autopilot", f"Approved proposal {proposal_id} failed validation: "
                       f"{evaluation.reason.replace('_', ' ').lower()}", satellite_id=sid, proposal_id=proposal_id)
            state.record_decision(satellite_id=sid, kind=prop["kind"], outcome="FAILED", rationale=prop["rationale"],
                                  reason=evaluation.reason, proposal_id=proposal_id, actor=actor)
            return prop
        rationale = f"{prop['rationale']} Approved by {actor}."
        self._commit(state, sid, burns, evaluation, prop["kind"], rationale, CONFIG.avoidanceStrategy, actor=actor)
        lock_reason = {EVASION: "EVASION", STATION_KEEPING: "SK"}.get(prop["kind"])
        if lock_reason:
            self.brain.locked_satellites[idx] = (burns[-1].ts + 1.0, lock_reason)
        else:
            self.brain.eol_scheduled.add(idx)
        prop.update(status="APPROVED", answered_at=iso_z(now_ts), answered_by=actor, burns=self._burn_rows(burns))
        state.record_decision(satellite_id=sid, kind=prop["kind"], outcome="APPROVED", rationale=rationale,
                              cdm_ids=prop["cdm_ids"], burns=self._burn_rows(burns), proposal_id=proposal_id,
                              fuel_kg=round(evaluation.fuel_needed_kg, 4), actor=actor)
        return prop

    def reject(self, state, proposal_id: str, actor: str, reason: str = "") -> dict:
        prop = _pending(state, proposal_id)
        prop.update(status="REJECTED", answered_at=iso_z(state.now_ts), answered_by=actor, reason=reason or None)
        state.emit("info", "autopilot", f"Proposal {proposal_id} rejected by {actor}" + (f": {reason}" if reason else ""),
                   satellite_id=prop["satellite_id"], proposal_id=proposal_id)
        state.record_decision(satellite_id=prop["satellite_id"], kind=prop["kind"], outcome="REJECTED_BY_OPERATOR",
                              rationale=prop["rationale"], reason=reason or None, proposal_id=proposal_id, actor=actor)
        return prop

    def expire_proposals(self, state):
        """Applies the timeout action to proposals nobody answered in time. Caller holds the lock."""
        now_ts = state.now_ts
        for pid, prop in list(state.proposals.items()):
            if prop["status"] != "PENDING" or now_ts < prop["expires_ts"]:
                continue
            if prop["timeout_action"] == "EXECUTE":
                state.emit("warn", "autopilot", f"Proposal {pid} unanswered; executing per timeout policy",
                           satellite_id=prop["satellite_id"], proposal_id=pid)
                self.approve(state, pid, actor="autopilot:timeout")
            else:
                prop.update(status="EXPIRED", answered_at=iso_z(now_ts), answered_by="timeout")
                state.emit("crit" if prop["kind"] == EVASION else "warn", "autopilot",
                           f"Proposal {pid} expired without an operator decision; it will be re-planned",
                           satellite_id=prop["satellite_id"], proposal_id=pid)
                state.record_decision(satellite_id=prop["satellite_id"], kind=prop["kind"], outcome="EXPIRED",
                                      rationale=prop["rationale"], proposal_id=pid, actor="timeout")


def _clearance(cdm: dict) -> float:
    return min(cdm.get("safe_miss_km") or 0.2, 5.0)


def _label(mode: str, direction: float) -> str:
    return ("radial shunt" if mode == "radial" else "transverse phasing") + (
        " (prograde/up)" if direction > 0 else " (retrograde/down)")


def _direction(seq) -> float:
    first = seq[0].delta_v_rtn
    return 1.0 if float(first[int(np.argmax(np.abs(first)))]) >= 0 else -1.0


def _pending(state, proposal_id: str) -> dict:
    prop = state.proposals.get(proposal_id)
    if prop is None:
        raise KeyError(proposal_id)
    if prop["status"] != "PENDING":
        raise ValueError(f"Proposal is already {prop['status'].lower()}")
    return prop


# Apogee/perigee filter margin for verification screens: covers the warning radius plus the largest
# semi-major-axis change a single plan can make (15 m/s in LEO moves a by ~25 km) with room to spare.
SHELL_MARGIN_KM = 75.0
_MU = 398600.4418


def _altitude_shells(states: np.ndarray):
    """(perigee radius, apogee radius) in km per (N, 6) ECI state; unbound or degenerate rows get
    (0, inf) so the filter always keeps them."""
    r = np.linalg.norm(states[:, :3], axis=1)
    v2 = np.einsum("ij,ij->i", states[:, 3:], states[:, 3:])
    h2 = np.einsum("ij,ij->i", *(np.cross(states[:, :3], states[:, 3:]),) * 2)
    with np.errstate(divide="ignore", invalid="ignore"):
        inv_a = 2.0 / r - v2 / _MU
        a = 1.0 / inv_a
        e = np.sqrt(np.clip(1.0 - h2 / (_MU * a), 0.0, None))
        rp, ra = a * (1.0 - e), a * (1.0 + e)
    bad = ~np.isfinite(rp) | ~np.isfinite(ra) | (inv_a <= 0)
    rp[bad], ra[bad] = 0.0, np.inf
    return rp, ra


def _screen_objects(state, idx: int):
    """Every other tracked object (debris, then satellites) that could come close to satellite `idx`,
    minus physically attached ones. Objects whose altitude range (perigee to apogee) does not overlap the
    satellite's within SHELL_MARGIN_KM can never approach it, so they are left out: with the whole active
    catalog tracked this cuts each post-burn verification screen several-fold."""
    sid = state.idx_to_sat_id[idx]
    others = [i for i in range(state.sat_count) if i != idx]
    objects = np.vstack([state.debris_buffer[:state.debris_count], state.sat_buffer[others]])
    ids = [state.idx_to_debris_id[i] for i in range(state.debris_count)] + [state.idx_to_sat_id[i] for i in others]
    types = ["DEBRIS"] * state.debris_count + ["SATELLITE"] * len(others)
    ballistic = np.concatenate([state.debris_ballistic[:state.debris_count], state.sat_ballistic[others]])
    keep = np.ones(len(ids), dtype=bool)
    if len(ids):
        rp, ra = _altitude_shells(objects)
        sp, sa = _altitude_shells(state.sat_buffer[idx:idx + 1])
        keep &= (rp <= sa[0] + SHELL_MARGIN_KM) & (ra >= sp[0] - SHELL_MARGIN_KM)
    if state.attached_pairs:
        keep &= np.array([not state.is_attached(sid, o) for o in ids], dtype=bool)
    if not keep.all():
        objects = objects[keep]
        ballistic = ballistic[keep]
        ids = [o for o, k in zip(ids, keep) if k]
        types = [t for t, k in zip(types, keep) if k]
    return objects.copy(), ids, types, ballistic.copy()


def public_proposal(prop: dict) -> dict:
    return {k: v for k, v in prop.items() if not k.startswith("_")}

SLOW_LOCK_LOG_S = 2.0
# Post-burn verification (re-screening candidate plans against the whole catalog) per planning cycle.
VERIFY_BUDGET_S = 20.0


@contextlib.asynccontextmanager
async def _released(lock: asyncio.Lock):
    """Temporarily gives up a lock the caller holds, and takes it back before returning (also on error)."""
    lock.release()
    try:
        yield
    finally:
        await lock.acquire()

SLOW_CYCLE_S = 10.0
MAX_CYCLE_REST_S = 120.0


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
        self._duration_history: deque = deque(maxlen=DURATION_HISTORY_LEN)
        self._falling_behind = False
        # Loop health for /health and /metrics: a cycle that keeps raising (e.g. a GPU lost to a driver
        # reset) must not look like a quiet sky.
        self.consecutive_failures = 0
        self.last_error: Optional[str] = None
        self.last_success_wall: Optional[float] = None

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
                sat_b, deb_b = state.ballistic_arrays()
                external_index = state.external_cdms.index()
                start_ts = state.now_ts
                versions = (state.telemetry_version, state.burn_version)
                refiner = self.refiner
                refine_snapshot = refiner.snapshot() if refiner else None
                element_ages = refiner.element_ages_s(state.now_ts) if refiner else None
                # Falling-behind decision is made from the *previous* cycle's measured duration,
                # applied to this cycle - see MAX_REFINE_WHEN_OVERLOADED.
                if self._falling_behind:
                    priority_pairs = frozenset(
                        (c["satellite_id"], c["object_id"]) for c in state.cdms.open() if c["risk"] != "WATCH"
                    )
                    max_refine = MAX_REFINE_WHEN_OVERLOADED
                else:
                    priority_pairs = None
                    max_refine = None

            sync_drag_model()
            t0 = time.perf_counter()
            coarse_km = CONFIG.cdmWarningKm + (refiner.margin_km(horizon) if refiner else 0.0)
            predictions = await asyncio.to_thread(
                screen, sats, debris, sat_ids, deb_ids, start_ts, horizon, coarse_km, self.engine,
                priority_pairs, max_refine, sat_b, deb_b)
            if refiner:
                predictions = await asyncio.to_thread(refiner.refine, predictions, refine_snapshot, CONFIG.cdmWarningKm)
            elapsed = time.perf_counter() - t0
            self._duration_history.append(elapsed)
            SCREEN_DURATION.observe(elapsed)
            if state.attached_pairs:
                predictions = [p for p in predictions if not state.is_attached(p["satellite_id"], p["object_id"])]
            predictions = await compute_pool.run(annotate_pc, predictions, start_ts, external_index, element_ages)

            async with state.lock:
                t_lock = time.perf_counter()
                stats = state.cdms.apply(predictions, state.now_ts, state.emit)
                t_apply = time.perf_counter() - t_lock
                state.active_cdm_warnings = len(state.cdms.open())
                do_plan = CONFIG.autopilotEnabled if plan is None else plan
                plan_summary = await self.autopilot.plan_and_schedule(state) if do_plan else {}
                held = time.perf_counter() - t_lock
                if held > SLOW_LOCK_LOG_S:
                    # Everything that needs the state (clock tick, telemetry stream, most API calls) waits this long.
                    logger.warning(f"Screening cycle held the state lock for {held:.1f}s (CDM update {t_apply:.1f}s, "
                                   f"planning {held - t_apply:.1f}s; {len(predictions)} predictions, "
                                   f"plan {({k: v for k, v in plan_summary.items() if v})})")
                if do_plan:
                    self._last_plan_ts = state.now_ts

                interval = CONFIG.cdmScreenIntervalSeconds
                overrun_ratio = (elapsed / interval) if interval > 0 else 0.0
                now_falling_behind = overrun_ratio >= 1.0
                if now_falling_behind and not self._falling_behind:
                    state.emit("crit", "system",
                               f"Conjunction screening is falling behind: the last screen took {elapsed:.1f}s "
                               f"against a {interval:.0f}s cadence. Refinement is now bounded to the highest-"
                               f"risk candidates per cycle until it recovers.")
                elif self._falling_behind and not now_falling_behind:
                    state.emit("ok", "system",
                               f"Conjunction screening back within budget ({elapsed:.1f}s of a {interval:.0f}s cadence).")
                self._falling_behind = now_falling_behind

                state.last_screen = {
                    "screened_at": iso_z(start_ts), "horizon_s": horizon, "warning_km": CONFIG.cdmWarningKm,
                    "duration_s": round(elapsed, 3), "predictions": len(predictions), **stats,
                    "engine": ENGINE_NAME, "autopilot": do_plan, **plan_summary,
                    "propagator": "SGP4 refinement" if refiner else "RK4 + J2",
                    "avg_duration_s": round(sum(self._duration_history) / len(self._duration_history), 3),
                    "max_duration_s": round(max(self._duration_history), 3),
                    "overrun_ratio": round(overrun_ratio, 3),
                    "falling_behind": now_falling_behind,
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
        return bool((state.drift_km() > 0.6 * CONFIG.stationKeepingRadius).any())

    async def plan_cycle(self) -> dict:
        state = self.state
        async with self._cycle_lock:
            async with state.lock:
                summary = await self.autopilot.plan_and_schedule(state)
                self._last_plan_ts = state.now_ts
                return summary

    def health(self) -> dict:
        return {"ok": self.consecutive_failures < SCREEN_FAILING_AFTER,
                "consecutive_failures": self.consecutive_failures, "last_error": self.last_error,
                "last_success_age_s": None if self.last_success_wall is None
                else round(time.time() - self.last_success_wall, 1)}

    async def _record_cycle(self, error: Optional[Exception]):
        state = self.state
        if error is None:
            if self.consecutive_failures >= SCREEN_FAILING_AFTER:
                async with state.lock:
                    state.emit("ok", "system", f"Conjunction screening recovered after "
                               f"{self.consecutive_failures} failed cycles.")
            self.consecutive_failures, self.last_success_wall = 0, time.time()
            return
        self.consecutive_failures += 1
        self.last_error = f"{type(error).__name__}: {error}"[:300]
        if self.consecutive_failures == SCREEN_FAILING_AFTER:
            async with state.lock:
                state.emit("crit", "system", f"Conjunction screening is failing ({self.consecutive_failures} cycles "
                           f"in a row): {self.last_error}. No new conjunctions are being detected.")

    async def _loop(self):
        while True:
            try:
                if self.due():
                    t0 = time.perf_counter()
                    await self.run_cycle()
                    await self._record_cycle(None)
                    took = time.perf_counter() - t0
                    if took > SLOW_CYCLE_S:
                        # A whole-catalog fleet screens for about a minute and new telemetry is always waiting by
                        # then: without a pause the GPU and the state lock would never be free. Rest as long as
                        # the cycle took (at most MAX_CYCLE_REST_S), so screening uses at most about half the time.
                        await asyncio.sleep(min(took, MAX_CYCLE_REST_S))
                elif self.plan_due():
                    await self.plan_cycle()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error(f"Conjunction screening cycle failed: {e}", exc_info=True)
                await self._record_cycle(e)
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
