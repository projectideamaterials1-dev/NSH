# Operations runbooks

Every Prometheus alert in `monitoring/alerts.yml` links to a section here. Commands assume the
production compose stack on the deployment host (`cd` into the repo checkout first):

```bash
COMPOSE="docker compose -f docker-compose.prod.yml"
```

Dashboards: Grafana on `127.0.0.1:3001`, opening at "Crimson Nebula — mission & service health". Prometheus
is on `:9090` and Alertmanager on `:9093`. All three bind to localhost only, so reach them through an SSH
tunnel, e.g. `ssh -L 3001:localhost:3001 host`. Start them with `$COMPOSE --profile monitoring up -d`.

---

## Backend down

**Signal:** `BackendDown`, or the container healthcheck reports unhealthy.

1. `$COMPOSE ps` and `$COMPOSE logs --tail=200 backend`.
2. Startup failure with `REQUIRE_DURABLE_STATE is set but Redis restore/autosave failed`: go to
   [Redis unreachable](#redis-unreachable).
3. Crash right after a deploy: `scripts/deploy.sh` rolls back automatically. If it reports
   `ROLLBACK ALSO UNHEALTHY`, roll back by hand:
   `BACKEND_IMAGE=$(cat .deployed-image) $COMPOSE up -d --no-build backend`. If the previous image
   is the broken one, check `git tag` and pick the last good release.
4. Out of memory (`OOMKilled` in `docker inspect`): raise `BACKEND_MEMORY` in `.env`. Large catalogs
   (20k+ objects) need more than the 2 GB default.

## Redis unreachable

**Signal:** the backend logs `Redis unavailable (...); continuing without persistence`, or it refuses
to start when `REQUIRE_DURABLE_STATE=1`.

1. `$COMPOSE ps redis`. The service has a `redis-cli ping` healthcheck.
2. `$COMPOSE logs redis`. Look for `OOM command not allowed`: `maxmemory` was reached under the
   `noeviction` policy. Raise `REDIS_MAXMEMORY` (the default is 384 MB) and restart Redis.
3. An `AUTH` failure means `REDIS_PASSWORD` in `.env` changed while the volume kept the old one.
   Restore the old password, or restart both services together.
4. While Redis is down, state lives only in the leader's memory. Restore Redis **before**
   restarting the backend, or that in-memory state is lost.
5. Run the `ha` profile so a single Redis failure is survivable (next section).

### Redis high availability (Sentinel)

```bash
# .env
REDIS_SENTINELS=sentinel-1:26379,sentinel-2:26379,sentinel-3:26379
# start: primary + replica + three sentinels (quorum 2)
$COMPOSE --profile ha up -d
curl -sk https://localhost/health      # "redis": "sentinel:acm@sentinel-1:26379,..."
```

How it behaves (measured on this stack): the primary is marked down after
`SENTINEL_DOWN_AFTER_MS` (5 s) and the replica is promoted within a few seconds. A split sentinel
vote retries after 2 × `SENTINEL_FAILOVER_TIMEOUT_MS` (20 s). The backend follows the new primary
on its next reconnect, and writes resume after the leader-lock TTL (about 30 s end to end). A
returning former primary rejoins as a replica, and restarted sentinels discover the current
primary by asking each data node for its role.

- The data nodes have fixed IPs (`ACM_SUBNET_PREFIX`, default `172.28.0`). Sentinel monitors by IP
  because a stopped container's hostname stops resolving. Change the prefix if it collides with a
  network on the host.
- Replication is asynchronous. A write acknowledged in the instant before a failover can be lost,
  and the next autosave (every 10 s) rewrites the snapshot.
- Check the topology:
  `$COMPOSE exec sentinel-1 redis-cli -p 26379 -a "$REDIS_PASSWORD" sentinel get-master-addr-by-name acm`.

## No leader / leader stuck

**Signal:** `NoLeader` (nobody runs the autopilot or screening) or `MultipleLeaders`.

1. `curl -s localhost:8000/health` in each replica (`$COMPOSE exec backend ...`) and check `is_leader`.
2. **No leader:** the lock `acm:state:leader` has a TTL (`LEADER_LOCK_TTL_S`, 15 s by default). If it
   persists, a replica holds it but is stalled. Restart that replica. As a last resort, clear the lock:
   `$COMPOSE exec redis redis-cli -a "$REDIS_PASSWORD" del acm:state:leader`.
3. **Multiple leaders:** this usually means a network partition, or replicas pointing at different
   Redis instances. Check that every replica has the same `REDIS_URL`. Scale down to one replica
   until it is resolved.
4. Writes to a non-leader return 503 by design (`LeaderGateMiddleware`). Clients should retry.

## Orphaned pending maneuvers

**Signal:** `UnreconciledManeuvers`, and `/health` shows `unreconciled_maneuvers > 0`.

These are burns that were queued but had no recorded outcome when the process stopped uncleanly.

1. List them: `GET /api/archive/maneuvers?status=pending`.
2. For each one, decide from the satellite's current state whether the burn still makes sense.
   The autopilot re-plans live threats by itself; stale burns should not be re-issued.
3. On a fresh deployment with only demo data, it is safe to move `backend/data/acm_archive.db`
   aside (back it up first, see below).

## Screening latency regression

**Signal:** `ScreeningFallingBehind` (critical) or `ScreeningSlow`.

1. Grafana shows "Screening cycle duration" and "Screening budget used". When the budget passes
   100 %, refinement is already bounded to the highest-risk candidates (no threat is dropped
   permanently; the broad phase still scans everything).
2. Check `/health`: `engine` must be `cpp`. `numpy` means the C++ extension did not load, which is
   about 10× slower. Rebuild the image.
3. Load: object count (`acm_debris_objects`) and look-ahead (`cdmHorizonSeconds`). Reduce the
   horizon or `REALWORLD_MAX_OBJECTS`, or raise `BACKEND_CPUS` (OpenMP scales with cores).
4. If the regression started with a release, compare the benchmark job
   (`tests/benchmark/test_screening_latency.py`) between tags.

## Critical conjunction not mitigated

**Signal:** `CriticalConjunctionOpen` for 10 minutes.

1. Threats tab: open the conjunction (crosshair button) for the encounter plane, Pc and the trade
   space.
2. Decisions tab: the autopilot's reasoning. Common blockers are `NO_LINE_OF_SIGHT` (waiting for a
   ground-station pass), `COOLDOWN_ACTIVE`, `INSUFFICIENT_FUEL`, or "no evasion option is fully
   clean" (every alternative creates a secondary conjunction).
