#!/usr/bin/env bash
# Generates a self-signed TLS cert/key into ./certs for local/staging bring-up of nginx.conf's
# HTTPS server block. Self-signed certs are for local testing only - clients will see a trust
# warning/rejection, and this must never be used for a real deployment. For production, provision
# a real certificate (e.g. certbot/Let's Encrypt, or your org's CA) at the same paths instead.
set -euo pipefail

OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/certs"
mkdir -p "$OUT_DIR"

if [[ -f "$OUT_DIR/fullchain.pem" || -f "$OUT_DIR/privkey.pem" ]]; then
  echo "certs/fullchain.pem or certs/privkey.pem already exists - remove them first if you want to regenerate." >&2
  exit 1
fi

openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
  -keyout "$OUT_DIR/privkey.pem" \
  -out "$OUT_DIR/fullchain.pem" \
  -subj "/CN=localhost"

echo "Self-signed cert written to $OUT_DIR (fullchain.pem, privkey.pem)."
echo "Uncomment the certs volume mount and 443 port in docker-compose.prod.yml, then bring nginx up."
