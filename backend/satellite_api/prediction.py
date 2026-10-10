"""
prediction.py
-------------
Look-ahead frames for the dashboard's time scrubber: every satellite propagated forward with
the engine's force model, applying the burns already queued for it at their epochs, sampled
every `step_s`. Debris is not included (thousands of objects x many frames would dwarf the
payload); predicted conjunctions are reported as timeline events instead.
"""
from datetime import datetime, timezone
from typing import Dict, List, Sequence

import numpy as np

from satellite_api.coordinates import convert_states_to_lla
from satellite_api.physics_engine import propagate_fast
from satellite_api.timeutils import iso_z


def _advance(states: np.ndarray, dt: float) -> None:
    if dt > 1e-9:
        propagate_fast(states, dt)


def predict_frames(sat_states: np.ndarray, sat_ids: Sequence[str], queue: Sequence[tuple], start_ts: float,
                   horizon_s: float, step_s: float) -> Dict[str, object]:
    """queue: maneuver tuples (burn_ts, sat_id, dvx, dvy, dvz, ...) in ECI km/s."""
    states = np.ascontiguousarray(sat_states, dtype=np.float64).copy()
    row = {sid: i for i, sid in enumerate(sat_ids)}
    burns = sorted((float(m[0]), row[m[1]], np.array(m[2:5], dtype=float))
                   for m in queue if m[1] in row and start_ts < float(m[0]) <= start_ts + horizon_s)
    frames: List[dict] = []
    t, b = start_ts, 0
    n_frames = int(horizon_s // step_s)
    for k in range(1, n_frames + 1):
        target = start_ts + k * step_s
        while b < len(burns) and burns[b][0] <= target:
            _advance(states, burns[b][0] - t)
            t = burns[b][0]
            states[burns[b][1], 3:] += burns[b][2]
            b += 1
        _advance(states, target - t)
        t = target
        lla = convert_states_to_lla(states, datetime.fromtimestamp(t, tz=timezone.utc), as_array=True)
        frames.append({
            "timestamp": iso_z(t),
            # [lon, lat, alt_km] per satellite, rounded for payload size
            "positions": np.round(np.column_stack([lla[:, 2], lla[:, 1], lla[:, 3]]), 4).tolist(),
        })
    return {"frames": frames, "burns_applied": b}