3. In approval mode, check for a pending proposal. See [Proposal awaiting approval](#proposal-awaiting-approval).
4. A manual plan is available from the satellite panel (**Burn**). It is validated against the same rules.
5. **Before acting on a real spacecraft, confirm against an authoritative CDM.** Pc here uses a
   modelled covariance (see `docs/VALIDATION.md`).

## Proposal awaiting approval

**Signal:** `ProposalAwaitingApproval` (approval mode only).

1. Decisions tab: read the rationale and the options considered, then **Approve** or **Reject**.
2. Approval re-targets the burns from the current state, so a late approval is still valid as long
   as the encounter has not passed.
3. If nobody answers, `approvalTimeoutAction` applies: `DISCARD` re-plans on the next cycle, and
   `EXECUTE` runs the plan.

## Collision detected

**Signal:** `CollisionDetected`.

1. Alerts tab and `GET /api/events?...`: the collision event names both objects.
2. Check whether a CDM existed (`GET /api/conjunctions?status=all`) and what the autopilot decided
   (`GET /api/decisions?satellite_id=...`). That shows whether the encounter was missed by
   screening, planned but rejected, or proposed but not approved.
3. Keep a backup of this state before changing anything (below).

## Data feed stale or corrupt

**Signal:** `DataFeedStale` or `DataFeedDegraded`, and `data_feed` events in the Alerts tab.
`GET /api/feeds` gives the details.

- **CelesTrak `stale`:** no successful refresh within `FEED_CELESTRAK_STALE_S` (6 h), or a median
  element-set age above `FEED_ELEMENT_STALE_DAYS` (3 d). Predictions drift by kilometres per day, so
  treat screening as degraded.
- **CelesTrak `degraded`:** the last download failed or was rejected as corrupt (records failing
  sanity checks, or a truncated response). The cached copy is in use. The issue text says which.
- **NOAA `error` / `stale`:** drag falls back to reference conditions (F10.7 = 150, Kp = 2), so
  decay predictions lose accuracy during storms.

Steps:

1. From the host, test the endpoints: `curl -sI https://celestrak.org`, `curl -sI https://services.swpc.noaa.gov`.
2. Inside the container: `$COMPOSE exec backend python3 -c "import urllib.request; urllib.request.urlopen('https://celestrak.org')"`.
   `CERTIFICATE_VERIFY_FAILED` means the image is missing `ca-certificates` (fixed in the Dockerfile).
   Rebuild an old image.
3. CelesTrak rate-limits aggressive clients. Do not lower the 2 h cache TTL.
4. Force a refresh once the cause is fixed: `POST /api/catalog/refresh`.

## API errors or latency

**Signal:** `HighErrorRate` or `SlowAPI`.

1. Grafana shows "API requests by status" and "API latency p95 by route", which tells you which route.
2. Snapshot routes scale with object count. The stream (`/api/stream/...`) is excluded from the
   latency alert.
3. 503s on writes come from non-leader replicas (expected). See [No leader](#no-leader--leader-stuck).

---

## Backup and restore

Backups capture the Redis snapshot (all in-flight mission state), the SQLite mission archive
(full maneuver and event history, copied with SQLite's online backup API) and the saved runtime
configuration. A checksummed manifest is written alongside them.

```bash
# backup (the backend can keep running)
$COMPOSE exec -T backend python3 scripts/backup.py backup --out /app/data/backups/acm-$(date -u +%Y%m%dT%H%M%SZ)
# check a backup without touching anything
$COMPOSE exec -T backend python3 scripts/backup.py verify --from /app/data/backups/<name>
```

Copy `backend/data/backups/` off the host (object storage, another machine). A backup on the same
disk is not a backup. `scripts/deploy.sh` takes one automatically before every release.

**Restore** (the backend must be stopped, or its next autosave overwrites the restored snapshot):

```bash
$COMPOSE stop backend
$COMPOSE run --rm --no-deps backend python3 scripts/backup.py restore --from /app/data/backups/<name> --force
$COMPOSE start backend
curl -sk https://localhost/health      # engine_ready: true, the expected satellite count
```

CI's `backup-restore` job runs the full cycle (back up, wipe, restore, reload) against a real
Redis on every push, so the procedure is tested, not just documented.
