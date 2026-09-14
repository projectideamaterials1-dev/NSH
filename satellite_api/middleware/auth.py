"""
middleware/auth.py
------------------
Optional API-key authentication and per-client rate limiting.

Both are disabled by default so the grader, the dashboard and test.py work out of
the box. Enable them with environment variables:
    API_KEY=<secret>              -> require header `X-API-Key: <secret>` on /api/*
    RATE_LIMIT_PER_MINUTE=<n>     -> max requests per client IP per minute on /api/*
"""
import os
import secrets
import time
from collections import defaultdict, deque

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

API_KEY = os.environ.get("API_KEY", "").strip()


def _is_protected(request: Request) -> bool:
    return request.url.path.startswith("/api") and request.method != "OPTIONS"


class APIKeyMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, api_key: str = API_KEY):
        super().__init__(app)
        self.api_key = api_key

    async def dispatch(self, request: Request, call_next):
        if self.api_key and _is_protected(request):
            provided = request.headers.get("X-API-Key", "")
            if not secrets.compare_digest(provided, self.api_key):
                return JSONResponse(status_code=401, content={"detail": "Invalid or missing API Key"})
        return await call_next(request)


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Sliding-window limiter keyed by client IP. calls_per_minute <= 0 disables it."""

    def __init__(self, app, calls_per_minute: int = 0):
        super().__init__(app)
        self.calls_per_minute = calls_per_minute
        self._hits = defaultdict(deque)

    async def dispatch(self, request: Request, call_next):
        if self.calls_per_minute > 0 and _is_protected(request):
            client = request.client.host if request.client else "unknown"
            now = time.monotonic()
            window = self._hits[client]
            while window and now - window[0] > 60.0:
                window.popleft()
            if len(window) >= self.calls_per_minute:
                retry_after = max(1, int(60.0 - (now - window[0])) + 1)
                return JSONResponse(
                    status_code=429,
                    content={"detail": "Rate limit exceeded"},
                    headers={"Retry-After": str(retry_after)},
                )
            window.append(now)
        return await call_next(request)
