from abc import ABC, abstractmethod
from typing import List, Optional
import math

class AvoidancePlugin(ABC):
    """Abstract base class for collision avoidance algorithm plugins."""
    @abstractmethod
    def name(self) -> str:
        pass

    @abstractmethod
    def plan(self, sat_state, fuel: float, conjunctions: List[dict], time_ts: float) -> List[dict]:
        """
        Returns a list of burns to perform for avoidance.
        """
        pass

class TriShuntPlugin(AvoidancePlugin):
    """
    Standard Tri-Shunt avoidance algorithm.
    Optimizes for fuel by performing small radial-transverse shifts.
    """
    def name(self) -> str:
        return "TriShunt"

    def plan(self, sat_state, fuel, conjunctions, time_ts) -> List[dict]:
        # Implementation of the core avoidance logic
        if not conjunctions:
            return []
            
        # Example logic: just a placeholder for the actual brain logic
        # In a real implementation, this would contain the physics-based planning.
        primary = conjunctions[0]
        burn_time = primary['tca_ts'] - 300.0 # 5 minutes before TCA
        
        return [{
            "burn_id": f"AVOID-{primary['id'][:8]}",
            "burnTime": burn_time,
            "deltaV_vector": {"x": 0.0, "y": 0.005, "z": 0.0}
        }]

class RadialOverridePlugin(AvoidancePlugin):
    """Emergency avoidance that forces a significant radial maneuver."""
    def name(self) -> str:
        return "RadialOverride"

    def plan(self, sat_state, fuel, conjunctions, time_ts) -> List[dict]:
        if not conjunctions: return []
        primary = conjunctions[0]
        return [{
            "burn_id": "EMERGENCY-RADIAL",
            "burnTime": time_ts + 30.0,
            "deltaV_vector": {"x": 0.0, "y": 0.0, "z": 0.015}
        }]

# Plugin Registry
PLUGINS = {
    "TriShunt": TriShuntPlugin(),
    "RadialOverride": RadialOverridePlugin()
}

def get_plugin(name: str) -> AvoidancePlugin:
    if name in PLUGINS:
        return PLUGINS[name]
    raise ValueError(f"Avoidance plugin '{name}' not found.")
