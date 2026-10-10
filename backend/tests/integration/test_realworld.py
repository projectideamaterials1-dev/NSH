"""Real-world data API: CelesTrak catalog loading (offline fixture), SGP4 anchoring, live mode,
cache fallback, SGP4 conjunction refinement and space weather."""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest
from sgp4.api import jday

from satellite_api.main import app
from satellite_api.realworld import catalog, imagery, live, space_weather
from satellite_api.realworld.catalog import CatalogError

FIXTURE = json.loads((Path(__file__).resolve().parent.parent / "fixtures" / "celestrak_sample.json").read_text())
NOW = datetime(2026, 9, 14, 8, 0, 0, tzinfo=timezone.utc)


class Clock:
    def __init__(self):
        self.now = NOW

    def __call__(self):
        return self.now


@pytest.fixture
def celestrak(monkeypatch):
    calls = []

    def fake_query(query):
        calls.append(query)
        key = query.split("=", 1)[1]
        if key not in FIXTURE:
            return []
        return FIXTURE[key]

    clock = Clock()
    monkeypatch.setattr(catalog, "_http_query", fake_query)
    monkeypatch.setattr(live, "_utcnow", clock)
    catalog._last_failure.clear()
    app.state.realworld = None
    yield calls, clock
    service = getattr(app.state, "realworld", None)
    if service:
        service.live = False


