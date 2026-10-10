"""CUDA engine parity with the CPU engines (skipped when no usable NVIDIA GPU / CuPy)."""
import numpy as np
import pytest

from satellite_api import gpu_engine
from satellite_api import physics_engine as pe
from satellite_api.acm import conjunctions as cj
from satellite_api.acm.scenario import circular_state_over, make_threat

pytestmark = pytest.mark.skipif(not gpu_engine.available(), reason="no CUDA GPU / CuPy")
T0 = 1767225600.0


def _scenario(n_sat=30, n_deb=1500, seed=4):
    rng = np.random.default_rng(seed)
    sats = np.array([circular_state_over(rng.uniform(-70, 70), rng.uniform(-180, 180), T0, alt_km=rng.uniform(380, 650))
                     for _ in range(n_sat)])
    deb = [circular_state_over(rng.uniform(-85, 85), rng.uniform(-180, 180), T0, alt_km=rng.uniform(350, 900))
           for _ in range(n_deb - min(5, n_sat))]
    deb += [make_threat(sats[i], 300.0 + 200 * i, 0.04) for i in range(min(5, n_sat))]
    return sats, np.array(deb), rng.uniform(0.002, 0.06, n_deb)


def test_gpu_engine_matches_cpu_states_and_conjunctions():
    pe.configure_drag(True, 0.01, 1.5)
    sats, deb, b = _scenario()
    cs, cd = sats.copy(), deb.copy()
    _, _, c_hits = pe._numpy_process_conjunctions(cs, cd, 5.0, 2400.0, None, b)
    gs, gd = sats.copy(), deb.copy()
    _, _, g_hits = gpu_engine.process_conjunctions(gs, gd, 5.0, 2400.0, pe._drag, None, b)
    # FP32 drag term: millimetre-level agreement after 40 minutes.
    assert np.abs(gs - cs)[:, :3].max() < 1e-5 and np.abs(gd - cd)[:, :3].max() < 1e-5
    key = lambda h: {(int(r[0]), int(r[1]), int(r[2])) for r in h}
    assert key(g_hits) == key(c_hits) and len(key(g_hits)) >= 5
    g_by = {(int(r[0]), int(r[1]), int(r[2])): r for r in g_hits}
    for r in c_hits:
        g = g_by[(int(r[0]), int(r[1]), int(r[2]))]
        assert g[3] == pytest.approx(r[3], abs=1e-5) and g[4] == pytest.approx(r[4], abs=1e-3)


def test_gpu_refinement_matches_cpu_screening():
    pe.configure_drag(True, 0.01, 1.0)
    sats, deb, b = _scenario(n_sat=10, n_deb=300)
    ids = [f"S{i}" for i in range(len(sats))]
    dids = [f"D{i}" for i in range(len(deb))]
    try:
        pe._ENGINE_MODE = "cuda"
        gpu = cj.screen(sats, deb, ids, dids, T0, 3600.0, 5.0, debris_ballistic=b)
        pe._ENGINE_MODE = "cpp"
        cpu = cj.screen(sats, deb, ids, dids, T0, 3600.0, 5.0, debris_ballistic=b)
    finally:
        pe._ENGINE_MODE = "auto"
    g = {(p["satellite_id"], p["object_id"]): p for p in gpu}
    c = {(p["satellite_id"], p["object_id"]): p for p in cpu}
    assert set(g) == set(c) and len(g) >= 5
    for k in g:
        assert g[k]["miss_distance_km"] == pytest.approx(c[k]["miss_distance_km"], abs=1e-4)
        assert g[k]["tca_ts"] == pytest.approx(c[k]["tca_ts"], abs=0.01)


def test_dispatch_thresholds(monkeypatch):
    monkeypatch.setattr(pe, "_ENGINE_MODE", "auto")
    assert not pe._gpu_for(500, 3600)                          # few objects: launch overhead dominates
    assert not pe._gpu_for(20000, 60)                          # short step: below the work threshold
    assert pe._gpu_for(20000, 3600)
    monkeypatch.setattr(pe, "_ENGINE_MODE", "cpp")
    assert not pe._gpu_for(20000, 3600)
    monkeypatch.setattr(pe, "_ENGINE_MODE", "cuda")
    assert pe._gpu_for(10, 1)
    info = pe.engine_info()
    assert info["gpu"] and info["mode"] == "cuda"


def test_propagate_fast_uses_gpu_for_bulk_and_matches_cpu(monkeypatch):
    pe.configure_drag(True, 0.01, 1.0)
    _, deb, b = _scenario(n_sat=1, n_deb=3000)
    monkeypatch.setattr(pe, "_ENGINE_MODE", "auto")
    gpu = deb.copy()
    pe.propagate_fast(gpu, 3600.0, b)                          # 3000 objects x 3600 s: GPU
    cpu = deb.copy()
    pe.propagate_states(cpu, 3600.0, ballistic=b)
    assert np.abs(gpu - cpu)[:, :3].max() < 1e-5
