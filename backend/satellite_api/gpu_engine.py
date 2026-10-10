"""
gpu_engine.py
-------------
CUDA implementation of the engine contract (physics_engine.process_conjunctions) via CuPy:

  * `propagate` kernel - one thread per object, the same fixed-step RK4 + J2 + drag as
    acm_engine/physics_rk4.cpp (double precision; per-object ballistic coefficients);
  * `ccd` kernel - one thread per (satellite, object) pair per 5 s chunk, the same linear
    continuous collision detection; hits are appended to a device buffer and de-duplicated on
    the host (first occurrence per pair, matching the C++ engine).

States stay on the GPU for the whole call (one upload, one download), so a 3 h screening
horizon is ~2,000 chunk iterations of two kernel launches each.

Optional: needs an NVIDIA GPU and requirements-gpu.txt (CuPy + the NVRTC / CUDA runtime wheels;
no CUDA toolkit install). Without them `available()`
is False and the CPU engines are used. physics_engine decides per call (ACM_ENGINE /
ACM_GPU_MIN_WORK) because small calls are faster on the CPU than a kernel round trip.
"""
import glob
import logging
import math
import os
import site
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

CHUNK_DT = 5.0
MAX_INTEGRATION_STEP = 1.0
THREADS = 256
HIT_CAPACITY = 1 << 20

_cp = None
_kernels = None
_error: Optional[str] = None


def _prepare_cuda_paths():
    """Wire the pip-installed NVIDIA wheels (NVRTC, runtime headers) into the loader / compiler search
    path, so no system CUDA toolkit is needed (Windows: DLL directories + PATH; Linux: preload the
    shared objects by full path, which later dlopen() calls by soname then reuse)."""
    roots = [os.path.join(p, "nvidia") for p in site.getsitepackages() + [site.getusersitepackages()]]
    for root in roots:
        runtime = os.path.join(root, "cuda_runtime")
        if "CUDA_PATH" not in os.environ and os.path.isdir(os.path.join(runtime, "include")):
            os.environ["CUDA_PATH"] = runtime
        if os.name == "nt":
            for bin_dir in glob.glob(os.path.join(root, "*", "bin")):
                os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
                try:
                    os.add_dll_directory(bin_dir)
                except (OSError, AttributeError):
                    pass
        else:
            import ctypes
            for pattern in ("cuda_nvrtc/lib/libnvrtc-builtins.so*", "cuda_nvrtc/lib/libnvrtc.so*",
                            "cuda_runtime/lib/libcudart.so*"):
                for lib in sorted(glob.glob(os.path.join(root, pattern))):
                    try:
                        ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)
                    except OSError:
                        pass


