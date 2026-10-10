"""CPU (C++/OpenMP) vs CUDA engine: agreement and speed on screening-sized workloads.

    python tests/benchmark/gpu_vs_cpu.py [--sats 200] [--debris 20000] [--horizon 3600]
"""
import argparse
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from satellite_api import gpu_engine  # noqa: E402
from satellite_api import physics_engine as pe  # noqa: E402
from satellite_api.acm.scenario import circular_state_over, make_threat  # noqa: E402


def scenario(n_sat, n_deb, seed=1):
    rng = np.random.default_rng(seed)
    t0 = 1767225600.0
    sats = np.array([circular_state_over(rng.uniform(-70, 70), rng.uniform(-180, 180), t0, alt_km=rng.uniform(450, 650))
                     for _ in range(n_sat)])
    deb = [circular_state_over(rng.uniform(-85, 85), rng.uniform(-180, 180), t0, alt_km=rng.uniform(400, 900))
           for _ in range(n_deb - 10)]
    deb += [make_threat(sats[i], 600.0 + 120 * i, 0.03 + 0.01 * i) for i in range(min(10, n_sat))]   # planted
    return sats, np.array(deb)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sats", type=int, default=200)
    ap.add_argument("--debris", type=int, default=20000)
    ap.add_argument("--horizon", type=float, default=3600.0)
    ap.add_argument("--threshold", type=float, default=5.0)
    args = ap.parse_args()
    assert gpu_engine.available(), gpu_engine.unavailable_reason()
    pe.configure_drag(True, 0.01, 1.0)
    sats, deb = scenario(args.sats, args.debris)
    b_deb = np.random.default_rng(2).uniform(0.003, 0.05, len(deb))

    gpu_engine.process_conjunctions(sats[:2].copy(), deb[:2].copy(), 1.0, 10.0, pe._drag)   # warm-up / JIT

    cs, cd = sats.copy(), deb.copy()
    t = time.perf_counter()
    _, _, c_hits = pe._native(cs, cd, args.threshold, args.horizon, None, pe._native_ballistic(b_deb))
    t_cpu = time.perf_counter() - t

    gs, gd = sats.copy(), deb.copy()
    t = time.perf_counter()
    _, _, g_hits = gpu_engine.process_conjunctions(gs, gd, args.threshold, args.horizon, pe._drag, None, b_deb)
    t_gpu = time.perf_counter() - t

    pos_err = max(np.abs(cs - gs).max(), np.abs(cd - gd).max())
    key = lambda h: {(int(r[0]), int(r[1]), int(r[2])) for r in h}
    ck, gk = key(c_hits), key(g_hits)
    print(f"{args.sats} sats x {args.debris} objects, {args.horizon:.0f} s horizon, {args.threshold} km sphere")
    print(f"  C++/OpenMP : {t_cpu:7.2f} s   ({len(ck)} candidate pairs)")
    print(f"  CUDA       : {t_gpu:7.2f} s   ({len(gk)} candidate pairs)   speed-up x{t_cpu / t_gpu:.1f}")
    print(f"  max state difference {pos_err:.2e} km/km/s;  pairs only CPU {len(ck - gk)}, only GPU {len(gk - ck)}")


if __name__ == "__main__":
    main()
