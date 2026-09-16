import numpy as np
import pytest

from satellite_api.acm.conjunctions import CDMRegistry, risk_level, screen
from satellite_api.acm.scenario import circular_state_over, make_threat
from satellite_api.physics_engine import _numpy_process_conjunctions, process_conjunctions

T0 = 1767225600.0


@pytest.mark.parametrize("engine", [process_conjunctions, _numpy_process_conjunctions])
def test_screen_finds_planted_conjunction_precisely(engine):
    sat = circular_state_over(13.0, 77.5, T0)
    other = circular_state_over(-40.0, 10.0, T0)
    debris = np.array([make_threat(sat, 1500, 0.05, 90), make_threat(sat, 2400, 0.8, 150),
                       circular_state_over(40.0, -120.0, T0, alt_km=800)])
    res = screen(np.array([sat, other]), debris, ["SAT-A", "SAT-B"], ["T1", "T2", "BG"], T0, 3600, 5.0, engine)
    by_obj = {r["object_id"]: r for r in res}
    assert set(by_obj) == {"T1", "T2"}
    assert by_obj["T1"]["tca_ts"] - T0 == pytest.approx(1500, abs=2)
    assert by_obj["T1"]["miss_distance_km"] == pytest.approx(0.05, abs=0.01)
    assert by_obj["T2"]["miss_distance_km"] == pytest.approx(0.8, abs=0.02)
    assert by_obj["T1"]["relative_velocity_kms"] > 5
    assert 0 <= by_obj["T1"]["approach_angle_deg"] < 360


def test_screen_without_satellites_or_candidates():
    assert screen(np.empty((0, 6)), np.empty((0, 6)), [], [], T0, 3600) == []
    sat = circular_state_over(0, 0, T0)
    assert screen(np.array([sat]), np.empty((0, 6)), ["S"], [], T0, 600) == []


def _pred(obj="DEB-1", tca=T0 + 1000, miss=0.05):
    return {"satellite_id": "SAT-A", "object_id": obj, "object_type": "DEBRIS", "tca_ts": tca,
            "miss_distance_km": miss, "relative_velocity_kms": 10.0, "approach_angle_deg": 45.0}


def test_registry_lifecycle():
    events = []
    emit = lambda level, cat, msg, **kw: events.append((level, cat, msg))
    reg = CDMRegistry()

    assert reg.apply([_pred()], T0, emit)["new"] == 1
    cdm = reg.items[0]
    assert (cdm["status"], cdm["risk"]) == ("ACTIVE", "CRITICAL")
    assert events[-1][0] == "crit"

    # same pair, slightly different TCA -> update, not a new CDM
    assert reg.apply([_pred(tca=T0 + 1030, miss=0.03)], T0 + 10, emit)["updated"] == 1
    assert len(reg.items) == 1 and cdm["min_predicted_miss_km"] == pytest.approx(0.03)

    assert reg.link_mitigation("SAT-A", ["B1"], T0 + 20) == [cdm["cdm_id"]]
    assert cdm["status"] == "MITIGATED"

    # no longer predicted after the burn -> cleared
    assert reg.apply([], T0 + 100, emit)["cleared"] == 1
    assert cdm["status"] == "CLEARED"

    reg.resolve(T0 + 2000, [], emit)
    assert cdm["status"] == "RESOLVED"
    assert reg.counts()["avoided"] == 1
    assert "avoided" in events[-1][2]


def test_registry_marks_collisions():
    reg = CDMRegistry()
    reg.apply([_pred()], T0, lambda *a, **k: None)
    reg.resolve(T0 + 1100, [(T0 + 1001, "SAT-A", "DEB-1")], lambda *a, **k: None)
    assert reg.items[0]["status"] == "COLLIDED"
    assert reg.counts()["avoided"] == 0


def test_risk_levels():
    assert risk_level(0.05) == "CRITICAL"
    assert risk_level(0.5) == "WARNING"
    assert risk_level(3.0) == "WATCH"