_SOURCE = r"""
#define MU_EARTH 398600.4418
#define R_EARTH 6378.137
#define J2_CONST (1.5 * 1.08263e-3 * MU_EARTH * R_EARTH * R_EARTH)
#define OMEGA_EARTH 7.292115e-5
#define DRAG_CEILING_KM 2500.0
#define ATMO_ROWS 19

__constant__ float ATMO_H0[ATMO_ROWS] = {100, 110, 120, 130, 140, 150, 180, 200, 250, 300, 350, 400,
                                         450, 500, 600, 700, 800, 900, 1000};
__constant__ float ATMO_RHO[ATMO_ROWS] = {5.297e-7, 9.661e-8, 2.438e-8, 8.484e-9, 3.845e-9, 2.070e-9,
                                           5.464e-10, 2.789e-10, 7.248e-11, 2.418e-11, 9.518e-12, 3.725e-12,
                                           1.585e-12, 6.967e-13, 1.454e-13, 3.614e-14, 1.170e-14, 5.245e-15,
                                           3.019e-15};
__constant__ float ATMO_H[ATMO_ROWS] = {5.877, 7.263, 9.473, 12.636, 16.149, 22.523, 29.740, 37.105,
                                         45.546, 53.628, 53.298, 58.515, 60.828, 63.822, 71.835, 88.667,
                                         124.64, 181.05, 268.00};

// Drag is a ~1e-9 km/s^2 perturbation in LEO, so it is evaluated in FP32 (consumer GPUs run FP64
// exp() at 1/64 rate). Gravity stays FP64. Measured against the FP64 C++ engine: <= 3 mm position
// difference after 3 h (tests/benchmark/gpu_vs_cpu.py).
__device__ __forceinline__ float density(float alt_km) {
    if (alt_km > (float)DRAG_CEILING_KM) return 0.0f;
    int i = 0;
    while (i + 1 < ATMO_ROWS && alt_km >= ATMO_H0[i + 1]) ++i;
    return ATMO_RHO[i] * __expf(-(alt_km - ATMO_H0[i]) / ATMO_H[i]);
}

__device__ __forceinline__ void accel(double x, double y, double z, double vx, double vy, double vz,
                                      int drag, double b, double scale, double* a) {
    double r2 = x * x + y * y + z * z;
    double r_inv = rsqrt(r2);
    double r2_inv = r_inv * r_inv;
    double r3_inv = r2_inv * r_inv;
    double tb = -MU_EARTH * r3_inv;
    double j2f = J2_CONST * r3_inv * r2_inv;
    double z2 = z * z * r2_inv;
    double txy = tb + j2f * (5.0 * z2 - 1.0);
    a[0] = x * txy; a[1] = y * txy; a[2] = z * (tb + j2f * (5.0 * z2 - 3.0));
    if (drag) {
        float rho = density((float)(r2 * r_inv) - (float)R_EARTH) * (float)scale;
        if (rho > 0.0f) {
            float vrx = (float)(vx + OMEGA_EARTH * y), vry = (float)(vy - OMEGA_EARTH * x), vrz = (float)vz;
            float k = -0.5e3f * (float)b * rho * sqrtf(vrx * vrx + vry * vry + vrz * vrz);
            a[0] += (double)(k * vrx); a[1] += (double)(k * vry); a[2] += (double)(k * vrz);
        }
    }
}

extern "C" __global__ void propagate(double* s, const double* ballistic, int n, int steps, double h,
                                     int drag, double b_global, double scale) {
    int i = blockDim.x * blockIdx.x + threadIdx.x;
    if (i >= n) return;
    double* st = s + 6 * (long long)i;
    double b = ballistic ? ballistic[i] : b_global;
    if (!(b > 0.0)) b = b_global;
    double x = st[0], y = st[1], z = st[2], vx = st[3], vy = st[4], vz = st[5];
    double a1[3], a2[3], a3[3], a4[3];
    for (int k = 0; k < steps; ++k) {
        accel(x, y, z, vx, vy, vz, drag, b, scale, a1);
        double x2 = x + 0.5 * h * vx, y2 = y + 0.5 * h * vy, z2 = z + 0.5 * h * vz;
        double vx2 = vx + 0.5 * h * a1[0], vy2 = vy + 0.5 * h * a1[1], vz2 = vz + 0.5 * h * a1[2];
        accel(x2, y2, z2, vx2, vy2, vz2, drag, b, scale, a2);
        double x3 = x + 0.5 * h * vx2, y3 = y + 0.5 * h * vy2, z3 = z + 0.5 * h * vz2;
        double vx3 = vx + 0.5 * h * a2[0], vy3 = vy + 0.5 * h * a2[1], vz3 = vz + 0.5 * h * a2[2];
        accel(x3, y3, z3, vx3, vy3, vz3, drag, b, scale, a3);
        double x4 = x + h * vx3, y4 = y + h * vy3, z4 = z + h * vz3;
        double vx4 = vx + h * a3[0], vy4 = vy + h * a3[1], vz4 = vz + h * a3[2];
        accel(x4, y4, z4, vx4, vy4, vz4, drag, b, scale, a4);
        double h6 = h / 6.0;
        x += h6 * (vx + 2 * vx2 + 2 * vx3 + vx4);
        y += h6 * (vy + 2 * vy2 + 2 * vy3 + vy4);
        z += h6 * (vz + 2 * vz2 + 2 * vz3 + vz4);
        vx += h6 * (a1[0] + 2 * a2[0] + 2 * a3[0] + a4[0]);
        vy += h6 * (a1[1] + 2 * a2[1] + 2 * a3[1] + a4[1]);
        vz += h6 * (a1[2] + 2 * a2[2] + 2 * a3[2] + a4[2]);
    }
    st[0] = x; st[1] = y; st[2] = z; st[3] = vx; st[4] = vy; st[5] = vz;
}

__device__ __forceinline__ void rk4(double* st, double h, int drag, double b, double scale) {
    double x = st[0], y = st[1], z = st[2], vx = st[3], vy = st[4], vz = st[5];
    double a1[3], a2[3], a3[3], a4[3];
    accel(x, y, z, vx, vy, vz, drag, b, scale, a1);
    double x2 = x + 0.5 * h * vx, y2 = y + 0.5 * h * vy, z2 = z + 0.5 * h * vz;
    double vx2 = vx + 0.5 * h * a1[0], vy2 = vy + 0.5 * h * a1[1], vz2 = vz + 0.5 * h * a1[2];
    accel(x2, y2, z2, vx2, vy2, vz2, drag, b, scale, a2);
    double x3 = x + 0.5 * h * vx2, y3 = y + 0.5 * h * vy2, z3 = z + 0.5 * h * vz2;
    double vx3 = vx + 0.5 * h * a2[0], vy3 = vy + 0.5 * h * a2[1], vz3 = vz + 0.5 * h * a2[2];
    accel(x3, y3, z3, vx3, vy3, vz3, drag, b, scale, a3);
    double x4 = x + h * vx3, y4 = y + h * vy3, z4 = z + h * vz3;
    double vx4 = vx + h * a3[0], vy4 = vy + h * a3[1], vz4 = vz + h * a3[2];
    accel(x4, y4, z4, vx4, vy4, vz4, drag, b, scale, a4);
    double h6 = h / 6.0;
    st[0] = x + h6 * (vx + 2 * vx2 + 2 * vx3 + vx4);
    st[1] = y + h6 * (vy + 2 * vy2 + 2 * vy3 + vy4);
    st[2] = z + h6 * (vz + 2 * vz2 + 2 * vz3 + vz4);
    st[3] = vx + h6 * (a1[0] + 2 * a2[0] + 2 * a3[0] + a4[0]);
    st[4] = vy + h6 * (a1[1] + 2 * a2[1] + 2 * a3[1] + a4[1]);
    st[5] = vz + h6 * (a1[2] + 2 * a2[2] + 2 * a3[2] + a4[2]);
}

// One thread per candidate pair: carry both objects from t=0 to t_start[i] (RK4, <= 1 s steps), then
// sample every `step` seconds over `window` with linear CCD between samples (acm/conjunctions.py).
// out: best miss, best t (relative to t_start) and the states at the sample nearest the TCA.
extern "C" __global__ void refine(const double* A0, const double* B0, const double* t_start,
                                  const double* bal_a, const double* bal_b, int k, double window, double step,
                                  int drag, double b_global, double scale,
                                  double* best_d, double* best_t, double* bestA, double* bestB) {
    int i = blockDim.x * blockIdx.x + threadIdx.x;
    if (i >= k) return;
    double a[6], b[6], an[6], bn[6], sa[6], sb[6];
    for (int j = 0; j < 6; ++j) { a[j] = A0[6 * i + j]; b[j] = B0[6 * i + j]; }
    double ba = bal_a ? bal_a[i] : b_global; if (!(ba > 0.0)) ba = b_global;
    double bb = bal_b ? bal_b[i] : b_global; if (!(bb > 0.0)) bb = b_global;
    double ts = t_start[i];
    if (ts > 1e-9) {
        int n = (int)ceil(ts / 1.0);
        double h = ts / n;
        for (int s = 0; s < n; ++s) { rk4(a, h, drag, ba, scale); rk4(b, h, drag, bb, scale); }
    }
    double bd = 1e300, bt = 0.0;
    for (int j = 0; j < 6; ++j) { sa[j] = a[j]; sb[j] = b[j]; }
    int steps = (int)(window / step);
    for (int s = 0; s < steps; ++s) {
        for (int j = 0; j < 6; ++j) { an[j] = a[j]; bn[j] = b[j]; }
        rk4(an, step, drag, ba, scale); rk4(bn, step, drag, bb, scale);
        double p0x = b[0] - a[0], p0y = b[1] - a[1], p0z = b[2] - a[2];
        double dx = (bn[0] - an[0]) - p0x, dy = (bn[1] - an[1]) - p0y, dz = (bn[2] - an[2]) - p0z;
        double dd = dx * dx + dy * dy + dz * dz;
        double frac = 0.0;
        if (dd > 1e-12) {
            frac = -(p0x * dx + p0y * dy + p0z * dz) / dd;
            frac = frac < 0.0 ? 0.0 : (frac > 1.0 ? 1.0 : frac);
        }
        double cx = p0x + frac * dx, cy = p0y + frac * dy, cz = p0z + frac * dz;
        double d = sqrt(cx * cx + cy * cy + cz * cz);
        if (d < bd) {
            bd = d; bt = s * step + frac * step;
            for (int j = 0; j < 6; ++j) { sa[j] = frac > 0.5 ? an[j] : a[j]; sb[j] = frac > 0.5 ? bn[j] : b[j]; }
        }
        for (int j = 0; j < 6; ++j) { a[j] = an[j]; b[j] = bn[j]; }
    }
    best_d[i] = bd; best_t[i] = bt;
    for (int j = 0; j < 6; ++j) { bestA[6 * i + j] = sa[j]; bestB[6 * i + j] = sb[j]; }
}

// Positions of every object (sats first) as float, for the cheap reject test.
extern "C" __global__ void to_float(const double* sat, const double* deb, int n_sat, int n_deb, float* out) {
    int i = blockDim.x * blockIdx.x + threadIdx.x;
    if (i >= n_sat + n_deb) return;
    const double* p = i < n_sat ? sat + 6 * (long long)i : deb + 6 * (long long)(i - n_sat);
    out[3 * i] = (float)p[0]; out[3 * i + 1] = (float)p[1]; out[3 * i + 2] = (float)p[2];
}

// prev: (n_sat + n_deb) x 3 FP64 positions at chunk start (sats first); prev32 / cur32: the same and the
// end-of-chunk positions as float; cur_sat / cur_deb: FP64 states after the chunk.
extern "C" __global__ void ccd(const double* prev, const float* prev32, const float* cur32,
                               const double* cur_sat, const double* cur_deb,
                               int n_sat, int n_deb, double dt, double thr, double t0,
                               double* hits, unsigned int* n_hits, unsigned int capacity) {
    long long idx = (long long)blockDim.x * blockIdx.x + threadIdx.x;
    long long m = (long long)n_deb + n_sat;
    if (idx >= (long long)n_sat * m) return;
    int s = (int)(idx / m);
    int t = (int)(idx % m);
    bool is_deb = t < n_deb;
    int tgt = is_deb ? t : t - n_deb;               // target index in its own array
    if (!is_deb && tgt <= s) return;               // each satellite pair once
    int prow = is_deb ? n_sat + tgt : tgt;
    {
        // FP32 reject: float positions are good to ~1 m at LEO radii, so a 50 m margin keeps this
        // conservative; only pairs that could come within `thr` reach the exact FP64 test below.
        const float* a0 = prev32 + 3 * (long long)s;
        const float* b0 = prev32 + 3 * (long long)prow;
        const float* a1 = cur32 + 3 * (long long)s;
        const float* b1 = cur32 + 3 * (long long)prow;
        float rx = b0[0] - a0[0], ry = b0[1] - a0[1], rz = b0[2] - a0[2];
        float dx = (b1[0] - a1[0]) - rx, dy = (b1[1] - a1[1]) - ry, dz = (b1[2] - a1[2]) - rz;
        float reach = sqrtf(dx * dx + dy * dy + dz * dz) + (float)thr + 0.05f;
        if (rx * rx + ry * ry + rz * rz > reach * reach) return;
    }
    const double* ps = prev + 3 * (long long)s;
    const double* pt = prev + 3 * (long long)prow;
    const double* es = cur_sat + 6 * (long long)s;
    const double* et = is_deb ? cur_deb + 6 * (long long)tgt : cur_sat + 6 * (long long)tgt;
    double rx = pt[0] - ps[0], ry = pt[1] - ps[1], rz = pt[2] - ps[2];
    double vx = ((et[0] - pt[0]) - (es[0] - ps[0])) / dt;
    double vy = ((et[1] - pt[1]) - (es[1] - ps[1])) / dt;
    double vz = ((et[2] - pt[2]) - (es[2] - ps[2])) / dt;
    double c = rx * rx + ry * ry + rz * rz;
    double a = vx * vx + vy * vy + vz * vz;
    double reach = sqrt(a) * dt + thr;               // cheap reject: cannot close the gap this chunk
    if (c > reach * reach) return;
    double b = 2.0 * (rx * vx + ry * vy + rz * vz);
    double tmin = 0.0;
    if (a > 1e-12) {
        tmin = -b / (2.0 * a);
        tmin = tmin < 0.0 ? 0.0 : (tmin > dt ? dt : tmin);
    }
    double d2 = a * tmin * tmin + b * tmin + c;
    if (d2 < thr * thr) {
        unsigned int k = atomicAdd(n_hits, 1u);
        if (k < capacity) {
            double* h = hits + 5 * (long long)k;
            h[0] = s; h[1] = tgt; h[2] = is_deb ? 1.0 : 0.0; h[3] = sqrt(d2 > 0.0 ? d2 : 0.0); h[4] = t0 + tmin;
        }
    }
}
"""


