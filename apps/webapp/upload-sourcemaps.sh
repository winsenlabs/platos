#!/bin/bash
set -euo pipefail

# Source maps are generated only for explicitly opted-in release builds. They
# are always removed before the runtime image is assembled, even when upload
# is skipped or fails.
map_roots=(./build ./public/build)
cleanup() {
  for root in "${map_roots[@]}"; do
    if [ -d "$root" ]; then
      find "$root" -type f -name '*.map' -delete
    fi
  done
}
trap cleanup EXIT

if [ "${WEBAPP_BUILD_SOURCEMAPS:-false}" != "true" ]; then
  echo "Skipping Sentry source-map upload: WEBAPP_BUILD_SOURCEMAPS is not true"
  exit 0
fi

required=(SENTRY_ORG SENTRY_PROJECT SENTRY_AUTH_TOKEN)
for name in "${required[@]}"; do
  if [ -z "${!name:-}" ]; then
    echo "Skipping Sentry source-map upload: ${name} is not configured"
    exit 0
  fi
done

release="${SENTRY_RELEASE:-${BUILD_GIT_SHA:-}}"
if [ -z "$release" ]; then
  echo "Skipping Sentry source-map upload: neither SENTRY_RELEASE nor BUILD_GIT_SHA is configured"
  exit 0
fi

existing_roots=()
for root in "${map_roots[@]}"; do
  if [ -d "$root" ]; then
    existing_roots+=("$root")
  fi
done

if [ "${#existing_roots[@]}" -eq 0 ]; then
  echo "Skipping Sentry source-map upload: no build output exists"
  exit 0
fi

if ! sentry-cli releases info "$release" >/dev/null 2>&1; then
  sentry-cli releases new "$release"
fi
sentry-cli sourcemaps inject "${existing_roots[@]}"
sentry-cli sourcemaps upload "${existing_roots[@]}" --release "$release" --validate
