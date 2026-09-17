"""
physics_engine.py
-----------------
Single entry point for orbital propagation + continuous collision detection.

Uses the compiled C++ `acm_engine` extension when it is installed and falls back
to an equivalent vectorised NumPy implementation otherwise, so the API remains
functional on machines where the extension has not been built.

Both implementations share one contract:
    process_conjunctions(sat_states, debris_states, threshold_km, dt_seconds)
        -> (sat_states, debris_states, collisions)
where the (N, 6) state arrays are propagated IN PLACE (RK4 + J2) and
`collisions` is an (M, 5) array of [sat_idx, target_idx, is_debris, miss_km, tca_s].
"""
import logging
import math

import numpy as np

logger = logging.getLogger(__name__)

MU_EARTH = 398600.4418
R_EARTH = 6378.137
J2 = 1.08263e-3
J2_CONST = 1.5 * J2 * MU_EARTH * R_EARTH * R_EARTH

CHUNK_DT = 5.0              # CCD sub-interval (matches the C++ engine)
MAX_INTEGRATION_STEP = 1.0  # RK4 step for the NumPy fallback (matches the C++ engine)


def j2_acceleration(r: np.ndarray) -> np.ndarray:
    """Two-body + J2 acceleration for an (N, 3) array of ECI positions [km/s^2]."""
    x, y, z = r[:, 0], r[:, 1], r[:, 2]
    r2 = x * x + y * y + z * z
    r_inv = 1.0 / np.sqrt(r2)
    r2_inv = r_inv * r_inv
    r3_inv = r2_inv * r_inv
    a_two_body = -MU_EARTH * r3_inv
    j2_factor = J2_CONST * r3_inv * r2_inv
    z2_r2 = z * z * r2_inv
    t_xy = a_two_body + j2_factor * (5.0 * z2_r2 - 1.0)
    t_z = a_two_body + j2_factor * (5.0 * z2_r2 - 3.0)
    return np.column_stack((x * t_xy, y * t_xy, z * t_z))


def propagate_states(states: np.ndarray, dt_seconds: float,
                     max_step: float = MAX_INTEGRATION_STEP) -> None:
    """Propagates an (N, 6) ECI state array in place with fixed-step RK4 + J2."""
    if dt_seconds <= 0.0 or len(states) == 0:
        return
    steps = max(1, int(math.ceil(dt_seconds / max_step)))
    h = dt_seconds / steps
    r = states[:, 0:3]
    v = states[:, 3:6]
    for _ in range(steps):
        a1 = j2_acceleration(r)
        v2 = v + 0.5 * h * a1
        a2 = j2_acceleration(r + 0.5 * h * v)
        v3 = v + 0.5 * h * a2
        a3 = j2_acceleration(r + 0.5 * h * v2)
        v4 = v + h * a3
        a4 = j2_acceleration(r + h * v3)
        r += (h / 6.0) * (v + 2.0 * v2 + 2.0 * v3 + v4)
        v += (h / 6.0) * (a1 + 2.0 * a2 + 2.0 * a3 + a4)


def _numpy_process_conjunctions(sat_states: np.ndarray, debris_states: np.ndarray,
                                threshold: float, dt_seconds: float):
    n_sats = len(sat_states)
    collisions = []
    reported = set()
    thr2 = threshold * threshold

    t_elapsed = 0.0
    while t_elapsed < dt_seconds - 1e-12:
        chunk = min(CHUNK_DT, dt_seconds - t_elapsed)
        sat_prev = sat_states[:, 0:3].copy()
        deb_prev = debris_states[:, 0:3].copy()

        propagate_states(sat_states, chunk)
        propagate_states(debris_states, chunk)

        if n_sats:
            sat_disp = sat_states[:, 0:3] - sat_prev
            deb_disp = debris_states[:, 0:3] - deb_prev
            # Linear CCD over the chunk: minimise |r0 + s*d| for s in [0, 1].
            for s in range(n_sats):
                for is_deb, prev, disp, start in (
                    (1.0, deb_prev, deb_disp, 0),
                    (0.0, sat_prev, sat_disp, s + 1),
                ):
                    if start >= len(prev):
                        continue
                    r0 = prev[start:] - sat_prev[s]
                    d = disp[start:] - sat_disp[s]
                    # Cheap broad-phase: skip pairs that cannot close the gap in this chunk
                    reach = np.sqrt(np.einsum("ij,ij->i", d, d)) + threshold
                    near = np.einsum("ij,ij->i", r0, r0) <= reach * reach
                    if not near.any():
                        continue
                    idx = np.nonzero(near)[0]
                    r0n, dn = r0[idx], d[idx]
                    dd = np.einsum("ij,ij->i", dn, dn)
                    rd = np.einsum("ij,ij->i", r0n, dn)
                    frac = np.where(dd > 1e-12, np.clip(-rd / np.maximum(dd, 1e-12), 0.0, 1.0), 0.0)
                    closest = r0n + frac[:, None] * dn
                    dist2 = np.einsum("ij,ij->i", closest, closest)
                    for k in np.nonzero(dist2 < thr2)[0]:
                        target = int(idx[k]) + start
                        key = (s, target, is_deb)
                        if key in reported:
                            continue
                        reported.add(key)
                        collisions.append((float(s), float(target), is_deb,
                                           float(math.sqrt(dist2[k])),
                                           t_elapsed + float(frac[k]) * chunk))
        t_elapsed += chunk

    result = np.array(collisions, dtype=np.float64).reshape(-1, 5)
    return sat_states, debris_states, result


try:
    import acm_engine as _acm_engine  # compiled C++ extension
    _native = getattr(_acm_engine, "process_conjunctions", None)
except ImportError:
    _native = None

ENGINE_NAME = "cpp" if _native is not None else "numpy"
if _native is None:
    logger.warning("acm_engine C++ extension not available; using NumPy fallback engine.")


def process_conjunctions(sat_states: np.ndarray, debris_states: np.ndarray,
                         threshold: float, dt_seconds: float):
    if _native is not None:
        return _native(sat_states, debris_states, threshold, dt_seconds)
    return _numpy_process_conjunctions(sat_states, debris_states, threshold, dt_seconds)
