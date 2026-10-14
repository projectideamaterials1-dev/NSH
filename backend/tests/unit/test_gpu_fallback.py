"""A GPU that fails at runtime (driver reset, lost device) must not stop screening: the call is redone
on the CPU from the original states, and the GPU stays off. Simulated - runs without a GPU."""
import numpy as np
import pytest

from satellite_api import gpu_engine
from satellite_api import physics_engine as pe
from satellite_api.acm import conjunctions as cj
from satellite_api.acm.scenario import circular_state_over, make_threat

T0 = 1767225600.0


@pytest.fixture
def broken_gpu(monkeypatch):
    """A GPU that reports itself available, then corrupts its outputs and raises like a lost device."""
    monkeypatch.setattr(pe, "_ENGINE_MODE", "cuda")
    monkeypatch.setattr(gpu_engine, "_kernels", {"fake": None})
    monkeypatch.setattr(gpu_engine, "_error", None)

    def fail(*arrays):
        for a in arrays:
            a[...] = 1e9        # what a half-finished write-back would leave behind
        raise RuntimeError("cudaErrorUnknown: unknown error")

    monkeypatch.setattr(gpu_engine, "process_conjunctions", lambda s, d, *a, **k: fail(s, d))
    monkeypatch.setattr(gpu_engine, "propagate", lambda s, *a, **k: fail(s))
    monkeypatch.setattr(gpu_engine, "refine_pairs", lambda *a, **k: fail())
    yield
    assert not gpu_engine.available() and "cudaErrorUnknown" in gpu_engine.unavailable_reason()


def _scene():
    sat = circular_state_over(10.0, 20.0, T0)
    return np.array([sat]), np.array([make_threat(sat, 900.0, 0.05)])


def test_conjunction_step_falls_back_to_the_cpu_from_the_original_states(broken_gpu):
    sats, deb = _scene()
    expect_s, expect_d = sats.copy(), deb.copy()
    expected = pe._numpy_process_conjunctions(expect_s, expect_d, 5.0, 1200.0, None, None)[2]
    got = pe.process_conjunctions(sats, deb, 5.0, 1200.0)[2]
    assert np.allclose(sats, expect_s, atol=1e-6) and np.allclose(deb, expect_d, atol=1e-6)
    assert {(int(r[0]), int(r[1])) for r in got} == {(int(r[0]), int(r[1])) for r in expected} != set()


def test_propagation_falls_back_to_the_cpu(broken_gpu):
    sats, _ = _scene()
    expect = sats.copy()
    pe.propagate_states(expect, 600.0)
    pe.propagate_fast(sats, 600.0)
    assert np.allclose(sats, expect, atol=1e-6)


def test_screening_survives_a_gpu_failure_in_refinement(broken_gpu, monkeypatch):
    # The broad phase works on the "GPU" here, so the failure happens in the refinement step.
    monkeypatch.setattr(gpu_engine, "process_conjunctions", lambda s, d, th, dt, drag, sb, db:
                        pe._numpy_process_conjunctions(s, d, th, dt, sb, db))
    sats, deb = _scene()
    found = cj.screen(sats, deb, ["SAT-A"], ["DEB-1"], T0, 1800.0, 5.0)
    assert [(p["satellite_id"], p["object_id"]) for p in found] == [("SAT-A", "DEB-1")]
    assert found[0]["miss_distance_km"] == pytest.approx(0.05, abs=0.01)
