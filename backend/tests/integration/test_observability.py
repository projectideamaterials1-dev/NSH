"""Prometheus metrics, data-feed validation and feed-health monitoring."""
import time

import pytest

from satellite_api import feed_health
from satellite_api.acm.scenario import circular_state_over, make_threat
from satellite_api.feed_health import FeedMonitor, assess
from satellite_api.realworld import catalog, space_weather
from tests.conftest import make_object

T0 = "2026-01-01T00:00:00.000Z"


@pytest.fixture(autouse=True)
def _reset_feeds(monkeypatch):
    monkeypatch.setattr(catalog, "FEED", {"last_success": None, "last_error": None, "last_error_at": None,
                                          "last_rejected": None, "last_rejected_at": None})
    monkeypatch.setattr(space_weather, "FEED", {"last_success": None, "last_error": None, "last_error_at": None})
    monkeypatch.setattr(space_weather, "_cache", {"at": 0.0, "data": None})
    monkeypatch.delenv("METRICS_TOKEN", raising=False)


async def _seed(client):
    sat = circular_state_over(13.0, 77.5, 1767225600.0)
    objects = [make_object("SAT-M", "SATELLITE", sat[:3], sat[3:]),
               make_object("DEB-M", "DEBRIS", *(lambda d: (d[:3], d[3:]))(make_threat(sat, 1800.0, 0.05)))]
    await client.post("/api/telemetry", json={"timestamp": T0, "objects": objects})
    await client.post("/api/conjunctions/screen", params={"horizon_s": 3600, "plan": False})


@pytest.mark.asyncio
async def test_metrics_expose_mission_and_http_series(client):
    await _seed(client)
    resp = await client.get("/metrics")
    assert resp.status_code == 200 and resp.headers["content-type"].startswith("text/plain")
    body = resp.text
    for series in ('acm_satellites 1.0', 'acm_debris_objects 1.0', 'acm_conjunctions_open{risk="CRITICAL"} 1.0',
                   'acm_collisions_total', 'acm_screen_duration_seconds_count', 'acm_feed_status{feed="celestrak"} 0.0',
                   'acm_http_requests_total{method="POST",route="/api/telemetry",status="2xx"}', 'acm_info{engine='):
        assert series in body, series


@pytest.mark.asyncio
async def test_metrics_token_is_enforced_when_set(client, monkeypatch):
    monkeypatch.setenv("METRICS_TOKEN", "s3cret")
    assert (await client.get("/metrics")).status_code == 401
    ok = await client.get("/metrics", headers={"Authorization": "Bearer s3cret"})
    assert ok.status_code == 200


def test_corrupt_or_truncated_celestrak_download_is_rejected():
    good = {"OBJECT_NAME": "X", "NORAD_CAT_ID": 1, "EPOCH": "2026-01-01T00:00:00", "MEAN_MOTION": 15.5,
            "ECCENTRICITY": 0.001, "INCLINATION": 51.6}
    assert catalog.record_problem(good) is None
    assert "mean motion" in catalog.record_problem({**good, "MEAN_MOTION": 99})
    assert "eccentricity" in catalog.record_problem({**good, "ECCENTRICITY": 1.5})
    assert catalog.validate_download([good] * 10, None) is None
    assert "sanity" in catalog.validate_download([good] * 5 + [{**good, "INCLINATION": 400}] * 5, None)
    assert "truncated" in catalog.validate_download([good] * 5, {"records": [good] * 100})


def test_corrupt_download_falls_back_to_cache(monkeypatch, tmp_path):
    good = {"OBJECT_NAME": "X", "NORAD_CAT_ID": 1, "EPOCH": "2026-01-01T00:00:00", "MEAN_MOTION": 15.5,
            "ECCENTRICITY": 0.001, "INCLINATION": 51.6}
    catalog._write_cache("unit-feed", [good] * 30)
    monkeypatch.setattr(catalog, "_http_query", lambda q: [{**good, "MEAN_MOTION": -1}] * 30)
    records, info = catalog.fetch_query("unit-feed", ["Q"], force=True)
    assert len(records) == 30 and info["stale"] is True
    assert "unit-feed" in catalog.FEED["last_rejected"]


def test_space_weather_rejects_out_of_range_values(monkeypatch):
    def fake_get(path):
        if "k-index" in path:
            return [{"time_tag": "2026-01-01T00:00:00", "Kp": 42}]
        if "f107" in path:
            return [{"time_tag": "2026-01-01T00:00:00", "flux": 150}]
        return {"0": {k: {"Scale": "0", "Text": "none"} for k in "GSR"}}
    monkeypatch.setattr(space_weather, "_get", fake_get)
    data = space_weather.fetch_space_weather(force=True)
    assert data["kp"] is None and data["f107_sfu"] == 150
    assert any("Kp" in e for e in data["errors"])


@pytest.mark.asyncio
async def test_feed_monitor_reports_status_changes(client, monkeypatch):
    from satellite_api.main import app
    monkeypatch.setattr(feed_health, "WEATHER_REFRESH_S", 1e9)     # no network in tests
    monitor = FeedMonitor(app)
    monitor._last_weather = time.monotonic()
    await _seed(client)

    space_weather._cache.update(at=time.time(), data={"kp": 3.0, "f107_sfu": 140.0, "kp_time": T0, "errors": None})
    space_weather.FEED["last_success"] = time.time()
    first = await monitor.check()
    # The Kp sample is months older than the simulated "now": stale, but no event on the first look.
    assert first["noaa_swpc"]["status"] == "stale"

    space_weather._cache["data"]["kp_time"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    second = await monitor.check()
    assert second["noaa_swpc"]["status"] == "ok"
    events = (await client.get("/api/events")).json()["events"]
    assert any(e["category"] == "data_feed" and "recovered" in e["message"] for e in events)

    health = (await client.get("/health")).json()
    assert health["feeds"]["noaa_swpc"] == "ok" and health["feeds"]["celestrak"] == "idle"
    assert set((await client.get("/api/feeds")).json()) == {"celestrak", "noaa_swpc"}


def test_assess_marks_missing_weather_as_idle_then_error():
    assert assess(None)["noaa_swpc"]["status"] == "idle"
    space_weather.FEED.update(last_error="NOAA unreachable", last_error_at=time.time())
    assert assess(None)["noaa_swpc"]["status"] == "error"