def available() -> bool:
    """True when a CUDA device and CuPy (with a working NVRTC) are usable. Cached."""
    global _cp, _kernels, _error
    if _kernels is not None:
        return True
    if _error is not None:
        return False
    if os.environ.get("ACM_ENGINE", "auto").lower() in ("cpp", "numpy", "cpu"):
        _error = "disabled by ACM_ENGINE"
        return False
    try:
        _prepare_cuda_paths()
        import cupy as cp  # noqa: WPS433 - optional dependency
        if cp.cuda.runtime.getDeviceCount() < 1:
            raise RuntimeError("no CUDA device")
        module = cp.RawModule(code=_SOURCE, options=("--std=c++14",))
        _kernels = {name: module.get_function(name) for name in ("propagate", "ccd", "to_float", "refine")}
        _cp = cp
        props = cp.cuda.runtime.getDeviceProperties(0)
        logger.info(f"CUDA engine ready on {props['name'].decode()} "
                    f"({props['totalGlobalMem'] // 2**20} MiB)")
        return True
    except Exception as e:                         # no GPU, no CuPy, driver/NVRTC problem
        _error = f"{type(e).__name__}: {e}"
        logger.info(f"CUDA engine unavailable ({_error}); using the CPU engine")
        return False


def device_name() -> Optional[str]:
    if not available():
        return None
    return _cp.cuda.runtime.getDeviceProperties(0)["name"].decode()


