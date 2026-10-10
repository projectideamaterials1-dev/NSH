"""
realworld/validation.py
-----------------------
Cross-checks the engine's numerical propagator (RK4 + J2, optional drag) against SGP4,
the propagator the public element sets are fitted for.

Both start from the same SGP4 state at the element-set epoch; the engine then integrates
freely while SGP4 is evaluated at the same instants. Frames are TEME on both sides (the
engine ignores the slow TEME->inertial drift, which is far below these error levels over
a day). The ballistic coefficient defaults to the one implied by the element set's
B* drag term (B = 2·B*/ρ₀, ρ₀ = 0.15696615 kg/m²/ER). Used by tests/regression/test_propagation_validation.py and
scripts/validate_propagation.py.
"""
from typing import Dict, Iterable, List

import numpy as np
from sgp4.api import Satrec

from satellite_api.physics_engine import _drag, configure_drag, density_scale, propagate_states

DEFAULT_HOURS = (0.5, 1, 2, 3, 6, 9, 12, 18, 24)
from satellite_api.realworld.catalog import BSTAR_RHO0  # noqa: E402  (single definition)


def ballistic_from_bstar(bstar: float, default: float = 0.01) -> float:
    """Cd*A/m [m^2/kg] implied by an element set's B* [1/ER]."""
    return 2.0 * bstar / BSTAR_RHO0 if bstar and bstar > 0 else default


def compare_with_sgp4(satrec: Satrec, hours: Iterable[float] = DEFAULT_HOURS, drag: bool = True,
                      ballistic: float = None, f107=None, kp=None) -> List[Dict[str, float]]:
    """Position difference |engine - SGP4| [km] at each requested time after epoch."""
    saved = dict(_drag)
    if ballistic is None:
        ballistic = ballistic_from_bstar(satrec.bstar)
    configure_drag(drag, ballistic, density_scale(f107, kp))
    try:
        jd, fr = satrec.jdsatepoch, satrec.jdsatepochF
        err, r, v = satrec.sgp4(jd, fr)
        if err:
            raise ValueError(f"SGP4 error {err} at epoch")
        state = np.array([[*r, *v]], dtype=float)
        rows, t = [], 0.0
        for h in sorted(hours):
            target = h * 3600.0
            propagate_states(state, target - t, max_step=2.0)
            t = target
            err, r_ref, _ = satrec.sgp4(jd, fr + t / 86400.0)
            if err:
                break
            delta = state[0, :3] - np.array(r_ref)
            rows.append({"hours": float(h), "error_km": float(np.linalg.norm(delta))})
        return rows
    finally:
        configure_drag(saved["enabled"], saved["ballistic"], saved["scale"])
