# Production Hardening

A pre-flight checklist for taking a `docker compose up` Platos from your laptop to a public-reachable deployment. Every item below is a default that `docker-compose.platos.yml` ships insecure on purpose — the quickstart prioritizes "it boots" over "it's production-safe," and this page closes the gap.

If you're just kicking the tires locally, skip to [quickstart.md](./quickstart.md). If you're about to route real traffic at it, read on.

## 1. Disable `PLATOS_TEST_MODE`

`PLATOS_TEST_MODE=true` selects deterministic providers and a development-only
session fallback. The production build does not register `/test/*`, removes the
compiled test controller directory, and excludes the webapp's development
token-mint route from the Remix route manifest. Keep test mode disabled anyway:

```bash
# .env — production
PLATOS_TEST_MODE=false
```

The dashboard has no shared passcode or environment-variable backdoor. Login is
limited to magic link and configured GitHub/Google OAuth providers.

Compose defaults to `false`; verify your `.env` isn't overriding it.

## 2. Override every default password

`docker-compose.platos.yml` ships with named defaults for speed of first boot. **Every one of them must be overridden before you bind a port to a public interface.**

| Default in compose | `.env` var | Required strength |
|---|---|---|
| `postgres` user/pass `postgres/postgres` | `POSTGRES_USER`, `POSTGRES_PASSWORD` | 32+ random chars. Compose fails-fast if `POSTGRES_PASSWORD` is unset. |
| `clickhouse` user `default`, no password | `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD` | 32+ random chars. Compose fails-fast if `CLICKHOUSE_PASSWORD` is unset. |
| `minio` root `platos-minio-admin` / `platos-minio-password` | `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | 24+ random chars. These also become `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` for presigning. |
| `SESSION_SECRET`, `MAGIC_LINK_SECRET` | — | `openssl rand -base64 24 \| tr -d '\n'`. Compose fails-fast if unset. |
| `ENCRYPTION_KEY` (webapp/operator TOTP) | — | New values: `openssl rand -hex 32`. Existing exact 32-byte UTF-8 values remain supported and must not be replaced without re-encryption. |
| `PLATOS_ENCRYPTION_KEY` (agent, 64 hex chars) | — | `openssl rand -hex 32`. Compose fails-fast if unset. |
| `PLATOS_MESSAGE_ENCRYPTION_KEY` (message/audit content, 64 hex chars) | — | `openssl rand -hex 32`. Must differ from the other encryption keys; missing production configuration fails closed. |
| `PLATOS_INTERNAL_AUTH_TOKEN` empty | `PLATOS_INTERNAL_AUTH_TOKEN` | `openssl rand -hex 32`. Dedicated callback secret; set on every caller and receiver. |

Minimum generation recipe:

```bash
# Run once, paste into .env.
cat <<EOF
POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '\n' | tr '/+' '_-')
CLICKHOUSE_PASSWORD=$(openssl rand -base64 24 | tr -d '\n' | tr '/+' '_-')
MINIO_ROOT_USER=platos-$(openssl rand -hex 4)
MINIO_ROOT_PASSWORD=$(openssl rand -base64 24 | tr -d '\n' | tr '/+' '_-')
SESSION_SECRET=$(openssl rand -base64 24 | tr -d '\n')
MAGIC_LINK_SECRET=$(openssl rand -base64 24 | tr -d '\n')
ENCRYPTION_KEY=$(openssl rand -hex 32)
PLATOS_ENCRYPTION_KEY=$(openssl rand -hex 32)
PLATOS_MESSAGE_ENCRYPTION_KEY=$(openssl rand -hex 32)
PLATOS_INTERNAL_AUTH_TOKEN=$(openssl rand -hex 32)
EOF
```

**Do not commit this file.** Store it in a secret manager (Doppler, 1Password, AWS Secrets Manager, Vault) and inject at container startup.

## 3. Fix `MINIO_PUBLIC_ENDPOINT`

The default is `http://localhost:9001`, which is **only correct for single-host dev**. In any other topology, the browser needs a public-reachable URL because the webapp mints presigned PUT/GET URLs against it and the browser uploads directly to MinIO.

