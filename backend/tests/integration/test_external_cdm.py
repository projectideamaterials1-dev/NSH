"""External CDMs: parsing, pair matching, measured-covariance Pc, Space-Track polling."""
from pathlib import Path

import numpy as np
import pytest

from satellite_api.acm.scenario import circular_state_over, make_threat
from satellite_api.config import CONFIG
from satellite_api.ground_stations import STATIONS
from satellite_api.realworld import cdm_ingest, spacetrack
from satellite_api.realworld.cdm_ingest import CDMParseError, parse_any, parse_kvn, resolve_pair
from satellite_api.timeutils import iso_z
from tests.conftest import make_object

T0 = 1767225600.0
KVN = (Path(__file__).resolve().parents[1] / "fixtures" / "sample.cdm").read_text()
ISTRAC = next(s for s in STATIONS if s.id == "GS-001")

PUBLIC = {"CDM_ID": "998877", "CREATED": "2026-01-01 00:00:00.000000", "EMERGENCY_REPORTABLE": "Y",
          "TCA": "2026-01-01T00:30:00.000000", "MIN_RNG": "48", "PC": "0.0031", "SAT_1_ID": "25544",
          "SAT_1_NAME": "ISS (ZARYA)", "SAT_2_ID": "99999", "SAT_2_NAME": "DEB"}


def test_parse_kvn_reads_metadata_and_rtn_covariance_in_km2():
    cdm = parse_kvn(KVN)
    assert cdm["message_id"] == "TEST-CDM-0001" and cdm["originator"] == "TEST-SSA"
    assert cdm["miss_km"] == pytest.approx(0.052) and cdm["pc"] == pytest.approx(2.1e-3)
    assert cdm["tca_ts"] == pytest.approx(T0 + 1800)
    sat_cov = np.array(cdm["objects"][0]["covariance_rtn_km2"])
    assert sat_cov[1, 1] == pytest.approx(2.5e-3)              # 2500 m^2 -> 0.0025 km^2
    assert np.array(cdm["objects"][1]["covariance_rtn_km2"])[0, 1] == pytest.approx(1e-4)


def test_parse_space_track_public_and_multi_message_kvn():
    [cdm] = parse_any([PUBLIC])
    assert cdm["source"] == "Space-Track cdm_public" and cdm["pc"] == pytest.approx(0.0031)
    assert cdm["objects"][0]["designator"] == "25544" and cdm["objects"][0]["covariance_rtn_km2"] is None
    two = parse_any(KVN + "\n" + KVN.replace("TEST-CDM-0001", "TEST-CDM-0002"))
    assert [c["message_id"] for c in two] == ["TEST-CDM-0001", "TEST-CDM-0002"]
    with pytest.raises(CDMParseError):
        parse_any("hello = world")


def test_non_physical_covariance_is_dropped_and_pairs_resolve_by_norad_or_id():
    bad = parse_kvn(KVN.replace("CT_T                              = 2.5e+03", "CT_T = -5"))
    assert bad["objects"][0]["covariance_rtn_km2"] is None
    [public] = parse_any([PUBLIC])
    # NORAD 25544 is our satellite ISS, 99999 an object we track: OBJECT1 is the satellite.
    assert resolve_pair(public, ["ISS"], ["DEB-9"], {25544: "ISS", 99999: "DEB-9"}) == ("ISS", "DEB-9", 0)
    # Swapped roles: our satellite is OBJECT2.
    swapped = {**public, "objects": public["objects"][::-1]}
    assert resolve_pair(swapped, ["ISS"], ["DEB-9"], {25544: "ISS", 99999: "DEB-9"}) == ("ISS", "DEB-9", 1)
    assert resolve_pair(public, ["OTHER"], [], {}) is None


async def _scenario(client):
    sat = circular_state_over(ISTRAC.latitude, ISTRAC.longitude, T0)
    objs = [make_object("SAT-A", "SATELLITE", sat[:3], sat[3:])]
    deb = make_threat(sat, 1800.0, 0.05)
    objs.append(make_object("DEB-THREAT", "DEBRIS", deb[:3], deb[3:]))
    await client.post("/api/telemetry", json={"timestamp": iso_z(T0), "objects": objs})