def unavailable_reason() -> Optional[str]:
    return _error


def _require():
    if not available():
        raise RuntimeError(f"CUDA engine unavailable: {_error}")


def _ballistic(b, n):
    cp = _cp
    if b is None:
        return None
    arr = np.asarray(b, dtype=np.float64)
    return cp.asarray(np.where(np.isfinite(arr) & (arr > 0), arr, -1.0))


def _launch_propagate(d_states, d_ballistic, n, dt, drag):
    if n == 0 or dt <= 0:
        return
    steps = max(1, int(math.ceil(dt / MAX_INTEGRATION_STEP)))
    h = dt / steps
    blocks = (n + THREADS - 1) // THREADS
    _kernels["propagate"]((blocks,), (THREADS,),
                          (d_states, d_ballistic if d_ballistic is not None else 0, np.int32(n), np.int32(steps),
                           np.float64(h), np.int32(1 if drag["enabled"] else 0), np.float64(drag["ballistic"]),
                           np.float64(drag["scale"])))


def propagate(states: np.ndarray, dt_seconds: float, drag: dict, ballistic=None) -> None:
    """In-place RK4 propagation of an (N, 6) array on the GPU."""
    _require()
    cp = _cp
    n = len(states)
    if n == 0 or dt_seconds <= 0:
        return
    d = cp.asarray(np.ascontiguousarray(states, dtype=np.float64))
    _launch_propagate(d, _ballistic(ballistic, n), n, dt_seconds, drag)
    states[...] = cp.asnumpy(d)


