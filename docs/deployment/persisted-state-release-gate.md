# Persisted-state release gate

WIN-235 treats a release as ready only when authenticated product behavior and
persisted read-back agree. A rendered page, a healthy container, or an HTTP 200
from `/login` is not release evidence by itself.

The `persisted-state-completion` PR check covers the clean persistence contract,
dense deterministic fixtures, real Remix service adapters, live Agent
controllers, cross-scope negatives, mutation read-back, measured performance,
and authenticated browser evidence against the same immutable candidate images.
The check remains fail-closed until every evidence family passes.

## Required PR check

Configure the `main` branch ruleset to require:

- **Workflow:** `Build and gate container images`
- **Job/check:** `persisted-state-completion`

The workflow intentionally has no path filter. A required check that is skipped
by path filtering can remain pending or silently omit release evidence. Failures
upload the fixture manifest, assertion result, service status, migration logs,
Agent logs, and Postgres/Redis/ClickHouse/MinIO read-back evidence for 14 days.

## Build and promotion boundary

1. `.github/workflows/build-images.yml` builds each production candidate once
   as an OCI archive and records its manifest digest and archive checksum.
   Pull requests, including forks, have no package-write permission and neither
   authenticate to GHCR nor publish official candidate tags.
2. The `persisted-state-completion` job downloads, verifies, and locally loads
   the exact Agent, webapp, and migration OCI artifacts. Its Remix requests go
   through the production webapp image, not imported checkout route handlers.
3. A merge or successful `main` gate does not authorize publication. An
   operator must separately dispatch `.github/workflows/publish-images.yml`
   with the successful landed-main run ID and approve the `image-publication`
   environment. That workflow re-verifies the source run, archive checksums,
   manifests, revision labels, and passing identities before creating immutable
   `sha-<full-commit>` tags. It does not rebuild or publish `latest`.
4. Require the image-build jobs and persisted-state check for the exact commit
   SHA being promoted. A tag alone is never release evidence because it moves.
5. Record the currently deployed Agent and webapp digests as the rollback pair
   before changing either service. Keep those images available in GHCR.
6. Do not promote a commit whose fixture, browser, performance, or deployment
   evidence is missing or red. `budgets.v1.json` is the enforced versioned
   regression contract; changing application behavior and its budget in one PR
   requires explicit review of the budget change.

Example tested-candidate inspection from an approved runner:

```bash
docker buildx imagetools inspect "ghcr.io/winsenlabs/platos-agent@sha256:<tested-agent-digest>"
docker buildx imagetools inspect "ghcr.io/winsenlabs/platos-webapp@sha256:<tested-webapp-digest>"
```

Save both `candidate-images.json` and the trusted `published-images.json`
artifact. Require their commit and three `sha256:...` identities to match before
touching the target environment.

## Protected `test-platos` environment

A later deployment workflow must target a GitHub Environment named
`test-platos`. Configure it in repository settings before adding deployment
execution:

- allow deployments from `main` only;
- require at least one reviewer who is not the change author;
- enable **Prevent self-review**;
- do not allow administrators to bypass the protection for routine promotion;
- keep staging SSH/VPC credentials, GHCR pull credentials (if images become
  private), authenticated operator-test credentials, and any staging-only
  encryption material in protected environment secrets;
- keep non-secret values such as `https://test.platos.dev`, deployment host
  aliases, compose directory, and health paths in environment variables;
- grant credentials the narrowest target-host and registry scopes possible.

Image publication, Trigger deployment, test deployment, and production
promotion remain distinct approvals. Publication records are inputs to a later
`test-platos` deployment action, not authority to invoke it. Do not execute a
remote deployment until the protected environment and its reviewers are
verified to exist.

## Fail-closed staging procedure

Run these steps from the protected CI/VPC runner, not a laptop.

### 1. Preflight and preserve rollback

- Confirm the source commit equals the candidate build and the promoted tags
  still resolve to the digests in `candidate-images.json`.
