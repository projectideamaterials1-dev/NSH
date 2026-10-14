"""Webhook notifications: filtering, de-duplication, rate limit, retries - delivered off the state lock."""
import json

import httpx

from satellite_api.notify import WebhookNotifier


class FakeState:
    def __init__(self):
        self.listeners = []

    def emit(self, level, category, message, satellite_id=None):
        event = {"level": level, "category": category, "message": message, "satellite_id": satellite_id,
                 "sim_time": "2026-01-01T00:00:00.000Z"}
        for listener in self.listeners:
            listener("event", event)


def _notifier(handler, **kw):
    return WebhookNotifier(["https://hooks.example/a"], transport=httpx.MockTransport(handler), **kw)


def test_only_events_at_or_above_the_level_and_in_the_categories_are_sent():
    got = []
    n = _notifier(lambda r: (got.append(json.loads(r.content)), httpx.Response(200))[1],
                  min_level="warn", categories=["conjunction"])
    state = FakeState()
    n.attach(state)
    state.emit("info", "conjunction", "quiet")
    state.emit("crit", "autopilot", "other category")
    state.emit("crit", "conjunction", "Critical conjunction with DEB-1", satellite_id="SAT-A")
    state.emit("warn", "conjunction", "Warning conjunction with DEB-2")
    n.flush()
    assert [g["event"]["message"] for g in got] == ["Critical conjunction with DEB-1", "Warning conjunction with DEB-2"]
    assert got[0]["text"].startswith("🔴 NSH conjunction [SAT-A]: Critical conjunction with DEB-1")
    assert n.stats() == {"webhooks": 1, "sent": 2, "failed": 0, "dropped": 0}


def test_duplicates_are_suppressed_and_the_rate_is_limited():
    n = _notifier(lambda r: httpx.Response(200), max_per_min=3)
    state = FakeState()
    n.attach(state)
    for _ in range(3):
        state.emit("crit", "conjunction", "same message")
    for i in range(5):
        state.emit("crit", "conjunction", f"message {i}")
    n.flush()
    assert n.sent == 3 and n.dropped == 3          # 1 de-duplicated + 2 new ones, then 3 over the limit


def test_failing_webhook_is_retried_then_counted_never_raised(monkeypatch):
    monkeypatch.setattr("satellite_api.notify.time.sleep", lambda s: None)
    calls = []
    n = _notifier(lambda r: (calls.append(1), httpx.Response(500))[1])
    state = FakeState()
    n.attach(state)
    state.emit("crit", "conjunction", "boom")
    n.flush()
    assert len(calls) == 3 and n.failed == 1 and n.sent == 0