def process_conjunctions(sat_states: np.ndarray, debris_states: np.ndarray, threshold: float, dt_seconds: float,
                         drag: dict, sat_ballistic=None, debris_ballistic=None):
    """Same contract as the C++ engine: propagates both arrays in place and returns an (M, 5) array of
    [sat_idx, target_idx, is_debris, miss_km, tca_s]."""
    _require()
    cp = _cp
    n_sat, n_deb = len(sat_states), len(debris_states)
    if n_sat + n_deb == 0 or dt_seconds <= 0:
        return sat_states, debris_states, np.zeros((0, 5))
    d_sat = cp.asarray(np.ascontiguousarray(sat_states, dtype=np.float64).reshape(-1, 6))
    d_deb = cp.asarray(np.ascontiguousarray(debris_states, dtype=np.float64).reshape(-1, 6))
    b_sat, b_deb = _ballistic(sat_ballistic, n_sat), _ballistic(debris_ballistic, n_deb)
    n_all = n_sat + n_deb
    prev = cp.empty((n_all, 3), dtype=cp.float64)
    prev32 = cp.empty((n_all, 3), dtype=cp.float32)
    cur32 = cp.empty((n_all, 3), dtype=cp.float32)
    f_blocks = (n_all + THREADS - 1) // THREADS
    check = n_sat > 0 and threshold > 0
    if check:
        hits = cp.empty((HIT_CAPACITY, 5), dtype=cp.float64)
        n_hits = cp.zeros(1, dtype=cp.uint32)
        pairs = n_sat * (n_sat + n_deb)
        ccd_blocks = (pairs + THREADS - 1) // THREADS
    t = 0.0
    while t < dt_seconds - 1e-12:
        chunk = min(CHUNK_DT, dt_seconds - t)
        if check:
            prev[:n_sat] = d_sat[:, :3]
            if n_deb:
                prev[n_sat:] = d_deb[:, :3]
            if t == 0.0:
                _kernels["to_float"]((f_blocks,), (THREADS,), (d_sat, d_deb if n_deb else d_sat,
                                                                np.int32(n_sat), np.int32(n_deb), prev32))
            else:
                prev32, cur32 = cur32, prev32          # last chunk's end positions start this one
        _launch_propagate(d_sat, b_sat, n_sat, chunk, drag)
        _launch_propagate(d_deb, b_deb, n_deb, chunk, drag)
        if check:
            _kernels["to_float"]((f_blocks,), (THREADS,), (d_sat, d_deb if n_deb else d_sat,
                                                            np.int32(n_sat), np.int32(n_deb), cur32))
            _kernels["ccd"]((ccd_blocks,), (THREADS,),
                            (prev, prev32, cur32, d_sat, d_deb if n_deb else d_sat, np.int32(n_sat), np.int32(n_deb),
                             np.float64(chunk), np.float64(threshold), np.float64(t), hits, n_hits,
                             np.uint32(HIT_CAPACITY)))
        t += chunk
    sat_states[...] = cp.asnumpy(d_sat).reshape(sat_states.shape)
    debris_states[...] = cp.asnumpy(d_deb).reshape(debris_states.shape)
    if not check:
        return sat_states, debris_states, np.zeros((0, 5))
    count = int(n_hits.get()[0])
    if count > HIT_CAPACITY:
        logger.warning(f"CUDA engine hit buffer overflow ({count} > {HIT_CAPACITY}); keeping the first {HIT_CAPACITY}")
        count = HIT_CAPACITY
    raw = cp.asnumpy(hits[:count]) if count else np.zeros((0, 5))
    if len(raw) == 0:
        return sat_states, debris_states, raw
    # First occurrence per (sat, target, is_debris), like the C++ engine's reported-pairs set.
    order = np.lexsort((raw[:, 4], raw[:, 2], raw[:, 1], raw[:, 0]))
    raw = raw[order]
    keys = raw[:, :3]
    first = np.ones(len(raw), dtype=bool)
    first[1:] = np.any(keys[1:] != keys[:-1], axis=1)
    return sat_states, debris_states, raw[first]


