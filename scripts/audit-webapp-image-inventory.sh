#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "${PLATOS_CANDIDATE_SHA:?PLATOS_CANDIDATE_SHA is required}"
: "${WIN235_WEBAPP_IMAGE:?WIN235_WEBAPP_IMAGE is required}"
: "${WIN235_WEBAPP_ARCHIVE_SHA256:?WIN235_WEBAPP_ARCHIVE_SHA256 is required}"
: "${WEBAPP_CANDIDATE_ARCHIVE:?WEBAPP_CANDIDATE_ARCHIVE is required}"
: "${EVIDENCE_DIR:?EVIDENCE_DIR is required}"

git_head="$(git rev-parse HEAD)"
test "$git_head" = "$PLATOS_CANDIDATE_SHA"
inputs_sha256="$(node scripts/verify-webapp-image-inventory.mjs --print-build-inputs-sha256)"
candidate_digest="${WIN235_WEBAPP_IMAGE##*@}"
[[ "$candidate_digest" =~ ^sha256:[a-f0-9]{64}$ ]]
candidate_digest_hex="${candidate_digest#sha256:}"
evidence_dir="$EVIDENCE_DIR/$candidate_digest_hex"
production_image="win253.local/platos-webapp:production-deps-$candidate_digest_hex"
final_image="win253.local/platos-webapp:verified-$candidate_digest_hex"
layout_dir="${RUNNER_TEMP:-/var/tmp}/win253-webapp-candidate-$candidate_digest_hex"
layout_ref="ocidir://${layout_dir}:candidate"
docker_archive="${RUNNER_TEMP:-/var/tmp}/win253-webapp-candidate-$candidate_digest_hex.docker.tar"
mkdir -p "$evidence_dir"

export DOCKER_BUILDKIT=1
docker build \
  --platform linux/amd64 \
  --no-cache \
  --target production-deps \
  --build-arg "BUILD_GIT_SHA=$git_head" \
  --build-arg "WEBAPP_INVENTORY_BUILD_INPUTS_SHA256=$inputs_sha256" \
  --file apps/webapp/Dockerfile.platos \
  --tag "$production_image" \
  .
node scripts/verify-webapp-image-inventory.mjs \
  --image "$production_image" \
  --stage production-deps \
  --evidence "$evidence_dir/production-deps.json" \
  --candidate-archive "$WEBAPP_CANDIDATE_ARCHIVE" \
  --candidate-manifest-digest "$candidate_digest" \
  --candidate-archive-sha256 "$WIN235_WEBAPP_ARCHIVE_SHA256"

rm -rf "$layout_dir"
rm -f "$docker_archive"
printf '%s  %s\n' "$WIN235_WEBAPP_ARCHIVE_SHA256" "$WEBAPP_CANDIDATE_ARCHIVE" \
  | sha256sum --check --strict
regctl image import "$layout_ref" "$WEBAPP_CANDIDATE_ARCHIVE"
test "$(regctl image digest "$layout_ref")" = "$candidate_digest"
test "$(
  regctl image inspect --platform linux/amd64 "$layout_ref" \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
)" = "$git_head"
test "$(
  regctl image inspect --platform linux/amd64 "$layout_ref" \
    --format '{{ index .Config.Labels "dev.winsen.platos.webapp-inventory-inputs-sha256" }}'
)" = "$inputs_sha256"
regctl image export --platform linux/amd64 --name "$final_image" "$layout_ref" "$docker_archive"
docker load --input "$docker_archive"
node scripts/verify-webapp-image-inventory.mjs \
  --image "$final_image" \
  --stage final \
  --evidence "$evidence_dir/final.json" \
  --candidate-archive "$WEBAPP_CANDIDATE_ARCHIVE" \
  --candidate-manifest-digest "$candidate_digest" \
  --candidate-archive-sha256 "$WIN235_WEBAPP_ARCHIVE_SHA256"

production_image_id="$(docker image inspect --format '{{.Id}}' "$production_image")"
final_image_id="$(docker image inspect --format '{{.Id}}' "$final_image")"
test "$production_image_id" != "$final_image_id"

if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'WIN235_WEBAPP_RUNTIME_IMAGE=%s\n' "$final_image" >> "$GITHUB_ENV"
fi
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    printf 'candidate_manifest_digest=%s\n' "$candidate_digest_hex"
    printf 'evidence_directory=%s\n' "$evidence_dir"
  } >> "$GITHUB_OUTPUT"
fi

rm -rf "$layout_dir"
rm -f "$docker_archive"