async def _load(client, **overrides):
    body = {"fleet": ["stations"], "objects": ["cosmos-2251-debris"], "live": False, **overrides}
    resp = await client.post("/api/catalog/load", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.mark.asyncio
async def test_load_ingests_real_satellites_and_debris(client, celestrak):
    status = await _load(client)
    assert status["satellites"] == len(FIXTURE["stations"])
    assert 0 < status["tracked_objects"] <= len(FIXTURE["cosmos-2251-debris"])
    assert status["live"] is False and status["warnings"] == []

    sats = (await client.get("/api/satellites")).json()
    assert sats["timestamp"].startswith("2026-09-14T08:00:00")
    iss = next(s for s in sats["satellites"] if s["id"] == "ISS (ZARYA)")
    assert 400 < iss["alt_km"] < 440 and iss["drift_km"] == 0.0

    info = (await client.get("/api/catalog/objects/ISS (ZARYA)")).json()
    assert info["norad_id"] == 25544 and info["intl_designator"] == "1998-067A"
    assert 90 < info["elements"]["period_min"] < 95 and info["kind"] == "satellite"
    assert (await client.get("/api/catalog/objects/NOPE")).status_code == 404

    snapshot = (await client.get("/api/visualization/snapshot")).json()
    assert len(snapshot["satellites"]) == status["satellites"]


@pytest.mark.asyncio
async def test_positions_match_sgp4(client, celestrak):
    await _load(client)
    state = app.state.orbital_state
    service = app.state.realworld
    obj = service.fleet["ISS (ZARYA)"]
    jd, fr = jday(2026, 9, 14, 8, 0, 0)
    _, r, v = obj.satrec.sgp4(jd, fr)
    idx = state.sat_id_to_idx["ISS (ZARYA)"]
    np.testing.assert_allclose(state.sat_buffer[idx], np.array(r + v), atol=1e-9)


@pytest.mark.asyncio
async def test_docked_vehicles_are_not_collisions(client, celestrak):
    status = await _load(client)
    state = app.state.orbital_state
    assert status["attached_pairs"] > 0
    docked = [p for p in state.attached_pairs if "ISS (ZARYA)" in p]
    assert docked, "vehicles sharing the ISS element set should be attached to it"

    await client.put("/api/live", json={"enabled": False})
    step = (await client.post("/api/simulate/step", json={"step_seconds": 60})).json()
    assert step["collisions_detected"] == 0
    screen = (await client.post("/api/conjunctions/screen", params={"horizon_s": 600})).json()
    cdms = (await client.get("/api/conjunctions")).json()["conjunctions"]
    assert screen["status"] == "OK"
    assert not any(state.is_attached(c["satellite_id"], c["object_id"]) for c in cdms)


@pytest.mark.asyncio
async def test_rejects_unknown_source_and_empty_fleet(client, celestrak):
    assert (await client.post("/api/catalog/load", json={"fleet": ["nope"]})).status_code == 422
    assert (await client.post("/api/catalog/load", json={"fleet": [], "objects": []})).status_code == 422


@pytest.mark.asyncio
async def test_live_mode_locks_clock_and_blocks_manual_steps(client, celestrak):
    _, clock = celestrak
    await _load(client, live=True)
    assert (await client.get("/api/live")).json()["enabled"] is True
    assert (await client.post("/api/simulate/step", json={"step_seconds": 10})).status_code == 409

    clock.now = NOW + timedelta(seconds=30)
    await app.state.realworld.tick()
    assert app.state.orbital_state.current_time == clock.now

    clock.now = NOW + timedelta(hours=2)          # far behind: re-anchored instead of integrated
    await app.state.realworld.tick()
    assert app.state.orbital_state.current_time == clock.now

    resp = await client.put("/api/live", json={"enabled": False})
    assert resp.status_code == 200 and resp.json()["enabled"] is False
    assert (await client.post("/api/simulate/step", json={"step_seconds": 10})).status_code == 200


@pytest.mark.asyncio
async def test_resync_keeps_manoeuvred_satellites(client, celestrak):
    await _load(client)
    state = app.state.orbital_state
    service = app.state.realworld
    burned, untouched = "ISS (ZARYA)", next(s for s in service.fleet if s != "ISS (ZARYA)")
    i_burned, i_untouched = state.sat_id_to_idx[burned], state.sat_id_to_idx[untouched]
    state.sat_fuel[i_burned] -= 1.0                      # as if a burn had been executed
    state.sat_buffer[i_burned, 3] += 0.001
    state.sat_buffer[i_untouched, 3] += 0.001
    kept = state.sat_buffer[i_burned].copy()

    await service.resync(state.current_time)
    np.testing.assert_array_equal(state.sat_buffer[i_burned], kept)
    jd, fr = jday(2026, 9, 14, 8, 0, 0)
    _, r, v = service.fleet[untouched].satrec.sgp4(jd, fr)
    np.testing.assert_allclose(state.sat_buffer[i_untouched], np.array(r + v), atol=1e-9)


@pytest.mark.asyncio
async def test_cached_data_used_when_celestrak_is_down(client, celestrak, monkeypatch):
    await _load(client)

    def offline(query):
        raise CatalogError("CelesTrak unreachable (test)")

    monkeypatch.setattr(catalog, "_http_query", offline)
    status = await _load(client, force_refresh=True)
    assert status["satellites"] == len(FIXTURE["stations"])
    assert any("using cached data" in w for w in status["warnings"])


def test_sgp4_refiner_matches_brute_force():
    fleet = catalog.parse_records(FIXTURE["stations"], "stations")
    debris = catalog.parse_records(FIXTURE["cosmos-2251-debris"], "cosmos-2251-debris")
    sat, deb = fleet[0], debris[0]

    def distance(t: datetime) -> float:
        jd, fr = jday(t.year, t.month, t.day, t.hour, t.minute, t.second + t.microsecond / 1e6)
        return float(np.linalg.norm(np.subtract(sat.satrec.sgp4(jd, fr)[1], deb.satrec.sgp4(jd, fr)[1])))

    # Find a local minimum of the separation by brute force, then offer the refiner a guess 40 s off.
    coarse = [NOW + timedelta(seconds=s) for s in range(0, 6000, 10)]
    d = [distance(t) for t in coarse]
    k = next(i for i in range(1, len(d) - 1) if d[i] <= d[i - 1] and d[i] <= d[i + 1])
    fine = [coarse[k] + timedelta(milliseconds=ms) for ms in range(-10000, 10000, 5)]
    truth_t = min(fine, key=distance)

    guess = {"satellite_id": "A", "object_id": "B", "object_type": "DEBRIS", "tca_ts": truth_t.timestamp() + 40.0,
             "miss_distance_km": 1.0, "relative_velocity_kms": 0.0, "approach_angle_deg": 0.0}
    snapshot = {"satellites": {"A": sat.satrec}, "objects": {"B": deb.satrec}}
    [refined] = live.Sgp4Refiner.refine([guess], snapshot, warning_km=1e6)
    assert refined["propagator"] == "SGP4"
    assert abs(refined["miss_distance_km"] - distance(truth_t)) < 0.005
    # This pair's minimum is thousands of km and very flat, so the TCA itself is loosely defined;
    # real conjunctions (km miss, km/s closing speed) are sharp and resolve to milliseconds.
    assert abs(refined["tca_ts"] - truth_t.timestamp()) < 1.0


def test_space_weather_parses_noaa_products(monkeypatch):
    responses = {
        "/products/noaa-planetary-k-index.json": [{"time_tag": "2026-09-14T06:00:00", "Kp": 5.33}],
        "/json/f107_cm_flux.json": [{"time_tag": "2026-09-13T20:00:00", "flux": 114.0},
                                    {"time_tag": "2026-09-13T22:00:00", "flux": 109.0}],
        "/products/noaa-scales.json": {"0": {"G": {"Scale": "1", "Text": "minor"}, "S": {"Scale": "0", "Text": "none"},
                                             "R": {"Scale": "0", "Text": "none"}}},
    }
    monkeypatch.setattr(space_weather, "_get", lambda path: responses[path])
    data = space_weather.fetch_space_weather(force=True)
    assert data["kp"] == 5.33 and data["kp_level"] == "storm"
    assert data["f107_sfu"] == 109.0 and data["scales"]["G"] == {"scale": 1, "text": "minor"}


def _fake_wikimedia(calls):
    """Offline Wikimedia: ISS has two Wikidata items (only one with a photo), Tianhe's item has no photo
    but its article has a free lead image, POISK has no item but a name search finds its article."""
    entities = {
        "Q1": {"labels": {"en": {"value": "International Space Station"}}, "sitelinks": {"enwiki": {"title": "International Space Station"}},
               "claims": {"P377": [{"mainsnak": {"datavalue": {"value": "25544"}}}],
                          "P18": [{"mainsnak": {"datavalue": {"value": "ISS photo.jpg"}}}]}},
        "Q2": {"labels": {"en": {"value": "Zarya"}}, "claims": {"P377": [{"mainsnak": {"datavalue": {"value": "25544"}}}]}},
        "Q3": {"labels": {"en": {"value": "Tianhe"}}, "sitelinks": {"enwiki": {"title": "Tianhe core module"}},
               "claims": {"P377": [{"mainsnak": {"datavalue": {"value": "48274"}}}]}},
    }

    def fake_get(url, params):
        calls.append((url, params))
        if params.get("list") == "search":
            return {"query": {"search": [{"title": q} for q in ("Q2", "Q1", "Q3")]}}
        if params.get("action") == "wbgetentities":
            return {"entities": {q: entities[q] for q in params["ids"].split("|")}}
        if url == imagery.WIKIPEDIA_API and "titles" in params:
            return {"query": {"pages": [{"title": "Tianhe core module", "description": "Chinese space station module",
                                         "pageimage": "Tianhe_lead.jpg"}]}}
        if url == imagery.WIKIPEDIA_API:   # name search
            if params["gsrsearch"] == "POISK":
                return {"query": {"pages": [{"title": "Poisk (ISS module)", "description": "ISS docking module"}]}}
            if params["gsrsearch"] == "FREGAT DEB":
                return {"query": {"pages": [{"title": "Fregat", "description": "Russian rocket upper stage"}]}}
            return {"query": {"pages": []}}
        if url == imagery.COMMONS_API:
            files = [t.removeprefix("File:") for t in params["titles"].split("|")]
            return {"query": {"normalized": [{"from": f"File:{f}", "to": f"File:{f.replace('_', ' ')}"} for f in files],
                              "pages": [{"title": f"File:{f}", "imageinfo": [{
                                  "thumburl": f"https://thumb/{f}", "url": f"https://full/{f}", "descriptionurl": f"https://page/{f}",
                                  "extmetadata": {"Artist": {"value": "<a href='x'>NASA</a>"}, "LicenseShortName": {"value": "Public domain"}},
                              }]} for f in files]}}
        raise AssertionError(f"unexpected request {url} {params}")
    return fake_get


@pytest.mark.asyncio
async def test_fleet_imagery_from_wikimedia(client, celestrak, monkeypatch):
    calls = []
    monkeypatch.setattr(imagery, "_get", _fake_wikimedia(calls))
    monkeypatch.setattr(imagery, "SEARCH_INTERVAL_S", 0)
    monkeypatch.setattr(imagery, "_last_failure", 0.0)
    await _load(client)

    items = (await client.get("/api/catalog/imagery")).json()["items"]
    assert len(items) == len(FIXTURE["stations"])
    iss = items["ISS (ZARYA)"]
    assert iss["match"] == "norad" and iss["title"] == "International Space Station"   # item with the photo wins
    assert iss["photo"]["image_url"] == "https://thumb/ISS photo.jpg" and iss["photo"]["credit"] == "NASA"
    assert iss["article_url"] == "https://en.wikipedia.org/wiki/International_Space_Station"
    assert items["CSS (TIANHE)"]["photo"]["image_url"] == "https://thumb/Tianhe lead.jpg"   # article lead image
    poisk = items["POISK"]
    assert poisk["match"] == "name" and poisk["photo"] is None and poisk["article_url"].endswith("Poisk_%28ISS_module%29")
    assert items["FREGAT DEB"]["match"] is None   # search hit isn't a spacecraft whose title has every word

    # Second request is served from the disk cache, including the "no photo" answers.
    n = len(calls)
    assert (await client.get("/api/catalog/imagery/ISS (ZARYA)")).json()["photo"]["full_url"] == "https://full/ISS photo.jpg"
    assert (await client.get("/api/catalog/imagery")).json()["items"] == items
    assert len(calls) == n
    assert (await client.get("/api/catalog/imagery/NOPE")).status_code == 404


@pytest.mark.asyncio
async def test_imagery_outage_is_not_cached(client, celestrak, monkeypatch):
    def down(url, params):
        raise imagery.ImageryError("www.wikidata.org unreachable")
    monkeypatch.setattr(imagery, "_get", down)
    monkeypatch.setattr(imagery, "_last_failure", 0.0)
    await _load(client)

    items = (await client.get("/api/catalog/imagery")).json()["items"]
    assert items and all(v is None for v in items.values())
    assert (await client.get("/api/catalog/imagery/ISS (ZARYA)")).status_code == 502

    calls = []
    monkeypatch.setattr(imagery, "_get", _fake_wikimedia(calls))
    monkeypatch.setattr(imagery, "SEARCH_INTERVAL_S", 0)
    monkeypatch.setattr(imagery, "_last_failure", 0.0)   # retry window elapsed
    assert (await client.get("/api/catalog/imagery")).json()["items"]["ISS (ZARYA)"]["photo"] is not None


@pytest.mark.asyncio
async def test_resize_fleet_keeps_everything_else(client, celestrak):
    await _load(client, max_satellites=8)
    state = app.state.orbital_state
    first = list(app.state.realworld.fleet)
    keeper, doomed = first[0], first[-1]
    k = state.sat_id_to_idx[keeper]
    state.sat_fuel[k] = 31.5
    state.sat_cooldown_timers[k] = 120.0
    keeper_state = state.sat_buffer[k].copy()
    keeper_slot = state.nominal_buffer[k].copy()
    t = state.now_ts + 3600
    state.maneuver_queue += [(t, keeper, 0.0, 0.001, 0.0, "B-KEEP", "MANUAL", "test"),
                             (t, doomed, 0.0, 0.001, 0.0, "B-GONE", "MANUAL", "test")]
    state.cdms.items.append({"cdm_id": "CDM-X", "satellite_id": doomed, "object_id": "X", "status": "ACTIVE",
                             "tca_ts": t, "risk": "WARNING", "mitigation_burn_ids": []})
    clock = state.current_time

    grown = (await client.post("/api/catalog/resize", json={"max_satellites": 14})).json()
    assert grown["satellites"] == 14 and len(grown["added"]) == 6 and grown["removed"] == []
    assert state.sat_count == 14 and state.current_time == clock
    k = state.sat_id_to_idx[keeper]
    assert state.sat_fuel[k] == 31.5 and state.sat_cooldown_timers[k] == 120.0
    assert np.array_equal(state.sat_buffer[k], keeper_state) and np.array_equal(state.nominal_buffer[k], keeper_slot)
    for sid in grown["added"]:   # new satellites start on their published orbit with a full tank
        assert state.sat_fuel[state.sat_id_to_idx[sid]] == pytest.approx(50.0)

    shrunk = (await client.post("/api/catalog/resize", json={"max_satellites": 5})).json()
    assert shrunk["satellites"] == 5 and set(grown["added"]) <= set(shrunk["removed"]) and doomed in shrunk["removed"]
    assert state.sat_count == 5 and set(state.sat_id_to_idx) == set(app.state.realworld.fleet) == set(first[:5])
    assert sorted(state.sat_id_to_idx.values()) == list(range(5))
    k = state.sat_id_to_idx[keeper]
    assert state.sat_fuel[k] == 31.5 and np.array_equal(state.sat_buffer[k], keeper_state)
    assert [m[5] for m in state.maneuver_queue] == ["B-KEEP"]
    assert any(h["burn_id"] == "B-GONE" and h["status"] == "cancelled" for h in state.maneuver_history)
    assert all(c["satellite_id"] != doomed for c in state.cdms.items)

    status = (await client.get("/api/catalog/status")).json()
    assert status["satellites"] == 5 and status["request"]["max_satellites"] == 5
    sats = (await client.get("/api/satellites")).json()["satellites"]
    assert {s["id"] for s in sats} == set(first[:5])

    capped = (await client.post("/api/catalog/resize", json={"max_satellites": 400})).json()
    assert capped["satellites"] < 400 and any("Only" in w for w in capped["warnings"])


@pytest.mark.asyncio
async def test_resize_requires_loaded_catalog(client, celestrak):
    resp = await client.post("/api/catalog/resize", json={"max_satellites": 10})
    assert resp.status_code == 409


def test_selection_takes_a_fair_share_of_every_source():
    class Obj:
        def __init__(self, source, n):
            self.source, self.norad_id = source, n
    chosen = [(Obj("starlink", i), None) for i in range(100)] + [(Obj("stations", 1000 + i), None) for i in range(3)] \
        + [(Obj("gps-ops", 2000 + i), None) for i in range(5)]
    picked = live.RealWorldService._round_robin(chosen, ["stations", "starlink", "gps-ops"])[:10]
    assert [o.source for o, _ in picked[:3]] == ["stations", "starlink", "gps-ops"]
    counts = {s: sum(o.source == s for o, _ in picked) for s in ("stations", "starlink", "gps-ops")}
    assert counts == {"stations": 3, "starlink": 4, "gps-ops": 3}


def test_constellation_members_share_one_family_search(monkeypatch):
    calls = []

    def fake_get(url, params):
        calls.append(params)
        if params.get("list") == "search":
            return {"query": {"search": []}}            # no Wikidata items
        if params.get("generator") == "search":
            if params["gsrsearch"] == "GAOFEN satellite":
                return {"query": {"pages": [{"index": 1, "title": "List of Gaofen launches", "description": "satellite list", "pageimage": "x.jpg"},
                                            {"index": 2, "title": "Gaofen", "description": "Chinese earth imaging satellites", "pageimage": "Gaofen_logo.svg"},
                                            {"index": 3, "title": "Gaofen", "description": "Chinese earth imaging satellites",
                                             "pageimage": "Gaofen_stack.jpg"}]}}
            return {"query": {"pages": []}}
        if url == imagery.COMMONS_API:
            return {"query": {"pages": [{"title": "File:Gaofen stack.jpg", "imageinfo": [{"thumburl": "https://thumb/gaofen", "url": "u", "descriptionurl": "d", "extmetadata": {}}]}],
                              "normalized": [{"from": "File:Gaofen_stack.jpg", "to": "File:Gaofen stack.jpg"}]}}
        raise AssertionError(params)

    monkeypatch.setattr(imagery, "_get", fake_get)
    monkeypatch.setattr(imagery, "SEARCH_INTERVAL_S", 0)
    monkeypatch.setattr(imagery, "MAX_SEARCHES", 3)
    monkeypatch.setattr(imagery, "_last_failure", 0.0)
    objs = [(100 + i, f"GAOFEN-{3000 + i}") for i in range(50)] + [(900 + i, f"ODDSAT-{i}") for i in range(2)] \
        + [(950 + i, f"LONER{i}") for i in range(4)]
    res = imagery.lookup(objs)
    gaofen = [res[100 + i] for i in range(50)]
    assert all(e["match"] == "family" and e["family"] == "Gaofen" and e["photo"]["image_url"] == "https://thumb/gaofen" for e in gaofen)
    assert sum(p.get("gsrsearch") == "GAOFEN satellite" for p in calls) == 1
    # The logo hit was skipped for the real photo. Budget of 3 searches: Gaofen + 2 single-name searches; the rest wait for the next lookup.
    resolved = [n for n in range(900, 954) if res.get(n) is not None]
    assert len(resolved) == 2 and sum(res[n] is None for n in (*range(900, 902), *range(950, 954))) == 4
    again = imagery.lookup(objs)   # LONER0..3 are a family of 4 too: one more search resolves them all
    assert all(again[n] is not None for n in (*range(900, 902), *range(950, 954)))
    assert again[950]["match"] is None


def test_starlink_uses_pinned_photo_not_logo(monkeypatch):
    assert imagery._wikipedia_family("STARLINK")["image"] == imagery.FAMILY_PHOTOS["STARLINK"][1]
    assert imagery._photo("Starlink_Logo_2024.svg") is None and imagery._photo("Coverage_map.png") is None
    assert imagery._photo("Render_of_Cartosat-3.png")
