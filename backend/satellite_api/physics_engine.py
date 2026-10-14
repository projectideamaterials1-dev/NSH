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
where the (N, 6) state arrays are propagated IN PLACE (RK4 + J2 + optional drag) and
`collisions` is an (M, 5) array of [sat_idx, target_idx, is_debris, miss_km, tca_s].

Atmospheric drag (configure_drag) uses the piecewise exponential atmosphere of Vallado,
"Fundamentals of Astrodynamics and Applications", Table 8-4, co-rotating with the Earth,
scaled by a solar/geomagnetic activity factor derived from NOAA F10.7 and Kp
(density_scale). Each object can carry its own ballistic coefficient Cd*A/m (for catalog
objects it is derived from the element set's B* term); NaN / non-positive entries fall back to
the global value set by configure_drag.
"""
import logging
import math
import os

import numpy as np

logger = logging.getLogger(__name__)

MU_EARTH = 398600.4418
R_EARTH = 6378.137
J2 = 1.08263e-3
J2_CONST = 1.5 * J2 * MU_EARTH * R_EARTH * R_EARTH

CHUNK_DT = 5.0              # CCD sub-interval (matches the C++ engine)
MAX_INTEGRATION_STEP = 1.0  # RK4 step for the NumPy fallback (matches the C++ engine)
OMEGA_EARTH = 7.292115e-5   # rad/s, atmosphere co-rotation

# Vallado Table 8-4: base altitude [km], base density [kg/m^3], scale height [km], from 100 km up.
# The same table is compiled into the C++ engine (acm_engine/physics_rk4.cpp).
ATMOSPHERE_TABLE = np.array([
    (100, 5.297e-7, 5.877), (110, 9.661e-8, 7.263), (120, 2.438e-8, 9.473), (130, 8.484e-9, 12.636),
    (140, 3.845e-9, 16.149), (150, 2.070e-9, 22.523), (180, 5.464e-10, 29.740), (200, 2.789e-10, 37.105),
    (250, 7.248e-11, 45.546), (300, 2.418e-11, 53.628), (350, 9.518e-12, 53.298), (400, 3.725e-12, 58.515),
    (450, 1.585e-12, 60.828), (500, 6.967e-13, 63.822), (600, 1.454e-13, 71.835), (700, 3.614e-14, 88.667),
    (800, 1.170e-14, 124.64), (900, 5.245e-15, 181.05), (1000, 3.019e-15, 268.00),
])
DRAG_CEILING_KM = 2500.0    # above this drag is negligible and skipped

_drag = {"enabled": False, "ballistic": 0.01, "scale": 1.0}


def atmospheric_density(alt_km) -> np.ndarray:
    """Nominal density [kg/m^3] for an array of (spherical-Earth) altitudes [km]."""
    alt = np.asarray(alt_km, dtype=float)
    table = ATMOSPHERE_TABLE
    idx = np.clip(np.searchsorted(table[:, 0], alt, side="right") - 1, 0, len(table) - 1)
    rho = table[idx, 1] * np.exp(-(alt - table[idx, 0]) / table[idx, 2])
    return np.where(alt > DRAG_CEILING_KM, 0.0, rho)


def density_scale(f107_sfu, kp) -> float:
    """Activity multiplier on the nominal atmosphere from F10.7 [sfu] and Kp.

    Jacchia-style exospheric temperature T = 379 + 3.24*F10.7 + 28*Kp + 0.03*exp(Kp); the scale
    height is taken proportional to T and the density ratio is evaluated at a representative
    450 km against reference conditions (F10.7 = 150 sfu, Kp = 2). Clamped to [0.1, 10].
    """
    def temperature(f, k):
        return 379.0 + 3.24 * f + 28.0 * k + 0.03 * math.exp(k)
    f = 150.0 if f107_sfu is None else float(f107_sfu)
    k = 2.0 if kp is None else float(kp)
    ratio = temperature(f, k) / temperature(150.0, 2.0)
    span, h_ref = 450.0 - 120.0, 60.0
    return float(min(10.0, max(0.1, math.exp(span / h_ref - span / (h_ref * ratio)))))


def effective_ballistic(ballistic, n: int) -> np.ndarray:
    """Per-row Cd*A/m with invalid / missing entries replaced by the global value."""
    if ballistic is None:
        return np.full(n, _drag["ballistic"])
    b = np.asarray(ballistic, dtype=float)
    return np.where(np.isfinite(b) & (b > 0), b, _drag["ballistic"])


def drag_acceleration(r: np.ndarray, v: np.ndarray, ballistic=None) -> np.ndarray:
    """Drag acceleration [km/s^2] for (N, 3) ECI positions/velocities [km, km/s]; `ballistic`
    is an optional per-row Cd*A/m array."""
    v_rel = v.copy()
    v_rel[:, 0] += OMEGA_EARTH * r[:, 1]
    v_rel[:, 1] -= OMEGA_EARTH * r[:, 0]
    alt = np.sqrt(np.einsum("ij,ij->i", r, r)) - R_EARTH
    rho = atmospheric_density(alt) * _drag["scale"]
    speed = np.sqrt(np.einsum("ij,ij->i", v_rel, v_rel))
    # 0.5*rho*B*|v|*v is m/s^2 for v in m/s; with v in km/s that is x1e6, then /1e3 to km/s^2.
    return (-0.5e3 * effective_ballistic(ballistic, len(r)) * rho * speed)[:, None] * v_rel


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
                     max_step: float = MAX_INTEGRATION_STEP, drag: bool = True, ballistic=None) -> None:
    """Propagates an (N, 6) ECI state array in place with fixed-step RK4 + J2 (+ drag).

    Drag applies when configure_drag() enabled it; pass drag=False for drag-free reference
    orbits such as the station-keeping ghost slots.
    """
    if dt_seconds <= 0.0 or len(states) == 0:
        return
    if drag and _drag["enabled"]:
        b = effective_ballistic(ballistic, len(states))

        def accel(r_, v_):
            return j2_acceleration(r_) + drag_acceleration(r_, v_, b)
    else:
        def accel(r_, v_):
            return j2_acceleration(r_)
    steps = max(1, int(math.ceil(dt_seconds / max_step)))
    h = dt_seconds / steps
    r = states[:, 0:3]
    v = states[:, 3:6]
    for _ in range(steps):
        a1 = accel(r, v)
        v2 = v + 0.5 * h * a1
        a2 = accel(r + 0.5 * h * v, v2)
        v3 = v + 0.5 * h * a2
        a3 = accel(r + 0.5 * h * v2, v3)
        v4 = v + h * a3
        a4 = accel(r + h * v3, v4)
        r += (h / 6.0) * (v + 2.0 * v2 + 2.0 * v3 + v4)
        v += (h / 6.0) * (a1 + 2.0 * a2 + 2.0 * a3 + a4)


def _numpy_process_conjunctions(sat_states: np.ndarray, debris_states: np.ndarray,
                                threshold: float, dt_seconds: float, sat_ballistic=None, debris_ballistic=None):
    n_sats = len(sat_states)
    collisions = []
    reported = set()
    thr2 = threshold * threshold

    t_elapsed = 0.0
    while t_elapsed < dt_seconds - 1e-12:
        chunk = min(CHUNK_DT, dt_seconds - t_elapsed)
        sat_prev = sat_states[:, 0:3].copy()
        deb_prev = debris_states[:, 0:3].copy()

        propagate_states(sat_states, chunk, ballistic=sat_ballistic)
        propagate_states(debris_states, chunk, ballistic=debris_ballistic)

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
    _native_set_drag = getattr(_acm_engine, "set_drag", None)
except ImportError:
    _native = None
    _native_set_drag = None

ENGINE_NAME = "cpp" if _native is not None else "numpy"

# GPU offload (gpu_engine.py): ACM_ENGINE=auto (default) uses CUDA for calls with at least
# ACM_GPU_MIN_OBJECTS objects and ACM_GPU_MIN_WORK object-seconds of propagation. Below that, kernel
# launches (two per 5 s chunk) cost more than the C++ engine saves. Measured on an RTX 3070 Ti vs a
# 6-core i5-10600K: 520 objects x 3600 s 0.12 s CPU / 0.38 s GPU; 1,550 x 10,800 s 0.86 / 0.53;
# 20,200 x 300 s 0.24 / 0.17; 20,500 x 10,800 s 11.0 / 1.2. ACM_ENGINE=cuda forces the GPU for every
# call; cpp / numpy keep everything on the CPU.
_ENGINE_MODE = os.environ.get("ACM_ENGINE", "auto").strip().lower()
GPU_MIN_WORK = float(os.environ.get("ACM_GPU_MIN_WORK", "5e6"))
GPU_MIN_OBJECTS = int(os.environ.get("ACM_GPU_MIN_OBJECTS", "1000"))


def _gpu_for(n_objects: int, dt_seconds: float) -> bool:
    if _ENGINE_MODE in ("cpp", "numpy", "cpu"):
        return False
    from satellite_api import gpu_engine
    if not gpu_engine.available():
        return False
    return _ENGINE_MODE == "cuda" or (n_objects >= GPU_MIN_OBJECTS and n_objects * dt_seconds >= GPU_MIN_WORK)


def _gpu_failed(e: Exception) -> None:
    from satellite_api import gpu_engine
    gpu_engine.disable(f"runtime failure ({type(e).__name__}: {e})")


def engine_info() -> dict:
    """What runs where: CPU engine, and the GPU (if any) used for large calls."""
    from satellite_api import gpu_engine
    gpu = gpu_engine.available() and _ENGINE_MODE not in ("cpp", "numpy", "cpu")
    return {"cpu": ENGINE_NAME, "gpu": gpu_engine.device_name() if gpu else None,
            "mode": _ENGINE_MODE, "gpu_min_work_object_seconds": GPU_MIN_WORK, "gpu_min_objects": GPU_MIN_OBJECTS,
            "gpu_unavailable_reason": None if gpu else gpu_engine.unavailable_reason()}
if _native is None:
    logger.warning("acm_engine C++ extension not available; using NumPy fallback engine.")
elif _native_set_drag is None:
    logger.warning("acm_engine was built without drag support; rebuild it (pip install .) to model drag in C++.")


def configure_drag(enabled: bool, ballistic_m2_per_kg: float = 0.01, scale: float = 1.0) -> None:
    """Sets the drag model for the NumPy engine and, when it supports drag, the C++ engine."""
    _drag.update(enabled=bool(enabled), ballistic=float(ballistic_m2_per_kg), scale=float(scale))
    if _native_set_drag is not None:
        _native_set_drag(bool(enabled), float(ballistic_m2_per_kg), float(scale))


def drag_settings() -> dict:
    return {**_drag, "native_support": _native_set_drag is not None}


def propagate_fast(states: np.ndarray, dt_seconds: float, ballistic=None) -> None:
    """In-place propagation through the C++ engine when it supports the active force model
    (no conjunction search), the NumPy integrator otherwise. For bulk look-ahead work."""
    if dt_seconds <= 0.0 or len(states) == 0:
        return
    if _gpu_for(len(states), dt_seconds):
        from satellite_api import gpu_engine
        backup = states.copy()
        try:
            gpu_engine.propagate(states, dt_seconds, _drag, ballistic)
            return
        except Exception as e:      # the GPU died mid-run: restore the input and redo it on the CPU
            states[...] = backup
            _gpu_failed(e)
    if _native is not None and (_native_set_drag is not None or not _drag["enabled"]):
        work = states if states.flags.c_contiguous and states.dtype == np.float64 else np.ascontiguousarray(states, dtype=np.float64)
        _native(np.zeros((0, 6)), work, 0.0, dt_seconds, None, _native_ballistic(ballistic))
        if work is not states:
            states[...] = work
    else:
        propagate_states(states, dt_seconds, ballistic=ballistic)


def _native_ballistic(ballistic):
    """Per-object Cd*A/m for the C++ engine with every invalid entry replaced by -1 (= use the global
    value). The engine is built with -ffast-math, which assumes NaN never occurs, so NaN must not
    reach it."""
    if ballistic is None:
        return None
    b = np.asarray(ballistic, dtype=np.float64)
    return np.ascontiguousarray(np.where(np.isfinite(b) & (b > 0), b, -1.0))


def process_conjunctions(sat_states: np.ndarray, debris_states: np.ndarray,
                         threshold: float, dt_seconds: float, sat_ballistic=None, debris_ballistic=None):
    """Propagates both arrays in place (optionally with per-object Cd*A/m) and returns CCD hits."""
    if _gpu_for(len(sat_states) + len(debris_states), dt_seconds):
        from satellite_api import gpu_engine
        backup = sat_states.copy(), debris_states.copy()
        try:
            return gpu_engine.process_conjunctions(sat_states, debris_states, threshold, dt_seconds, _drag,
                                                   sat_ballistic, debris_ballistic)
        except Exception as e:      # the arrays may already be written back: restore before the CPU retry
            sat_states[...], debris_states[...] = backup
            _gpu_failed(e)
    # A native build without drag support would silently drop drag; use NumPy then.
    if _native is not None and (_native_set_drag is not None or not _drag["enabled"]):
        if sat_ballistic is None and debris_ballistic is None:
            return _native(sat_states, debris_states, threshold, dt_seconds)
        return _native(sat_states, debris_states, threshold, dt_seconds,
                       _native_ballistic(sat_ballistic), _native_ballistic(debris_ballistic))
    return _numpy_process_conjunctions(sat_states, debris_states, threshold, dt_seconds, sat_ballistic, debris_ballistic)