- Record PR URL, required-check run URL, image tags, resolved image digests, and
  current rollback digests.
- Confirm target capacity and current service health before making changes.
- Pull the new immutable images without recreating services.
- Classify every Postgres and ClickHouse migration as **expand** or **contract**.
  The release may proceed only when the expanded schema is compatible with both
  the currently running image pair and the candidate image pair. A contract
  migration must be deferred until the old images are retired, the rollback
  window has closed, and telemetry proves no old reader/writer remains.
- Before any migration, capture a named database recovery point: a Postgres
  backup plus WAL/PITR position (or equivalent snapshot) and a ClickHouse
  backup/snapshot/export covering the affected schema and data. Record exact
  restore commands, retention, encryption, and recovery target identifiers.
- Restore those recovery points into isolated recovery targets and run schema
  and representative data checks before continuing. An untested backup is not
  a rollback plan. If a fresh restore test cannot complete, stop promotion.

Image-only rollback is forbidden unless the migration review and compatibility
test prove the old image pair can safely read and write the post-migration
schema. Preserving old image digests does not reverse schema or data changes.

### 2. Run migrations separately

Stop every Agent, webapp, external job callback, and other database writer before
starting the forward-upgrade migration, and keep them stopped until the one-shot
migration exits successfully. This is an accepted release precondition, not
an optional optimization: the ownership derivability preflights intentionally
run before the atomic DDL transaction so Prisma can preserve their deterministic
failure messages. Running the migration beside a writer creates a preflight-to-
mutation race and is unsupported. Compose `depends_on` only orders new
containers; it does not prove an older release has stopped, so the operator
must verify the database writer inventory is quiescent before continuing.

Run the canonical Postgres, Memory profile, and ClickHouse migrations as
one-shot steps before service recreation. Exit immediately on any nonzero
migration result. Do not wrap migration commands in `|| true`, a warning-only
branch, or another fail-open handler.

Use the lockfile-built `platos-migrations@sha256:...` image recorded alongside
the candidate pair. It contains both the canonical Prisma migrations and pinned
Goose plus the ClickHouse schema. Do not install packages or bind-mount migration
files from a checkout at migration runtime.

```bash
set -euo pipefail
docker compose -f docker-compose.platos.yml -f docker-compose.deploy.yml \
  stop agent webapp
test -z "$(docker compose -f docker-compose.platos.yml -f docker-compose.deploy.yml \
  ps --status running --quiet agent webapp)"
test -z "$(docker compose -f docker-compose.platos.yml -f docker-compose.deploy.yml \
  ps --status restarting --quiet agent webapp)"
docker compose -f docker-compose.platos.yml -f docker-compose.deploy.yml \
  run --rm --no-deps migrations-init

dry_run_file="artifacts/deploy/$PLATOS_RELEASE_COMMIT_SHA/memory-profile-dry-run.json"
apply_file="artifacts/deploy/$PLATOS_RELEASE_COMMIT_SHA/memory-profile-apply.json"
verify_file="artifacts/deploy/$PLATOS_RELEASE_COMMIT_SHA/memory-profile-verify.json"
mkdir -p "$(dirname "$dry_run_file")"
docker compose -f docker-compose.platos.yml -f docker-compose.deploy.yml \
  run --rm --no-deps --entrypoint /migrations/entrypoint.sh \
  memory-profile-migrate memory-profile-dry-run | tee "$dry_run_file"
mapfile -t digests < <(sed -n 's/.*"digest":"\([a-f0-9]\{64\}\)".*/\1/p' "$dry_run_file")
test "${#digests[@]}" -eq 1
docker compose -f docker-compose.platos.yml -f docker-compose.deploy.yml \
  run --rm --no-deps --entrypoint /migrations/entrypoint.sh \
  memory-profile-migrate memory-profile-apply --digest "${digests[0]}" | tee "$apply_file"
docker compose -f docker-compose.platos.yml -f docker-compose.deploy.yml \
  run --rm --no-deps --entrypoint /migrations/entrypoint.sh \
  memory-profile-migrate memory-profile-verify | tee "$verify_file"
docker compose -f docker-compose.platos.yml -f docker-compose.deploy.yml \
  run --rm --no-deps clickhouse-migrate
```

