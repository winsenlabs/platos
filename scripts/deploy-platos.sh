#!/usr/bin/env bash
# Off-box deploy for play.platos.dev (and any compose-based Platos host).
#
# Tier-1 robustness: this NEVER builds on the box. It pulls pre-built images
# from GHCR (published by .github/workflows/build-images.yml) and restarts the
# app services. Building `nest build` / `tsc` on the 4-vCPU reference VPS spiked
# load past 40 and degraded the live service — the same throttle class as the
# May 2026 outage. Pull-only deploys keep the box responsive throughout.
#
# Usage (run ON the VPS, from the repo root, e.g. /opt/platos):
#   scripts/deploy-platos.sh                 # deploy :latest
#   scripts/deploy-platos.sh sha-<commit>    # deploy a pinned, immutable tag
#
# Env:
#   PLATOS_IMAGE_NAMESPACE  GHCR owner (default: winsenlabs)
#   COMPOSE_FILES           override the -f chain if your layout differs
set -euo pipefail

TAG="${1:-latest}"
export PLATOS_IMAGE_TAG="$TAG"
export PLATOS_IMAGE_NAMESPACE="${PLATOS_IMAGE_NAMESPACE:-winsenlabs}"

COMPOSE_FILES="${COMPOSE_FILES:--f docker-compose.platos.yml -f docker-compose.deploy.yml}"
SERVICES="agent webapp worker"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

say "Pre-flight: current load + container health"
cat /proc/loadavg
docker compose $COMPOSE_FILES ps --format '{{.Name}}\t{{.Status}}' 2>/dev/null || true

# Refuse to deploy onto an already-saturated box — pulling + recreating under
# load is how a slow box becomes a down box. 8.0 is 2x the 4-vCPU core count.
LOAD1="$(cut -d' ' -f1 /proc/loadavg)"
if awk "BEGIN{exit !($LOAD1 > 8.0)}"; then
  echo "ABORT: 1-min load is $LOAD1 (> 8.0). Box is too busy to deploy safely."
  echo "Wait for it to settle, then re-run. (Pull-only deploy is light, but a"
  echo "recreate still briefly competes; don't stack it on an existing spike.)"
  exit 1
fi

say "Sync code (compose files + migrations only; images come from GHCR)"
git fetch origin main
git checkout main
git pull --ff-only origin main

say "Pull pre-built images: tag=$TAG namespace=$PLATOS_IMAGE_NAMESPACE"
docker compose $COMPOSE_FILES pull $SERVICES

say "Run DB migrations (one-shot, completes before app restart)"
docker compose $COMPOSE_FILES run --rm migrations-init || {
  echo "WARN: migrations-init returned non-zero. Inspect before continuing."
  echo "If migrations already applied, this is expected; re-run up manually."
}

say "Recreate app services from the pulled images"
docker compose $COMPOSE_FILES up -d --no-deps $SERVICES

say "Post-deploy: wait for health"
for svc in agent webapp; do
  cname="$(docker compose $COMPOSE_FILES ps -q "$svc" 2>/dev/null)"
  [ -z "$cname" ] && { echo "  $svc: no container?"; continue; }
  for i in $(seq 1 30); do
    status="$(docker inspect --format '{{.State.Health.Status}}' "$cname" 2>/dev/null || echo unknown)"
    [ "$status" = "healthy" ] && { echo "  $svc: healthy"; break; }
    [ "$i" -eq 30 ] && echo "  $svc: still '$status' after 30 checks — investigate"
    sleep 5
  done
done

say "Done. Final state:"
cat /proc/loadavg
docker compose $COMPOSE_FILES ps --format '{{.Name}}\t{{.Status}}'
