#!/usr/bin/env bash
# Rolls the backend to a released image on the deployment host, with a pre-deploy backup,
# a health-gated rollout and automatic rollback.
#
#   scripts/deploy.sh ghcr.io/<owner>/<repo>:v1.4.0
#
# Run from the repository checkout on the host (the directory holding docker-compose.prod.yml
# and .env). CI's `deploy` job calls this over SSH for every v* tag; it works the same by hand.
set -euo pipefail

IMAGE="${1:?usage: scripts/deploy.sh <image:tag>}"
COMPOSE="docker compose -f docker-compose.prod.yml"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-180}"
STATE_FILE=".deployed-image"

log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

set_image_in_env() {
  if grep -q '^BACKEND_IMAGE=' .env 2>/dev/null; then
    sed -i "s|^BACKEND_IMAGE=.*|BACKEND_IMAGE=$1|" .env
  else
    echo "BACKEND_IMAGE=$1" >> .env
  fi
}

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_S))
  while (( SECONDS < deadline )); do
    if $COMPOSE exec -T backend curl -fsS http://localhost:8000/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  return 1
}

PREVIOUS="$(cat "$STATE_FILE" 2>/dev/null || true)"
log "deploying $IMAGE (previous: ${PREVIOUS:-none})"

# 1. Back up mission state while the current version is still running.
if $COMPOSE ps --status running backend 2>/dev/null | grep -q backend; then
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  log "pre-deploy backup -> backend/data/backups/pre-deploy-$STAMP"
  $COMPOSE exec -T backend python3 scripts/backup.py backup --out "/app/data/backups/pre-deploy-$STAMP" \
    || { log "backup failed - aborting before touching the running version"; exit 1; }
fi

# 2. Pull and start the new image.
export BACKEND_IMAGE="$IMAGE"
$COMPOSE pull backend
$COMPOSE up -d --no-build backend redis nginx

# 3. Health gate, with rollback.
if wait_healthy; then
  echo "$IMAGE" > "$STATE_FILE"
  set_image_in_env "$IMAGE"
  log "healthy on $IMAGE"
  docker image prune -f --filter "until=168h" >/dev/null || true
  exit 0
fi

log "health check failed within ${HEALTH_TIMEOUT_S}s"
$COMPOSE logs --tail=100 backend || true
if [[ -n "$PREVIOUS" ]]; then
  log "rolling back to $PREVIOUS"
  export BACKEND_IMAGE="$PREVIOUS"
  $COMPOSE up -d --no-build backend
  if wait_healthy; then
    log "rollback healthy on $PREVIOUS"
  else
    log "ROLLBACK ALSO UNHEALTHY - manual intervention required (docs/RUNBOOKS.md#backend-down)"
  fi
fi
exit 1