def refine_pairs(A0: np.ndarray, B0: np.ndarray, t_start: np.ndarray, drag: dict, ballistic_a=None,
                 ballistic_b=None, window: float = 600.0, step: float = 2.0):
    """GPU version of acm/conjunctions.py's bridge-to-t_start + closest_approach for k pairs (one thread
    per pair). Returns (miss_km, t_offset_s from t_start, A_at, B_at)."""
    _require()
    cp = _cp
    k = len(A0)
    d_a = cp.asarray(np.ascontiguousarray(A0, dtype=np.float64))
    d_b = cp.asarray(np.ascontiguousarray(B0, dtype=np.float64))
    d_ts = cp.asarray(np.ascontiguousarray(t_start, dtype=np.float64))
    best_d, best_t = cp.empty(k), cp.empty(k)
    best_a, best_b = cp.empty((k, 6)), cp.empty((k, 6))
    ba, bb = _ballistic(ballistic_a, k), _ballistic(ballistic_b, k)
    _kernels["refine"](((k + 63) // 64,), (64,),
                       (d_a, d_b, d_ts, ba if ba is not None else 0, bb if bb is not None else 0, np.int32(k),
                        np.float64(window), np.float64(step), np.int32(1 if drag["enabled"] else 0),
                        np.float64(drag["ballistic"]), np.float64(drag["scale"]), best_d, best_t, best_a, best_b))
    return cp.asnumpy(best_d), cp.asnumpy(best_t), cp.asnumpy(best_a), cp.asnumpy(best_b)