@pytest.mark.asyncio
async def test_uploaded_cdm_covariance_replaces_the_model_and_is_compared(client):
    CONFIG.atmosphericDrag = False
    await _scenario(client)
    await client.post("/api/conjunctions/screen", params={"horizon_s": 3600, "plan": False})
    modelled = (await client.get("/api/conjunctions")).json()["conjunctions"][0]
    assert modelled["covariance_measured"] is False and "external" not in modelled

    resp = await client.post("/api/cdm", content=KVN, headers={"Content-Type": "text/plain"})
    assert resp.status_code == 200, resp.text
    result = resp.json()
    assert len(result["matched"]) == 1 and result["matched"][0]["has_covariance"]
    assert result["matched"][0]["satellite_id"] == "SAT-A" and result["matched"][0]["object_id"] == "DEB-THREAT"

    await client.post("/api/conjunctions/screen", params={"horizon_s": 3600, "plan": False})
    measured = (await client.get("/api/conjunctions")).json()["conjunctions"][0]
    assert measured["covariance_measured"] is True
    assert "TEST-CDM-0001" in measured["covariance_model"]
    assert measured["external"]["pc"] == pytest.approx(2.1e-3) and measured["external"]["originator"] == "TEST-SSA"
    # The CDM's covariance is far tighter than the 30-min model: the Pc assessment changes.
    assert measured["pc"] != pytest.approx(modelled["pc"], rel=0.05)
    assert measured["encounter_plane"]["sigma_major_km"] < modelled["encounter_plane"]["sigma_major_km"]

    listed = (await client.get("/api/cdm")).json()["cdms"]
    assert listed[0]["message_id"] == "TEST-CDM-0001" and listed[0]["matched"]

    assert (await client.post("/api/cdm", content=b"   ")).status_code == 400
    assert (await client.post("/api/cdm", content=b"not a cdm = x")).status_code == 422


@pytest.mark.asyncio
async def test_unmatched_cdms_are_kept_but_not_applied(client):
    await _scenario(client)
    resp = (await client.post("/api/cdm", json=[PUBLIC])).json()
    assert resp["matched"] == [] and len(resp["unmatched"]) == 1


def test_space_track_client_batches_queries_and_reports_feed_status(monkeypatch):
    calls = []

    class FakeClient:
        def public_cdms(self, ids):
            calls.append(sorted(ids))
            return [PUBLIC]

    monkeypatch.setenv("SPACETRACK_IDENTITY", "user@example.com")
    monkeypatch.setenv("SPACETRACK_PASSWORD", "pw")
    monkeypatch.setattr(spacetrack, "FEED", {"configured": False, "last_success": None, "last_error": None,
                                             "last_error_at": None, "last_count": 0})
    poller = spacetrack.SpaceTrackPoller(client_factory=FakeClient)
    assert poller.due()
    assert poller.fetch([25544, 48274]) == [PUBLIC] and calls == [[25544, 48274]]
    assert not poller.due()                                      # rate-limited until POLL_S passes
    from satellite_api.feed_health import spacetrack_status
    assert spacetrack_status()["status"] == "ok" and spacetrack_status()["cdms_last_poll"] == 1

    class Broken:
        def public_cdms(self, ids):
            raise spacetrack.SpaceTrackError("login failed")
    poller = spacetrack.SpaceTrackPoller(client_factory=Broken)
    with pytest.raises(spacetrack.SpaceTrackError):
        poller.fetch([1])
    assert spacetrack_status()["status"] == "degraded"


def test_space_track_client_url_and_login(monkeypatch):
    seen = []

    class Resp:
        def __init__(self, body):
            self.body = body

        def read(self):
            return self.body

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    class Opener:
        def open(self, req, timeout=None):
            url = req if isinstance(req, str) else req.full_url
            seen.append(url)
            return Resp(b'""' if "login" in url else b'[{"CDM_ID": "1"}]')

    client = spacetrack.SpaceTrackClient("u", "p", opener=Opener())
    out = client.public_cdms(range(150))
    assert out == [{"CDM_ID": "1"}]                     # deduplicated across the four queries
    assert seen[0].endswith("/ajaxauth/login") and len(seen) == 1 + 4   # 2 batches x (SAT_1, SAT_2)
    assert "/class/cdm_public/SAT_1_ID/0,1,2" in seen[1]


def test_external_store_bounds_and_prunes():
    store = cdm_ingest.ExternalCDMStore()
    base = parse_kvn(KVN)
    for i in range(cdm_ingest.MAX_EXTERNAL + 5):
        store.add({**base, "message_id": f"M{i}"}, ("SAT-A", "DEB-THREAT", 0), now_ts=float(i))
    assert len(store.items) == cdm_ingest.MAX_EXTERNAL and "M0" not in store.items
    store.prune(now_ts=base["tca_ts"] + 2 * 86400)
    assert not store.items
