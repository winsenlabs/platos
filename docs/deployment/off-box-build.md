# Off-box builds — never compile on the production VPS

## Why

The reference deploy (`play.platos.dev`) is a 4-vCPU / 16 GB Hostinger VPS. The
original deploy flow was:

```bash
# on the VPS
git pull origin main
docker compose -f docker-compose.platos.yml build agent webapp
docker compose -f docker-compose.platos.yml up -d agent webapp
```

That `build` step runs `nest build` / `tsc` for the agent and the full Remix +
Vite bundle for the webapp **on the production box, while it is also serving
traffic**. On 4 vCPUs this spikes the load average past 40, and the host's
fair-use CPU throttle kicks in — the same failure class as the May 2026 outage.
`/login` latency went from sub-second to 30+ seconds during a build. Compiling
on the box you are trying to keep up is the definition of brittle.

## The fix: build on CI, pull on the box

`.github/workflows/build-images.yml` builds the Agent, webapp, and migration
candidates once as OCI archives on GitHub's runners. Pull requests, including
forks, upload those archives as workflow artifacts without GHCR authentication
or `packages: write`. The persisted-state job verifies each archive digest and
commit label, loads it locally, and tests the exact Agent/webapp pair.

Only a trusted `main` or manual `main` run publishes after the gate. It imports
the verified OCI manifests unchanged, validates the full staging set, and then
creates immutable `sha-<commit>` tags. The workflow intentionally publishes no
mutable `latest` tags, avoiding a partially advanced release pointer across the
three repositories.

The VPS never compiles. It only ever **pulls** digest references from the trusted
`published-images.json` artifact after they are matched to the passing
`candidate-images.json` gate artifact. Tags are pointers, not deployment
identity.

### Enforced build headroom

The webapp build is guarded even outside the production deploy path:

- V8 old-space defaults to **1536 MiB** (`WEBAPP_BUILD_MAX_OLD_SPACE_SIZE_MB`).
- The build requires another **2048 MiB** of currently available memory for
  pnpm/Turbo, native allocations, bundlers, and the kernel.
- Dependency builds are serialized. If less than **3584 MiB** is available, the
  build exits before compilation with a message to build off-box.

This means a ~7.9 GB host with only ~3 GB available cannot start the risky
webapp compile. Increasing the heap also increases the required available
memory by the same amount; it does not bypass the guard. Use
`pnpm build:platos:webapp` locally and the image workflow for production.
Production source maps are disabled by default because Remix map generation
has a materially higher peak. Set `WEBAPP_BUILD_SOURCEMAPS=true` only on an
off-box builder with additional measured headroom and complete Sentry config.

At runtime, compose defaults the webapp container to 2 GiB and V8 old-space to
1536 MiB (`WEBAPP_NODE_MAX_OLD_SPACE_SIZE_MB`). The entrypoint reads the
effective cgroup limit and refuses an override above 75% of that limit or one
that leaves less than 512 MiB for native memory and request buffers.

### WIN-132 deferred boundary

This build graph remains intentionally honest about the embedded mode-C
closure. Until WIN-132 lands, the webapp graph still includes
`@internal/run-engine`, `@internal/schedule-engine`, and their dependencies;
the `/engine/v1/*` routes, agent `trigger-worker.ts`, `WORKER_MODE`, and compose
`worker` service also remain. WIN-120 does not claim the repository-wide
no-engine-reference/no-engine-route acceptance criteria. `pnpm
audit:platos-build` asserts that these deferred surfaces still exist so an
unrelated build change cannot partially delete them and leave a broken release.

## Deploying

`docker-compose.deploy.yml` is an override that removes the application and
migration `build:` blocks and requires exact GHCR digest refs. Export the tested
values from `published-images.json` after confirming they exactly match
`candidate-images.json` on the protected runner:

```bash
export PLATOS_AGENT_IMAGE='ghcr.io/winsenlabs/platos-agent@sha256:<tested-agent-digest>'
export PLATOS_WEBAPP_IMAGE='ghcr.io/winsenlabs/platos-webapp@sha256:<tested-webapp-digest>'
export PLATOS_MIGRATIONS_IMAGE='ghcr.io/winsenlabs/platos-migrations@sha256:<tested-migration-digest>'
export PLATOS_RELEASE_COMMIT_SHA='<reviewed-40-character-commit>'
docker compose -f docker-compose.platos.yml -f docker-compose.deploy.yml \
  pull agent webapp worker migrations-init clickhouse-migrate
```

The protected deployment procedure:

1. **Refuses to deploy below the configured real-CPU idle threshold** — never
   stack a recreate on a host without spare cycles.
2. Requires the current checkout to equal `PLATOS_RELEASE_COMMIT_SHA`; it never
   fast-forwards to whatever happens to be on `main`.
3. Pulls the exact digest refs above.
4. Captures and restore-tests the Postgres/ClickHouse recovery point, proves
   expand/contract compatibility, then runs the image-bundled Postgres and
   ClickHouse migrations as separate one-shots.
5. Recreates only the app services (`--no-deps`), leaving Postgres / ClickHouse
   / Redis / MinIO untouched.
6. Waits for `healthy` and prints final load + status.

### One-time VPS setup

GHCR images published by this repo are public, so no login is needed to pull.
If they are ever made private:

```bash
echo "$GITHUB_PAT" | docker login ghcr.io -u <user> --password-stdin
```

### Rolling back

Preserve the previous Agent/webapp digest pair and the pre-migration database
recovery point. Image-only rollback is allowed only when compatibility tests
prove the old images can read and write the migrated schema. In that case,
restore the prior digest variables and recreate without rebuilding:

```bash
export PLATOS_AGENT_IMAGE='ghcr.io/winsenlabs/platos-agent@sha256:<previous-agent-digest>'
export PLATOS_WEBAPP_IMAGE='ghcr.io/winsenlabs/platos-webapp@sha256:<previous-webapp-digest>'
docker compose -f docker-compose.platos.yml -f docker-compose.deploy.yml up -d --no-build agent webapp worker
```

If compatibility was not proven, stop writes and execute the tested database
restore plan before starting the old image pair. Never use old images alone to
attempt to reverse an incompatible schema or data migration. See
`persisted-state-release-gate.md` for the full fail-closed procedure.

## Emergency: a build is crushing the box right now

If someone runs the old `docker compose build` on the VPS and load climbs:

```bash
pkill -f buildx; pkill -f "nest build"; pkill -f tsc
```

The Docker daemon finishes or abandons the build server-side and load drains on
its own within a few minutes. Do **not** open more SSH sessions to "check" — each
one competes for the CPU the box needs to recover. One probe, then wait.