```bash
# .env
MINIO_PUBLIC_ENDPOINT=https://minio.example.com
```

If you leave the default, uploads will try to POST to whatever `localhost:9001` means on the *visitor's* machine — which is nothing. Failures are silent at the browser layer until someone checks the devtools network tab.

If you're fronting MinIO with TLS at a reverse proxy, make sure `Host` + `X-Forwarded-Proto` pass through correctly so the S3 v4 signature validates.

## 4. Narrow `PLATOS_CORS_ORIGIN`

The agent's Socket.IO + HTTP endpoints allow origins from `PLATOS_CORS_ORIGIN` (comma-separated). The compose default is `http://localhost:3030`, which is dev-only.

```bash
# .env
PLATOS_CORS_ORIGIN=https://platos.example.com
```

For multi-domain setups, list them explicitly:

```bash
PLATOS_CORS_ORIGIN=https://platos.example.com,https://admin.platos.example.com
```

Do **not** use `*` in production. The agent treats each entry as an exact-match origin.

## 5. Rotate `PLATOS_INTERNAL_AUTH_TOKEN`

The internal token authenticates dedicated scheduled and durable callbacks. It does not authorize operator-facing hard erasure; that route requires an organization-bound, admin-tier `plt_mcp_` credential.

Rotation steps:

1. Generate new: `openssl rand -hex 32`.
2. Set `PLATOS_INTERNAL_AUTH_TOKEN=<new>` in every callback caller.
3. Set `PLATOS_INTERNAL_AUTH_TOKEN=<new>` in the agent and any webapp callback receiver.
4. Restart both (zero-downtime if you roll one at a time behind a load balancer — the old token stays valid on the not-yet-rolled container until it restarts).

No data loss on rotation. Scheduled retention tasks will resume on the next tick.

## 6. TLS termination

Compose does not ship a reverse proxy. For production you want:

- TLS on the webapp (port 3030 → 443)
- TLS on the agent's Socket.IO upgrade path (port 3100 → 443, usually same cert via SNI)
- TLS on the MinIO public endpoint (port 9001 → 443)

### Option A — Caddy (simplest)

`Caddyfile`:

```caddyfile
platos.example.com {
  reverse_proxy webapp:3000
}

agent.platos.example.com {
  reverse_proxy agent:3100
}

minio.example.com {
  reverse_proxy minio:9000
}
```

Let's Encrypt handles cert issuance + renewal automatically. Point `APP_ORIGIN=https://platos.example.com`, `PLATOS_AGENT_PUBLIC_WS_URL=wss://agent.platos.example.com`, `MINIO_PUBLIC_ENDPOINT=https://minio.example.com`.

### Option B — external load balancer (ALB, GCLB, Cloudflare)

Terminate TLS at the LB. Pass through `X-Forwarded-Proto: https` and `X-Forwarded-For` — the agent's `ScopeGuard` + Socket.IO handshake both require `X-Forwarded-For` to flip into Mode 2 auth for external requests (SPEC §10.3). A missing XFF header will reject browser sessions as if they were privileged internal calls.

### WebSocket upgrade

Whatever you use, confirm the `/agent` (Socket.IO) and `/tools/sync` paths upgrade WebSocket cleanly. Sticky sessions are recommended on the agent side so reconnects land on the same pod.

## 7. Backups

### Postgres

Daily logical dumps + PITR via WAL archive. Platos stores everything scope-critical in Postgres: agents, threads, messages, tool mappings, provider env var references, encrypted `serviceSecret` rows. A dump is only useful if you also have `PLATOS_ENCRYPTION_KEY` and `ENCRYPTION_KEY` — those keys decrypt the rows.

```bash
# Nightly, retained 30 days
pg_dump --format=custom --no-owner --no-acl "$DATABASE_URL" > platos-$(date +%F).dump
# Point-in-time via WAL archiving on managed Postgres (RDS, Cloud SQL)
```

