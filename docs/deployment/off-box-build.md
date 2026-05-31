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

`.github/workflows/build-images.yml` builds both images on GitHub's runners on
every push to `main` (and on demand via *workflow_dispatch*), then pushes them
to GHCR:

- `ghcr.io/winsenlabs/platos-agent:latest` + `:sha-<commit>`
- `ghcr.io/winsenlabs/platos-webapp:latest` + `:sha-<commit>`

The VPS never compiles. It only ever **pulls** a finished, immutable image.

## Deploying

`docker-compose.deploy.yml` is an override that swaps the `build:` blocks for
GHCR `image:` refs. Use `scripts/deploy-platos.sh` (run on the VPS, from the
repo root, e.g. `/opt/platos`):

```bash
scripts/deploy-platos.sh              # deploy :latest
scripts/deploy-platos.sh sha-<commit> # deploy a pinned, rollback-friendly tag
```

The script:

1. **Refuses to deploy if 1-min load > 8.0** — never stack a recreate on an
   already-hot box.
2. `git pull`s (for compose files + migrations only — *not* to build).
3. `docker compose ... pull agent webapp worker` — fetches the off-box images.
4. Runs `migrations-init` one-shot.
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

Every build is tagged `sha-<commit>`. To roll back, deploy the previous SHA:

```bash
scripts/deploy-platos.sh sha-<previous-commit>
```

No rebuild, no compile — just pull the older image and recreate. Seconds, not
minutes, and it cannot fail a type-check because it was already built green.

## Emergency: a build is crushing the box right now

If someone runs the old `docker compose build` on the VPS and load climbs:

```bash
pkill -f buildx; pkill -f "nest build"; pkill -f tsc
```

The Docker daemon finishes or abandons the build server-side and load drains on
its own within a few minutes. Do **not** open more SSH sessions to "check" — each
one competes for the CPU the box needs to recover. One probe, then wait.
