"""
acm/plugins.py
--------------
Selectable collision-avoidance strategies.

Each plugin wraps the physics-based planner in `acm.brain.AutonomousBrain` and returns
burn commands in the same shape as the /api/maneuver/schedule payload
(`burn_id`, `burnTime` as POSIX seconds, `deltaV_vector` in ECI km/s), plus
`maneuver_type` and `estimated_fuel_kg`. The autopilot uses `plugin.mode` to steer the
brain; the plugins can also be called directly for a single satellite.
"""
from abc import ABC, abstractmethod
from typing import List, Optional, Union

import numpy as np

from satellite_api.acm.brain import AutonomousBrain, Conjunction


class AvoidancePlugin(ABC):
    """Abstract base class for collision avoidance algorithm plugins."""
    mode: str = "auto"

    @abstractmethod
    def name(self) -> str:
        pass

    @abstractmethod
    def description(self) -> str:
        pass

    def plan(self, sat_state, fuel: float, conjunctions: List[Union[dict, Conjunction]], time_ts: float,
             nominal_state: Optional[np.ndarray] = None, sat_id: str = "SAT") -> List[dict]:
        """Returns the burns needed to avoid the given conjunctions (empty if none required).

        conjunctions: `Conjunction` objects or dicts with `tca_ts` (POSIX s) and
        `miss_distance_km` (optionally `relative_velocity_kms`, `id`).
        """
        state = np.asarray(sat_state, dtype=np.float64).reshape(6)
        threats = [self._as_conjunction(c, time_ts) for c in conjunctions]
        threats = [t for t in threats if t.tca_seconds > 0]
        if not threats:
            return []
        brain = AutonomousBrain()
        nominal = state if nominal_state is None else np.asarray(nominal_state, dtype=np.float64).reshape(6)
        sequence = brain.calculate_perfect_evasion_sequence(0, threats, fuel, state, nominal, mode=self.mode)
        return [{
            "burn_id": f"{self.name().upper()}-{sat_id}-{i + 1}",
            "burnTime": time_ts + p.burn_time_offset_s,
            "deltaV_vector": p.delta_v_eci_dict,
            "maneuver_type": p.maneuver_type.value,
            "estimated_fuel_kg": p.estimated_fuel_kg,
        } for i, p in enumerate(sequence)]

    @staticmethod
    def _as_conjunction(c: Union[dict, Conjunction], time_ts: float) -> Conjunction:
        if isinstance(c, Conjunction):
            return c
        tca_ts = c.get("tca_ts", c.get("tca"))
        return Conjunction(
            sat_idx=0, debris_idx=0, tca_seconds=float(tca_ts) - time_ts,
            miss_distance_km=float(c.get("miss_distance_km", c.get("miss_km", 0.0))),
            relative_velocity_kms=float(c.get("relative_velocity_kms", 0.0)),
            risk_score=float(c.get("risk_score", 1.0)),
        )


class AutoPlugin(AvoidancePlugin):
    """Lets the planner choose: fuel-efficient transverse phasing when the resulting drift stays
    inside the station-keeping box, otherwise a radial shunt."""
    mode = "auto"

    def name(self) -> str:
        return "Auto"

    def description(self) -> str:
        return "Transverse tri-shunt when it keeps the satellite in its box, radial shunt otherwise."


class TriShuntPlugin(AvoidancePlugin):
    """
    Standard Tri-Shunt avoidance algorithm.
    Optimizes for fuel with a three-burn transverse phasing sequence
    (prograde, retrograde ×2 after one orbit, prograde recovery).
    """
    mode = "transverse"

    def name(self) -> str:
        return "TriShunt"

    def description(self) -> str:
        return "Three transverse burns: phase along-track to open the miss distance, then restore the slot."


class RadialOverridePlugin(AvoidancePlugin):
    """Emergency avoidance that forces a radial shunt and a recovery burn one orbit later."""
    mode = "radial"

    def name(self) -> str:
        return "RadialOverride"

    def description(self) -> str:
        return "Radial shunt now and a matching recovery burn one orbit later; fastest separation."


# Plugin Registry
PLUGINS = {
    "Auto": AutoPlugin(),
    "TriShunt": TriShuntPlugin(),
    "RadialOverride": RadialOverridePlugin(),
}


def get_plugin(name: str) -> AvoidancePlugin:
    if name in PLUGINS:
        return PLUGINS[name]
    raise ValueError(f"Avoidance plugin '{name}' not found.")
