"""
config.py
---------
Runtime simulation parameters. Defaults are the NSH 2026 problem-statement values;
the dashboard Settings dialog (POST /api/config) updates them live and persists them
to data/config.json so they survive restarts.
"""
import json
import logging
import os
from dataclasses import asdict, dataclass, fields

from satellite_api.timeutils import data_dir

logger = logging.getLogger(__name__)


@dataclass
class SimConfig:
    dryMass: float = 500.0               # kg
    initialFuel: float = 50.0            # kg, applied to newly ingested satellites
    stationKeepingRadius: float = 10.0   # km
    maxDeltaV: float = 15.0              # m/s per burn
    cooldownSeconds: float = 600.0       # s between burns
    eolFuelThreshold: float = 2.5        # kg, graveyard trigger
    lowFuelWarning: float = 10.0         # kg, alert threshold
    autopilotEnabled: bool = True
    avoidanceStrategy: str = "Auto"      # Auto | TriShunt | RadialOverride
    cdmWarningKm: float = 5.0            # screening sphere
    cdmHorizonSeconds: float = 10800.0   # look-ahead (3 h)
    cdmScreenIntervalSeconds: float = 600.0  # sim seconds between automatic screens

    LIMITS = {
        "dryMass": (100.0, 5000.0), "initialFuel": (1.0, 1000.0), "stationKeepingRadius": (0.5, 100.0),
        "maxDeltaV": (0.1, 100.0), "cooldownSeconds": (0.0, 7200.0), "eolFuelThreshold": (0.0, 100.0),
        "lowFuelWarning": (0.0, 500.0), "cdmWarningKm": (0.1, 50.0), "cdmHorizonSeconds": (600.0, 172800.0),
        "cdmScreenIntervalSeconds": (60.0, 86400.0),
    }
    STRATEGIES = ("Auto", "TriShunt", "RadialOverride")

    def update(self, values: dict) -> None:
        """Validates and applies a partial update. Raises ValueError on bad input."""
        known = {f.name: f for f in fields(self)}
        unknown = set(values) - set(known)
        if unknown:
            raise ValueError(f"Unknown config keys: {sorted(unknown)}")
        staged = {}
        for key, value in values.items():
            current = getattr(self, key)
            if isinstance(current, bool):
                if not isinstance(value, bool):
                    raise ValueError(f"{key} must be true or false")
            elif isinstance(current, float):
                try:
                    value = float(value)
                except (TypeError, ValueError):
                    raise ValueError(f"{key} must be a number")
                lo, hi = self.LIMITS[key]
                if not lo <= value <= hi:
                    raise ValueError(f"{key} must be between {lo} and {hi}")
            elif key == "avoidanceStrategy" and value not in self.STRATEGIES:
                raise ValueError(f"avoidanceStrategy must be one of {list(self.STRATEGIES)}")
            staged[key] = value
        for key, value in staged.items():
            setattr(self, key, value)

    def to_dict(self) -> dict:
        return asdict(self)


def _config_path():
    return data_dir() / "config.json"


def load_config() -> SimConfig:
    cfg = SimConfig()
    if os.environ.get("AUTOPILOT") is not None:
        cfg.autopilotEnabled = os.environ["AUTOPILOT"].strip().lower() not in ("0", "false", "off", "no")
    for env, key in (("CDM_HORIZON_S", "cdmHorizonSeconds"), ("CDM_SCREEN_INTERVAL_S", "cdmScreenIntervalSeconds"),
                     ("CDM_WARNING_KM", "cdmWarningKm")):
        if os.environ.get(env):
            cfg.update({key: os.environ[env]})
    path = _config_path()
    if path.exists() and os.environ.get("ACM_IGNORE_SAVED_CONFIG") != "1":
        try:
            cfg.update(json.loads(path.read_text()))
        except (ValueError, OSError) as e:
            logger.warning(f"Ignoring invalid {path}: {e}")
    return cfg


def save_config(cfg: SimConfig) -> None:
    path = _config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cfg.to_dict(), indent=2))


CONFIG = load_config()
