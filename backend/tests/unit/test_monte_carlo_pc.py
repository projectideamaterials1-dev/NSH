"""Monte Carlo Pc: agrees with the 2-D Pc where the short-encounter assumption holds."""
import numpy as np
import pytest

from satellite_api.acm.collision_probability import assess
from satellite_api.acm.conjunctions import closest_approach
from satellite_api.acm.monte_carlo import monte_carlo_pc
from satellite_api.acm.scenario import circular_state_over, make_threat
from satellite_api.physics_engine import configure_drag

T0 = 1767225600.0


@pytest.fixture(autouse=True)
def _no_drag():
    configure_drag(False)
    yield


def test_monte_carlo_matches_the_2d_pc_for_a_fast_encounter():
    sat = circular_state_over(10.0, 20.0, T0)
    deb = make_threat(sat, 600.0, 0.12)                 # TCA in 10 min, 120 m miss, LEO crossing speed
    miss, t_tca, a, b = closest_approach(sat.reshape(1, 6), deb.reshape(1, 6), window_s=900.0, step_s=1.0)
    cov = np.diag([0.08, 0.08, 0.08]) ** 2              # 80 m 1-sigma each, km^2
    two_d = assess(a[0], b[0], float(miss[0]), float(t_tca[0]), obj_is_owned=False, hbr_m=50.0,
                   cov_sat_rtn=cov, cov_obj_rtn=cov)
    assert two_d["short_encounter_valid"] is True
    mc = monte_carlo_pc(sat, deb, float(t_tca[0]), cov, cov, 0.05, two_d["encounter_duration_s"], samples=6000, seed=1)
    assert mc["hits"] > 50
    lo, hi = mc["ci95"]
    # Propagation over the window and the velocity spread add a little dispersion: allow 30 % beyond the CI.
    assert lo * 0.7 <= two_d["pc"] <= hi * 1.3, (two_d["pc"], mc)


def test_no_hits_reports_the_resolution_limit_not_zero_risk():
    sat = circular_state_over(10.0, 20.0, T0)
    deb = make_threat(sat, 600.0, 5.0)                  # 5 km miss, tight covariance: practically no hits
    cov = np.diag([0.01, 0.01, 0.01]) ** 2
    mc = monte_carlo_pc(sat, deb, 600.0, cov, cov, 0.02, 10.0, samples=2000, seed=2)
    assert mc["hits"] == 0 and mc["pc_mc"] == 0.0
    assert mc["ci95"][1] == pytest.approx(3.0 / 2000, rel=0.35)   # rule of three


@pytest.mark.asyncio
async def test_endpoint_runs_and_stores_the_result_on_the_cdm(client):
    from satellite_api.ground_stations import STATIONS
    from satellite_api.main import app
    from satellite_api.timeutils import iso_z
    from tests.conftest import make_object
    st = STATIONS[0]
    sat = circular_state_over(st.latitude, st.longitude, T0)
    deb = make_threat(sat, 1800.0, 0.05)
    objects = [make_object("SAT-A", "SATELLITE", sat[:3], sat[3:]), make_object("DEB-1", "DEBRIS", deb[:3], deb[3:])]
    assert (await client.post("/api/telemetry", json={"timestamp": iso_z(T0), "objects": objects})).status_code == 200
    await client.post("/api/conjunctions/screen", params={"horizon_s": 7200, "plan": False})
    cdm = (await client.get("/api/conjunctions")).json()["conjunctions"][0]
    r = await client.post(f"/api/conjunctions/{cdm['cdm_id']}/pc-monte-carlo", params={"samples": 1000})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["samples"] == 1000 and 0.0 <= body["pc_mc"] <= 1.0 and body["pc_2d"] == cdm["pc"]
    stored = next(c for c in app.state.orbital_state.cdms.items if c["cdm_id"] == cdm["cdm_id"])
    assert stored["pc_mc"]["hits"] == body["hits"]
    assert (await client.post("/api/conjunctions/CDM-NOPE/pc-monte-carlo")).status_code == 404
