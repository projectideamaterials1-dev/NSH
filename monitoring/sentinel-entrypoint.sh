#!/bin/sh
# Writes a sentinel config (sentinels rewrite their own config, so it must live somewhere
# writable) and starts redis-sentinel. Used by the `ha` compose profile. The master is given by
# IP (REDIS_MASTER_IP): once a container stops, its hostname no longer resolves.
set -eu
# Start by monitoring whichever data node currently IS the master (after a failover that is the
# former replica), falling back to REDIS_MASTER_IP if none answers yet.
MASTER="${REDIS_MASTER_IP}"
for ip in ${REDIS_NODE_IPS:-$REDIS_MASTER_IP}; do
  if redis-cli -h "$ip" -a "$REDIS_PASSWORD" --no-auth-warning info replication 2>/dev/null | grep -q '^role:master'; then
    MASTER="$ip"
    break
  fi
done
echo "sentinel: monitoring master $MASTER"
cat > /data/sentinel.conf <<CONF
port 26379
sentinel monitor ${SENTINEL_MASTER:-acm} ${MASTER} 6379 2
sentinel auth-pass ${SENTINEL_MASTER:-acm} ${REDIS_PASSWORD}
sentinel down-after-milliseconds ${SENTINEL_MASTER:-acm} ${SENTINEL_DOWN_AFTER_MS:-5000}
sentinel failover-timeout ${SENTINEL_MASTER:-acm} ${SENTINEL_FAILOVER_TIMEOUT_MS:-10000}
sentinel parallel-syncs ${SENTINEL_MASTER:-acm} 1
requirepass ${REDIS_PASSWORD}
CONF
exec redis-sentinel /data/sentinel.conf
