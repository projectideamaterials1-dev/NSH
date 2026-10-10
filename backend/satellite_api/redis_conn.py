"""
redis_conn.py
-------------
Redis connections for the state snapshot / leader lock and the backup CLI.

Single instance:   REDIS_URL=redis://:<password>@redis:6379/0
High availability: REDIS_SENTINELS=sentinel-1:26379,sentinel-2:26379,sentinel-3:26379
                   REDIS_SENTINEL_MASTER=acm   (default)
                   REDIS_PASSWORD=<password>   (data nodes; also used for the sentinels unless
                                                REDIS_SENTINEL_PASSWORD is set)
                   REDIS_DB=0

With sentinels, clients ask the sentinels for the current master on every (re)connection, so
when a master fails and the sentinels promote its replica, the backend follows automatically.
Replication is asynchronous: writes acknowledged in the last instant before a failover can be
lost, which the 10 s autosave cadence already bounds (the next autosave rewrites the snapshot).
"""
import os
from typing import List, Optional, Tuple


def sentinel_hosts() -> List[Tuple[str, int]]:
    out = []
    for item in os.environ.get("REDIS_SENTINELS", "").split(","):
        item = item.strip()
        if not item:
            continue
        host, _, port = item.rpartition(":")
        out.append((host or item, int(port) if port.isdigit() else 26379))
    return out


def configured() -> bool:
    return bool(sentinel_hosts() or os.environ.get("REDIS_URL", "").strip())


def describe() -> str:
    hosts = sentinel_hosts()
    if hosts:
        return f"sentinel:{os.environ.get('REDIS_SENTINEL_MASTER', 'acm')}@" + ",".join(f"{h}:{p}" for h, p in hosts)
    return "redis"


def _sentinel_kwargs() -> Tuple[dict, dict, str]:
    password = os.environ.get("REDIS_PASSWORD") or None
    sentinel_password = os.environ.get("REDIS_SENTINEL_PASSWORD") or password
    master = os.environ.get("REDIS_SENTINEL_MASTER", "acm")
    node = {"password": password, "db": int(os.environ.get("REDIS_DB", "0")), "socket_timeout": 5.0}
    return {"password": sentinel_password} if sentinel_password else {}, node, master


def async_client(url: Optional[str] = None):
    """redis.asyncio client: the Sentinel-managed master when sentinels are configured."""
    hosts = sentinel_hosts()
    if hosts:
        from redis.asyncio.sentinel import Sentinel
        sentinel_kw, node_kw, master = _sentinel_kwargs()
        return Sentinel(hosts, sentinel_kwargs=sentinel_kw, **node_kw).master_for(master, decode_responses=False)
    import redis.asyncio as redis
    return redis.from_url(url or os.environ["REDIS_URL"], decode_responses=False)


def sync_client(url: Optional[str] = None):
    """Synchronous client (backup CLI), Sentinel-aware like async_client()."""
    hosts = sentinel_hosts()
    if hosts:
        from redis.sentinel import Sentinel
        sentinel_kw, node_kw, master = _sentinel_kwargs()
        return Sentinel(hosts, sentinel_kwargs=sentinel_kw, **node_kw).master_for(master, decode_responses=False)
    import redis
    return redis.Redis.from_url(url or os.environ["REDIS_URL"], decode_responses=False)