Restore test: do a staged restore into a sandbox at least quarterly. Do NOT trust untested backups.

### ClickHouse

ClickHouse holds run telemetry. Loss is inconvenient but not catastrophic — new traffic regenerates the useful data within hours.

```bash
# If self-hosting, snapshot volumes nightly
docker run --rm -v platos_platos-clickhouse:/data alpine tar czf - /data > ch-$(date +%F).tar.gz
```

ClickHouse Cloud users: enable the built-in backups feature.

### MinIO / object storage

Attachment objects (images, audio, video, documents) live here. Enable MinIO's [bucket replication](https://min.io/docs/minio/linux/administration/bucket-replication.html) to a second MinIO instance or an S3-compatible target for cross-region durability. Retention policies enforced by the agent (`PLATOS_ATTACHMENT_TTL_DAYS`) reduce the size of the working set but don't remove the need for off-site backups of attached files.

### Redis

Cache + queue state. Enable AOF (`--appendonly yes --appendfsync everysec`) so crashes don't drop in-flight approvals or queue items. Nightly RDB snapshots to S3 are belt-and-suspenders.

## 8. Migration runbook

Prod images don't ship the Prisma CLI, so migrations run from a host with the repo checked out. Compose sets `SKIP_POSTGRES_MIGRATIONS=1` and `SKIP_CLICKHOUSE_MIGRATIONS=1` on the webapp so it doesn't fail boot.

Before every `docker compose up -d --build`:

```bash
# From the repo root, with the production DATABASE_URL / CLICKHOUSE URL in env
pnpm install
pnpm run db:migrate                        # Postgres — Prisma migrate deploy

# ClickHouse migrations run via the one-shot goose container shipped in-repo
docker run --rm --network platos_default \
  -e CLICKHOUSE_URL="http://${CLICKHOUSE_USER}:${CLICKHOUSE_PASSWORD}@clickhouse:8123" \
  -v $(pwd)/internal-packages/clickhouse/schema:/migrations \
  ghcr.io/pressly/goose \
  goose -dir /migrations clickhouse "tcp://clickhouse:9000" up
```

After the migrations land, `docker compose -f docker-compose.platos.yml up -d --build` to roll the new image.

**Rollback:** `pnpm run db:migrate:status` shows the applied vs pending set. If you need to revert, you're doing an out-of-band restore from your Postgres backup — Prisma does not support `prisma migrate reset` on a deployed DB and doing so would drop every table.

## 9. Post-deploy verification

```bash
# HTTP health
curl -fsS https://platos.example.com/healthcheck  && echo webapp OK
curl -fsS https://agent.platos.example.com/health && echo agent  OK

# Magic-link login works end-to-end
# (navigate to the webapp, enter your email, click the link in your inbox)

# Tool gateway handshake works
wscat -c "wss://agent.platos.example.com/tools/sync" \
      -H "Authorization: Bearer <a valid entity serviceSecret>"

# MinIO signed-URL round-trip
# (attach an image in a conversation; verify it uploads + renders)
```

If any of those fail, check container logs:

```bash
docker compose -f docker-compose.platos.yml logs --tail=200 webapp agent
```

Common regressions to watch for after hardening:

- Encryption-domain reuse or malformed key input — all three keys must be independent 64-character hex values generated with `openssl rand -hex 32`.
- `PLATOS_CORS_ORIGIN` set too tightly — any browser origin not in the list gets a silent 401 on Socket.IO connect.
- `MINIO_PUBLIC_ENDPOINT` pointing at the wrong scheme (`http://` when the proxy terminates TLS) — presigned URLs will fail signature validation.
- `X-Forwarded-For` not passed through — the agent's scope guard rejects raw scope headers from what it thinks is an internal call (but isn't).

## See also

- [quickstart.md](./quickstart.md) — local dev, skip most of this.
- [self-hosting.md](./self-hosting.md) — scaling, observability, disaster recovery.
- [env-vars.md](./env-vars.md) — the full env-var reference.
- [entity-connect.md](./entity-connect.md) — SSRF considerations specifically for entity tool dispatch.
