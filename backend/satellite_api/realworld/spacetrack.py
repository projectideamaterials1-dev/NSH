"""
realworld/spacetrack.py
-----------------------
Space-Track.org client for public conjunction data messages (`cdm_public`): the 18th/19th Space
Defense Squadrons' screening of the public catalog, used as the authoritative cross-check for this
engine's own conjunctions (external Pc and miss distance shown side by side).

Enabled when SPACETRACK_IDENTITY and SPACETRACK_PASSWORD are set (free account). Space-Track
limits clients to 30 requests/minute and 300/hour, so the poller queries at most once per
SPACETRACK_POLL_S (default 1 h), batching the fleet's NORAD ids. Operators with access to the
full `cdm` class (with covariance) can upload those messages via POST /api/cdm instead.
"""
import http.cookiejar
import json
import logging
import os
import time
import urllib.parse
import urllib.request
from typing import Dict, Iterable, List, Optional

logger = logging.getLogger(__name__)

BASE_URL = os.environ.get("SPACETRACK_URL", "https://www.space-track.org")
POLL_S = float(os.environ.get("SPACETRACK_POLL_S", "3600"))
BATCH = 100                     # NORAD ids per query (URL length)
TIMEOUT_S = 60

FEED: Dict[str, object] = {"configured": False, "last_success": None, "last_error": None, "last_error_at": None,
                           "last_count": 0}


class SpaceTrackError(RuntimeError):
    pass


def credentials() -> Optional[tuple]:
    ident, pw = os.environ.get("SPACETRACK_IDENTITY"), os.environ.get("SPACETRACK_PASSWORD")
    return (ident, pw) if ident and pw else None


class SpaceTrackClient:
    def __init__(self, identity: str, password: str, opener=None):
        self.identity, self.password = identity, password
        self.opener = opener or urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self._logged_in = False

    def _login(self):
        data = urllib.parse.urlencode({"identity": self.identity, "password": self.password}).encode()
        with self.opener.open(urllib.request.Request(f"{BASE_URL}/ajaxauth/login", data=data), timeout=TIMEOUT_S) as r:
            body = r.read().decode("utf-8", errors="replace")
        if '"Login":"Failed"' in body.replace(" ", ""):
            raise SpaceTrackError("Space-Track login failed (check SPACETRACK_IDENTITY / SPACETRACK_PASSWORD)")
        self._logged_in = True

    def _get(self, path: str) -> list:
        if not self._logged_in:
            self._login()
        with self.opener.open(f"{BASE_URL}{path}", timeout=TIMEOUT_S) as r:
            text = r.read().decode("utf-8", errors="replace").strip()
        if not text:
            return []
        data = json.loads(text)
        if isinstance(data, dict) and data.get("error"):
            raise SpaceTrackError(str(data["error"]))
        return data if isinstance(data, list) else []

    def public_cdms(self, norad_ids: Iterable[int]) -> List[dict]:
        """Upcoming public CDMs where any of `norad_ids` is the primary or secondary object."""
        ids = sorted({int(i) for i in norad_ids})
        records, seen = [], set()
        for start in range(0, len(ids), BATCH):
            chunk = ",".join(str(i) for i in ids[start:start + BATCH])
            for field in ("SAT_1_ID", "SAT_2_ID"):
                path = (f"/basicspacedata/query/class/cdm_public/{field}/{chunk}/TCA/%3Enow"
                        f"/orderby/TCA%20asc/format/json")
                for rec in self._get(path):
                    key = rec.get("CDM_ID")
                    if key not in seen:
                        seen.add(key)
                        records.append(rec)
        return records


class SpaceTrackPoller:
    """Fetches public CDMs for the loaded fleet at most every POLL_S and feeds the CDM store."""

    def __init__(self, client_factory=None):
        self.client_factory = client_factory or (lambda: SpaceTrackClient(*credentials()))
        self._client = None
        # -inf, not 0: time.monotonic() counts from boot on Linux, so a freshly started container
        # would otherwise wait up to POLL_S before its first poll.
        self._last = float("-inf")

    def due(self) -> bool:
        FEED["configured"] = credentials() is not None
        return FEED["configured"] and time.monotonic() - self._last >= POLL_S

    def fetch(self, norad_ids: Iterable[int]) -> List[dict]:
        """Blocking; run in a worker thread."""
        self._last = time.monotonic()
        try:
            if self._client is None:
                self._client = self.client_factory()
            records = self._client.public_cdms(norad_ids)
        except Exception as e:
            self._client = None                           # re-login next time
            FEED.update(last_error=str(e), last_error_at=time.time())
            logger.warning(f"Space-Track CDM fetch failed: {e}")
            raise
        FEED.update(last_success=time.time(), last_count=len(records))
        return records