Use `scripts/deploy-platos.sh` rather than reproducing this sequence manually;
its EXIT trap keeps both applications stopped after any post-shutdown failure.
Capture every log and the three redacted Memory migration JSON records. The
apply command must receive the one digest extracted from that invocation's
dry-run bytes, and that digest must equal the separately reviewed
`PLATOS_MEMORY_PROFILE_PLAN_SHA256` produced by the pre-deployment inventory.
A migration failure means no deploy and no application restart.
See [Memory profile migration](./memory-profile-migration.md) for stable failure
codes and recovery behavior.

### 3. Deploy immutable digests

Pin the compose override to the recorded Agent, webapp, and migration digests.
Require the deployment checkout HEAD and every image revision label to equal the
reviewed release commit; never fast-forward to arbitrary `main` files. Then
recreate only the application services. Preserve the rollback digest pair.
Never run `docker compose build` on `test.platos.dev`.

After recreation, record:

```bash
docker compose ps
docker inspect --format '{{.Image}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' \
  "$(docker compose ps -q agent)" "$(docker compose ps -q webapp)"
```

Compare each container image ID and RepoDigest to the release evidence. A
healthy container running the wrong image is a failed deployment.

### 4. Verify internal and authenticated product readiness

1. Check the Agent and webapp internal health endpoints from inside the target
   network.
2. Sign in to `https://test.platos.dev` as the protected test operator.
3. Open a dense authenticated route and refresh its deep link.
4. Perform one representative mutation, capture the success status, then load
   the route again and query the canonical database to prove the same row and
   revision persisted.
5. Exercise a permission-negative and confirm its stable status/error code.
6. Review bounded recent logs for both services and migration jobs, covering
   deployment start through verification. Search for crashes, authorization
   failures, migration errors, persistence errors, and repeated retries.

Neither of these is sufficient readiness evidence:

- `GET /login` returns HTTP 200;
- Docker reports `healthy`.

Readiness requires the authenticated flow and persisted read-back above.

### 5. Roll back on any mismatch

If image identity, internal health, authenticated behavior, persisted read-back,
or recent logs fail:

1. stop promotion and stop writes if continued writes could widen recovery loss;
2. if backward compatibility was proven, restore both preserved rollback
   digests and recreate the affected services without rebuilding;
3. if backward compatibility was not proven, **do not perform image-only
   rollback**. Execute the tested Postgres/ClickHouse recovery plan to the
   captured recovery point, verify schema and representative data, then restore
   the preserved image pair;
4. repeat image-ID, internal-health, authenticated-flow, read-back, and log
   checks;
5. attach migration compatibility evidence, recovery-point identifiers, restore
   logs, and failed/rollback verification to the incident or PR.

Do not attempt an ad hoc forward fix on the target host.

## Final release evidence

The release record must link all of the following:

- full commit SHA and PR;
- `persisted-state-completion` CI run and its uploaded artifact;
- production image-build run;
- Agent and webapp immutable tags, resolved digests, and running image IDs;
- preserved rollback digests;
- expand/contract compatibility review and old/new image compatibility results;
- Postgres and ClickHouse recovery-point identifiers, backup retention, and
  successful isolated restore-test evidence;
- Postgres and ClickHouse migration logs;
- redacted Memory profile dry-run, digest-bound apply, and verify records;
- authenticated `test.platos.dev` verification with representative mutation
  and canonical read-back;
- bounded recent Agent and webapp logs;
- browser-suite and performance-budget artifacts once those follow-up gates are
  measured and enforced.

WIN-234 and its child issues cannot be declared complete until every required
WIN-235 gate is present and green.
