#!/usr/bin/env bash
# Off-box deploy for play.platos.dev (and any compose-based Platos host).
#
# Tier-1 robustness: this NEVER builds on the box. It pulls pre-built images
# from GHCR (published by .github/workflows/build-images.yml) and restarts the
# app services. Building `nest build` / `tsc` on the 4-vCPU reference VPS spiked
# load past 40 and degraded the live service — the same throttle class as the
# May 2026 outage. Pull-only deploys keep the box responsive throughout.
#
# Usage (run ON the protected runner/VPS from the repo root, e.g. /opt/platos):
#   PLATOS_AGENT_IMAGE=ghcr.io/...@sha256:... \
#   PLATOS_WEBAPP_IMAGE=ghcr.io/...@sha256:... \
#   PLATOS_MIGRATIONS_IMAGE=ghcr.io/...@sha256:... \
#   PLATOS_RELEASE_COMMIT_SHA=<40-hex-reviewed-commit> \
#   PLATOS_MIGRATION_COMPATIBILITY_PROVEN=1 \
#   PLATOS_RECOVERY_POINT_ID=... \
#   PLATOS_RECOVERY_RESTORE_TEST_ID=... scripts/deploy-platos.sh
#
# Image refs come from `published-images.json` and must exactly match the
# passing `candidate-images.json` gate artifact. Recovery and compatibility
# attestations are captured before this script is invoked.
# Env:
#   COMPOSE_FILES           override the -f chain if your layout differs
#   DEPLOY_MIN_IDLE_PCT     min real-CPU idle to allow deploy (default: 20)
set -euo pipefail

: "${PLATOS_AGENT_IMAGE:?set the tested Agent digest reference}"
: "${PLATOS_WEBAPP_IMAGE:?set the tested webapp digest reference}"
: "${PLATOS_MIGRATIONS_IMAGE:?set the tested migration digest reference}"
: "${PLATOS_RELEASE_COMMIT_SHA:?set the reviewed 40-character release commit}"
: "${PLATOS_RECOVERY_POINT_ID:?capture the pre-migration database recovery point}"
: "${PLATOS_RECOVERY_RESTORE_TEST_ID:?restore-test the recovery point before migration}"
[[ "$PLATOS_RELEASE_COMMIT_SHA" =~ ^[a-f0-9]{40}$ ]] || {
  echo "ABORT: PLATOS_RELEASE_COMMIT_SHA must be a full lowercase commit SHA" >&2
  exit 1
}
test "${PLATOS_MIGRATION_COMPATIBILITY_PROVEN:-}" = "1" || {
  echo "ABORT: expand/contract compatibility has not been proven for old and candidate images" >&2
  exit 1
}
for image in "$PLATOS_AGENT_IMAGE" "$PLATOS_WEBAPP_IMAGE" "$PLATOS_MIGRATIONS_IMAGE"; do
  [[ "$image" =~ ^ghcr\.io/.+@sha256:[a-f0-9]{64}$ ]] || {
    echo "ABORT: every image must be an immutable GHCR digest reference" >&2
    exit 1
  }
done

COMPOSE_FILES="${COMPOSE_FILES:--f docker-compose.platos.yml -f docker-compose.deploy.yml}"
SERVICES="agent webapp worker"
MIN_IDLE="${DEPLOY_MIN_IDLE_PCT:-20}"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

# Real-CPU headroom over a 1s window, as a percentage of WALL-CLOCK CPU time
# (steal included in the denominator). We gate on this, not load average.
#
# Why: on the Hostinger reference box the host hypervisor applies a fair-use CPU
# cap. When it engages, `top` shows ~95% `st` (steal) and the 1-min load average
# pins near 38 while user CPU is ~2%. Load average is meaningless here — it would
# refuse to ever deploy. What actually matters is "does this VM have real cycles
# to spare." steal time is time the host took away from us, so it counts against
# available headroom: idle% = idle / (idle + busy + steal). On a throttled box
# this collapses toward 0 and we correctly abort; on a healthy box steal≈0 and
# idle reflects true free CPU.
cpu_idle_pct() {
  # /proc/stat cpu line fields: user nice system idle iowait irq softirq steal ...
  local a b
  a=$(awk '/^cpu /{i=$5+$6; t=$2+$3+$4+$5+$6+$7+$8+$9; print i, t}' /proc/stat)
  sleep 1
  b=$(awk '/^cpu /{i=$5+$6; t=$2+$3+$4+$5+$6+$7+$8+$9; print i, t}' /proc/stat)
  awk -v a="$a" -v b="$b" 'BEGIN{
    split(a, x); split(b, y);
    di = y[1] - x[1]; dt = y[2] - x[2];
    if (dt <= 0) { print 100; exit }
    printf "%d\n", di * 100 / dt;
  }'
}

say "Pre-flight: CPU headroom + container health"
IDLE="$(cpu_idle_pct)"
LOAD1="$(cut -d' ' -f1 /proc/loadavg)"
echo "real-CPU idle: ${IDLE}%  (1-min load avg ${LOAD1} — informational; steal inflates it)"
docker compose $COMPOSE_FILES ps --format '{{.Name}}\t{{.Status}}' 2>/dev/null || true

if [ "$IDLE" -lt "$MIN_IDLE" ]; then
  echo
  echo "ABORT: only ${IDLE}% real-CPU idle (< ${MIN_IDLE}%). The box has no spare"
  echo "cycles — likely a host CPU throttle (check 'top' for high 'st'/steal). A"
  echo "recreate now risks tipping it over. Wait for the throttle window to clear,"
  echo "then re-run. Override the threshold with DEPLOY_MIN_IDLE_PCT if you must."
  exit 1
fi

say "Verify the reviewed release checkout; never fast-forward to arbitrary main"
test "$(git rev-parse HEAD)" = "$PLATOS_RELEASE_COMMIT_SHA" || {
  echo "ABORT: checkout HEAD does not match PLATOS_RELEASE_COMMIT_SHA" >&2
  exit 1
}
git diff --quiet && git diff --cached --quiet || {
  echo "ABORT: tracked release files differ from the reviewed commit" >&2
  exit 1
}

say "Pull exact tested application and migration digests"
docker compose $COMPOSE_FILES pull $SERVICES migrations-init clickhouse-migrate
for image in "$PLATOS_AGENT_IMAGE" "$PLATOS_WEBAPP_IMAGE" "$PLATOS_MIGRATIONS_IMAGE"; do
  revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
  test "$revision" = "$PLATOS_RELEASE_COMMIT_SHA" || {
    echo "ABORT: $image was not built from PLATOS_RELEASE_COMMIT_SHA" >&2
    exit 1
  }
done

say "Run exact image-bundled Postgres and ClickHouse migrations"
docker compose $COMPOSE_FILES run --rm migrations-init
docker compose $COMPOSE_FILES run --rm clickhouse-migrate

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
echo "real-CPU idle: $(cpu_idle_pct)%   load: $(cut -d' ' -f1-3 /proc/loadavg)"
docker compose $COMPOSE_FILES ps --format '{{.Name}}\t{{.Status}}'
