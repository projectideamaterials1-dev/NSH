"""
acm/scheduler.py
----------------
Single source of truth for burn-sequence validation and queueing, shared by
POST /api/maneuver/schedule, the manual burn planner and the autopilot.

Rules (values from satellite_api.config.CONFIG):
  * line of sight to at least one ground station when the sequence is uplinked
  * |Δv| per burn <= maxDeltaV
  * cooldownSeconds between burns (including already-queued burns and the current cooldown)
  * Tsiolkovsky propellant for the whole sequence, after fuel reserved by queued burns
All functions expect the caller to hold `state.lock`.
"""
import math
from dataclasses import dataclass, field
from typing import List, Optional

from satellite_api.config import CONFIG
from satellite_api.ground_stations import has_los
from satellite_api.state import fuel_for_burn


@dataclass
class BurnRequest:
    burn_id: str
    ts: float                 # POSIX seconds
    dv_kms: tuple             # ECI (x, y, z) km/s
    maneuver_type: str = "EXTERNAL"
    actor: str = "unknown"    # who/what requested this burn, for the audit trail

    @property
    def dv_mps(self) -> float:
        return math.sqrt(sum(c * c for c in self.dv_kms)) * 1000.0


@dataclass
class Evaluation:
    status: str                       # "SCHEDULED" or "REJECTED: <REASON>"
    ground_station_los: bool
    sufficient_fuel: bool
    projected_mass_remaining_kg: float
    fuel_needed_kg: float = 0.0
    available_fuel_kg: float = 0.0
    burns: List[dict] = field(default_factory=list)   # per-burn breakdown
    checks: dict = field(default_factory=dict)         # every rule evaluated independently

    @property
    def accepted(self) -> bool:
        return self.status == "SCHEDULED"

    @property
    def reason(self) -> Optional[str]:
        return None if self.accepted else self.status.split(": ", 1)[-1]

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "validation": {
                "ground_station_los": self.ground_station_los,
                "sufficient_fuel": self.sufficient_fuel,
                "projected_mass_remaining_kg": round(self.projected_mass_remaining_kg, 2),
            },
            "fuel_needed_kg": round(self.fuel_needed_kg, 4),
            "available_fuel_kg": round(self.available_fuel_kg, 4),
            "burns": self.burns,
            "checks": self.checks,
        }


def evaluate_sequence(state, sat_id: str, burns: List[BurnRequest], check_los: bool = True) -> Evaluation:
    idx = state.sat_id_to_idx[sat_id]
    dry_mass = CONFIG.dryMass
    cooldown = CONFIG.cooldownSeconds
    now_ts = state.current_time.timestamp()
    current_fuel = float(state.sat_fuel[idx])

    next_available_ts = now_ts + float(state.sat_cooldown_timers[idx])
    reserved_fuel = 0.0
    for queued in sorted(state.maneuver_queue, key=lambda m: m[0]):
        q_ts, q_sat, q_dvx, q_dvy, q_dvz = queued[:5]
        if q_sat == sat_id:
            dv = math.sqrt(q_dvx ** 2 + q_dvy ** 2 + q_dvz ** 2) * 1000.0
            reserved_fuel += fuel_for_burn(dv, dry_mass + current_fuel - reserved_fuel)
            next_available_ts = max(next_available_ts, q_ts + cooldown)

    available = current_fuel - reserved_fuel
    mass = dry_mass + available

    los_ok = (not check_los) or has_los(state.sat_buffer[idx, 0:3], now_ts)

    # Evaluate every rule (so previews can show all failures), then report the first by priority.
    rows, needed = [], 0.0
    cooldown_ok = thrust_ok = True
    for burn in sorted(burns, key=lambda b: b.ts):
        dv_mps = burn.dv_mps
        row = {"burn_id": burn.burn_id, "ts": burn.ts, "delta_v_mps": round(dv_mps, 4), "maneuver_type": burn.maneuver_type}
        if burn.ts < next_available_ts - 0.1:
            cooldown_ok = False
            row["violation"] = "COOLDOWN_ACTIVE"
        next_available_ts = max(next_available_ts, burn.ts + cooldown)
        if dv_mps > CONFIG.maxDeltaV:
            thrust_ok = False
            row["violation"] = "MAX_THRUST_EXCEEDED"
        delta_m = fuel_for_burn(dv_mps, mass)
        if 0 < delta_m < 0.001:
            delta_m = 0.001
        row["fuel_kg"] = round(delta_m, 4)
        needed += delta_m
        mass -= delta_m
        rows.append(row)
    fuel_ok = needed <= available

    checks = {"ground_station_los": los_ok, "cooldown": cooldown_ok, "max_delta_v": thrust_ok, "fuel": fuel_ok}
    for ok, reason in ((los_ok, "NO_LINE_OF_SIGHT"), (cooldown_ok, "COOLDOWN_ACTIVE"),
                       (thrust_ok, "MAX_THRUST_EXCEEDED"), (fuel_ok, "INSUFFICIENT_FUEL")):
        if not ok:
            return Evaluation(f"REJECTED: {reason}", los_ok, fuel_ok, mass, needed, available, rows, checks)
    return Evaluation("SCHEDULED", True, True, mass, needed, available, rows, checks)


def queue_burns(state, sat_id: str, burns: List[BurnRequest], source: str = "api") -> None:
    for b in burns:
        state.maneuver_queue.append(
            (b.ts, sat_id, b.dv_kms[0], b.dv_kms[1], b.dv_kms[2], b.burn_id, b.maneuver_type, b.actor)
        )
        state.notify_pending_maneuver(b.ts, sat_id, b.dv_kms[0], b.dv_kms[1], b.dv_kms[2], b.burn_id)
    state.burn_version += 1
    for b in burns:
        state.emit("info", "maneuver", f"Burn {b.burn_id} scheduled ({b.maneuver_type.replace('_', ' ').lower()}, "
                   f"{b.dv_mps:.2f} m/s)", satellite_id=sat_id, burn_id=b.burn_id, source=source)
