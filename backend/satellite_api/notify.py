"""
notify.py
---------
Pushes operator events (critical conjunctions, maneuvers detected, burns rejected, ...) to chat or
incident tools through webhooks - the way STM services alert by e-mail, Teams, Slack or webhook
instead of waiting for someone to look at the dashboard.

    NOTIFY_WEBHOOK_URLS   comma-separated URLs (Slack / Teams / Mattermost incoming webhooks, or any
                          endpoint that accepts JSON). Unset = notifications off.
    NOTIFY_MIN_LEVEL      lowest event level sent: info | ok | warn | crit (default crit)
    NOTIFY_CATEGORIES     comma-separated event categories to send (default: all)
    NOTIFY_MAX_PER_MIN    rate limit across all webhooks (default 20); the rest are counted and dropped

The JSON body has a "text" field (rendered by Slack, Teams and Mattermost) plus the full event
under "event". Delivery runs on its own thread with a bounded queue, so a slow or unreachable
webhook can never stall screening; failures are retried 3 times and then logged.
"""
import logging
import os
import queue
import threading
import time
from collections import deque
from typing import List, Optional

import httpx

logger = logging.getLogger(__name__)

LEVEL_RANK = {"info": 0, "ok": 0, "warn": 1, "crit": 2}
_ICON = {"crit": "🔴", "warn": "🟠", "ok": "🟢", "info": "🔵"}
DEDUPE_S = 600.0          # the same message is sent at most once per 10 minutes


class WebhookNotifier:
    def __init__(self, urls: List[str], min_level: str = "crit", categories: Optional[List[str]] = None,
                 max_per_min: int = 20, transport: Optional[httpx.BaseTransport] = None):
        self.urls = urls
        self.min_rank = LEVEL_RANK.get(min_level, 2)
        self.categories = set(categories) if categories else None
        self.max_per_min = max_per_min
        self.sent = self.failed = self.dropped = 0
        self._recent: deque = deque()            # send times in the last minute
        self._last_sent: dict = {}               # message -> time, for de-duplication
        self._queue: "queue.Queue[dict]" = queue.Queue(maxsize=500)
        self._client = httpx.Client(timeout=10.0, transport=transport)
        self._thread = threading.Thread(target=self._run, name="webhook-notifier", daemon=True)
        self._thread.start()

    @classmethod
    def from_env(cls) -> Optional["WebhookNotifier"]:
        urls = [u.strip() for u in os.environ.get("NOTIFY_WEBHOOK_URLS", "").split(",") if u.strip()]
        if not urls:
            return None
        cats = [c.strip() for c in os.environ.get("NOTIFY_CATEGORIES", "").split(",") if c.strip()]
        return cls(urls, os.environ.get("NOTIFY_MIN_LEVEL", "crit"), cats or None,
                   int(os.environ.get("NOTIFY_MAX_PER_MIN", "20")))

    def attach(self, state) -> "WebhookNotifier":
        if self.handle not in state.listeners:
            state.listeners.append(self.handle)
        return self

    # ── state listener (called under the state lock: must not block) ──────────────
    def handle(self, kind: str, payload: dict):
        if kind != "event" or LEVEL_RANK.get(payload.get("level"), 0) < self.min_rank:
            return
        if self.categories is not None and payload.get("category") not in self.categories:
            return
        now = time.monotonic()
        msg = payload.get("message", "")
        if now - self._last_sent.get(msg, -1e18) < DEDUPE_S:
            return
        while self._recent and now - self._recent[0] > 60.0:
            self._recent.popleft()
        if len(self._recent) >= self.max_per_min:
            self.dropped += 1
            return
        self._recent.append(now)
        self._last_sent[msg] = now
        try:
            self._queue.put_nowait(payload)
        except queue.Full:
            self.dropped += 1

    # ── delivery thread ───────────────────────────────────────────────────────────
    @staticmethod
    def body(event: dict) -> dict:
        sat = f" [{event['satellite_id']}]" if event.get("satellite_id") else ""
        when = event.get("sim_time") or event.get("wall_time") or ""
        text = f"{_ICON.get(event.get('level'), '')} NSH {event.get('category', '')}{sat}: {event.get('message', '')} ({when} UTC)"
        return {"text": text, "event": event}

    def _post(self, url: str, body: dict) -> bool:
        for attempt in range(3):
            try:
                r = self._client.post(url, json=body)
                if r.status_code < 300:
                    return True
                logger.warning(f"Webhook {url[:40]}... answered {r.status_code}")
            except httpx.HTTPError as e:
                logger.warning(f"Webhook {url[:40]}... failed: {type(e).__name__}")
            time.sleep(0.5 * 2 ** attempt)
        return False

    def _run(self):
        while True:
            event = self._queue.get()
            if event is None:
                return
            body = self.body(event)
            for url in self.urls:
                if self._post(url, body):
                    self.sent += 1
                else:
                    self.failed += 1
            self._queue.task_done()

    def flush(self, timeout: float = 5.0):
        """Waits until queued notifications are delivered (tests, shutdown)."""
        deadline = time.monotonic() + timeout
        while self._queue.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.02)

    def close(self):
        self.flush(2.0)
        self._queue.put(None)
        self._client.close()

    def stats(self) -> dict:
        return {"webhooks": len(self.urls), "sent": self.sent, "failed": self.failed, "dropped": self.dropped}
