from satellite_api import redis_conn


def test_sentinel_configuration_parsing(monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.delenv("REDIS_SENTINELS", raising=False)
    assert not redis_conn.configured()
    monkeypatch.setenv("REDIS_SENTINELS", "sentinel-1:26379, sentinel-2:26380 ,sentinel-3")
    monkeypatch.setenv("REDIS_SENTINEL_MASTER", "acm")
    assert redis_conn.sentinel_hosts() == [("sentinel-1", 26379), ("sentinel-2", 26380), ("sentinel-3", 26379)]
    assert redis_conn.configured()
    assert redis_conn.describe() == "sentinel:acm@sentinel-1:26379,sentinel-2:26380,sentinel-3:26379"


def test_clients_are_sentinel_managed_when_configured(monkeypatch):
    monkeypatch.setenv("REDIS_SENTINELS", "127.0.0.1:1")
    monkeypatch.setenv("REDIS_PASSWORD", "pw")
    from redis.asyncio.sentinel import SentinelConnectionPool as AsyncPool
    from redis.sentinel import SentinelConnectionPool as SyncPool
    assert isinstance(redis_conn.async_client().connection_pool, AsyncPool)     # no connection is made yet
    assert isinstance(redis_conn.sync_client().connection_pool, SyncPool)
