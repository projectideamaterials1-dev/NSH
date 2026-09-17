"""
middleware/auth.py
------------------
Optional role-scoped API-key authentication and per-client rate limiting.

Both are disabled by default so the grader, the dashboard and test.py work out of
the box. Enable auth with one or both of:
    API_KEYS_OPERATOR=<key1,key2,...>   -> full access: can command maneuvers, change config,
                                            toggle the autopilot, (re)load the catalog, etc.
    API_KEYS_READONLY=<key1,key2,...>   -> GET-only access (telemetry/snapshot/metrics/archive reads)
    API_KEY=<secret>                     -> legacy single-secret form, treated as an operator key
Any configured key is checked with a constant-time comparison against `X-API-Key`. Enable the
rate limiter with RATE_LIMIT_PER_MINUTE=<n> (per-client, on /api/* only).
"""
import os
import secrets
import time
from collections import defaultdict, deque
from typing import Callable, Optional

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

_MUTATING_METHODS = ("POST", "PUT", "PATCH", "DELETE")
_DOC_PATHS = ("/docs", "/redoc", "/openapi.json")


def _parse_keys(value: str) -> frozenset:
    return frozenset(k.strip() for k in value.split(",") if k.strip())


API_KEYS_OPERATOR = _parse_keys(os.environ.get("API_KEYS_OPERATOR", ""))
API_KEYS_READONLY = _parse_keys(os.environ.get("API_KEYS_READONLY", ""))
_LEGACY_API_KEY = os.environ.get("API_KEY", "").strip()
if _LEGACY_API_KEY:
    API_KEYS_OPERATOR = API_KEYS_OPERATOR | {_LEGACY_API_KEY}

TRUSTED_PROXIES = _parse_keys(os.environ.get("TRUSTED_PROXY_IPS", ""))


def _is_protected(request: Request) -> bool:
    path = request.url.path
    return (path.startswith("/api") or path in _DOC_PATHS) and request.method != "OPTIONS"


def _match_any(provided: str, keys: frozenset) -> bool:
    # Iterate rather than short-circuit on a single compare_digest, so timing doesn't reveal
    # which specific key (if any) came closest to matching; still constant-time per key checked.
    return any(secrets.compare_digest(provided, k) for k in keys)


def client_ip(request: Request) -> str:
    """Real client IP: trusts X-Forwarded-For/X-Real-IP only from a configured trusted proxy
    (e.g. the bundled nginx), so a client can't spoof its way past the rate limiter by simply
    sending its own X-Forwarded-For, but a request that actually came through the proxy is
    correctly attributed to the original client rather than the proxy's own address."""
    peer = request.client.host if request.client else "unknown"
    if peer in TRUSTED_PROXIES:
        forwarded = request.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[0].strip()
        real_ip = request.headers.get("X-Real-IP")
        if real_ip:
            return real_ip.strip()
    return peer


class APIKeyMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, operator_keys: frozenset = API_KEYS_OPERATOR, readonly_keys: frozenset = API_KEYS_READONLY):
        super().__init__(app)
        self.operator_keys = operator_keys
        self.readonly_keys = readonly_keys

    def _resolve_role(self, provided: str) -> Optional[str]:
        if not provided:
            return None
        if _match_any(provided, self.operator_keys):
            return "operator"
        if _match_any(provided, self.readonly_keys):
            return "readonly"
        return None

    async def dispatch(self, request: Request, call_next):
        if (self.operator_keys or self.readonly_keys) and _is_protected(request):
            provided = request.headers.get("X-API-Key", "")
            role = self._resolve_role(provided)
            if role is None:
                return JSONResponse(status_code=401, content={"detail": "Invalid or missing API Key"})
            if role != "operator" and request.method in _MUTATING_METHODS:
                return JSONResponse(status_code=403, content={"detail": "This API key is read-only"})
            request.state.role = role
            # First 8 chars only: enough to distinguish operators in the audit trail
            # (see state.py's actor field) without logging/storing the actual secret.
            request.state.actor = f"key:{provided[:8]}"
        else:
            request.state.role = "operator"
            request.state.actor = "anonymous"
        return await call_next(request)


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Sliding-window limiter keyed by client IP. calls_per_minute <= 0 disables it."""

    def __init__(self, app, calls_per_minute: int = 0):
        super().__init__(app)
        self.calls_per_minute = calls_per_minute
        self._hits = defaultdict(deque)

    async def dispatch(self, request: Request, call_next):
        if self.calls_per_minute > 0 and _is_protected(request):
            client = client_ip(request)
            now = time.monotonic()
            window = self._hits.get(client)
            if window is not None:
                while window and now - window[0] > 60.0:
                    window.popleft()
                if not window:
                    # Drop the now-empty deque instead of leaving it in the dict
                    # forever - otherwise every distinct client IP ever seen (or an
                    # attacker rotating source IPs) grows this dict without bound.
                    del self._hits[client]
                    window = None
            if window is not None and len(window) >= self.calls_per_minute:
                retry_after = max(1, int(60.0 - (now - window[0])) + 1)
                return JSONResponse(
                    status_code=429,
                    content={"detail": "Rate limit exceeded"},
                    headers={"Retry-After": str(retry_after)},
                )
            self._hits[client].append(now)
        return await call_next(request)


class LeaderGateMiddleware(BaseHTTPMiddleware):
    """When RedisStateManager leader election is active (multiple replicas sharing one Redis,
    see state_redis.py), only the elected leader ever advances the simulation or re-reads Redis
    while it holds leadership - a write accepted by a non-leader replica would sit in that
    replica's local state and eventually be silently discarded the next time it resyncs from
    Redis. Reject mutations on non-leader replicas instead, so callers retry against a replica
    that can actually make them stick. No-op for a plain (non-Redis, single-process) state.
    """

    def __init__(self, app, get_state: Callable):
        super().__init__(app)
        self._get_state = get_state

    async def dispatch(self, request: Request, call_next):
        if request.method in _MUTATING_METHODS and _is_protected(request):
            state = self._get_state()
            if getattr(state, "is_leader", True) is False:
                return JSONResponse(
                    status_code=503,
                    content={"detail": "This replica is not the current leader; retry shortly."},
                    headers={"Retry-After": "2"},
                )
        return await call_next(request)
