# Self-Hosting Platos

Production deployment guide. Covers the recommended stack, a batteries-included Docker Compose, scaling considerations, backup strategy, observability, key rotation, and a security checklist.

If you're just trying it locally, use [quickstart.md](./quickstart.md) instead.

## Recommended stack

| Layer | Recommendation | Notes |
|---|---|---|
| Compute | 2+ instances each of webapp and agent behind a load balancer | Stateless; horizontally scalable |
| Database | **Postgres 16 with pgvector** | Managed (RDS, Neon, Supabase) or self-hosted |
| Cache / pub-sub | **Redis 7** | ElastiCache, Upstash, or self-hosted |
| Object storage | S3-compatible (S3, R2, GCS, MinIO) | For task artifacts, run logs, build caches |
| Reverse proxy | Caddy, NGINX, or Cloud LB | TLS termination, WebSocket upgrade, sticky sessions for agent |
| Secrets | AWS Secrets Manager, Vault, Doppler | Don't bake into images |
| Observability | OTEL collector + Grafana/Tempo/Loki, or Datadog | Traces and metrics from both services |
| Email | Resend, SES, or SMTP | For magic links + notifications |

Minimum node sizing (steady-state for ~100 concurrent agent streams):

- **Webapp**: 2 vCPU / 2 GB RAM × 2 replicas
- **Agent**: 2 vCPU / 4 GB RAM × 2 replicas (agents hold more in memory during streams)
- **Postgres**: 4 vCPU / 8 GB RAM + 50 GB SSD, bump IOPS for high-throughput deployments
- **Redis**: 2 vCPU / 2 GB RAM, AOF persistence on

## Docker Compose (production profile)

`docker-compose.prod.yml`:

Durable Trigger execution is optional and external to Platos. With both
`TRIGGER_API_URL` and `TRIGGER_SECRET_KEY` unset, the agent boots and serves
turns using direct dispatch. To enable durable dispatch, set both values to
Trigger Cloud or to a separately deployed self-hosted Trigger.dev instance:

```yaml
agent:
  environment:
    TRIGGER_API_URL: https://trigger.example.com
    TRIGGER_SECRET_KEY: ${TRIGGER_SECRET_KEY}
```

There is no implicit Cloud, localhost, or `webapp` endpoint. Supplying only one
of the two values logs an incomplete-configuration warning and leaves durable
dispatch disabled.

```yaml
version: "3.9"

services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: platos_control
    volumes:
      - pgdata:/var/lib/postgresql/data
    command:
      ["postgres", "-c", "max_connections=200", "-c", "shared_buffers=2GB"]
    restart: always

  migrations-control:
    image: node:22-alpine
    depends_on:
      postgres:
        condition: service_started
    environment:
      PGPASSWORD: ${POSTGRES_PASSWORD}
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/platos_control?schema=public
      DIRECT_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/platos_control?schema=public
    volumes:
      - ./internal-packages/tenancy-database:/work
    working_dir: /work
    entrypoint:
      - /bin/sh
      - -c
      - |
        set -e
        apk add --no-cache postgresql-client > /dev/null
        until pg_isready -h postgres -U "${POSTGRES_USER}"; do sleep 1; done
        psql -h postgres -U "${POSTGRES_USER}" -d postgres -tAc \
          "SELECT 1 FROM pg_database WHERE datname='platos_control'" \
          | grep -q 1 || psql -h postgres -U "${POSTGRES_USER}" -d postgres \
          -c 'CREATE DATABASE "platos_control"'
        npm install --no-audit --no-fund --silent prisma@6.14.0 @prisma/client@6.14.0
        npx prisma migrate deploy
    restart: "no"

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes", "--appendfsync", "everysec"]
    volumes:
      - redisdata:/data
    restart: always

  webapp:
    image: ghcr.io/platos-dev/platos-webapp:${PLATOS_VERSION:-latest}
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/platos_control
      DIRECT_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/platos_control
      REDIS_URL: redis://redis:6379
      SESSION_SECRET: ${SESSION_SECRET}
      ENCRYPTION_KEY: ${ENCRYPTION_KEY}
      APP_ORIGIN: https://platos.example.com
      FROM_EMAIL: ${FROM_EMAIL}
      RESEND_API_KEY: ${RESEND_API_KEY}
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
      OTEL_SERVICE_NAME: platos-webapp
      PROMETHEUS_METRICS_ENABLED: "true"
    ports: ["3030:3030"]
    depends_on:
      migrations-control:
        condition: service_completed_successfully
      redis:
        condition: service_started
    restart: always
    deploy:
      replicas: 2

  agent:
    image: ghcr.io/platos-dev/platos-agent:${PLATOS_VERSION:-latest}
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/platos_control
      REDIS_URL: redis://redis:6379
      PLATOS_ENCRYPTION_KEY: ${PLATOS_ENCRYPTION_KEY}
      PLATOS_MESSAGE_ENCRYPTION_KEY: ${PLATOS_MESSAGE_ENCRYPTION_KEY}
      SESSION_SECRET: ${SESSION_SECRET}
      PLATOS_MAX_CONCURRENT_STREAMS: "100"
      TRIGGER_INTERNAL_SECRET: ${TRIGGER_INTERNAL_SECRET}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
      OTEL_SERVICE_NAME: platos-agent
    ports: ["3100:3100"]
    depends_on:
      migrations-control:
        condition: service_completed_successfully
      redis:
        condition: service_started
      webapp:
        condition: service_started
    restart: always
    deploy:
      replicas: 2

volumes:
  pgdata:
  redisdata:
```

Env cheat sheet for production:

```bash
# Secrets. Generate every new encryption-domain key independently as 64 hex chars.
SESSION_SECRET=...           # openssl rand -base64 24 | tr -d '\n'
MAGIC_LINK_SECRET=...        # openssl rand -base64 24 | tr -d '\n'
ENCRYPTION_KEY=...           # openssl rand -hex 32
PLATOS_ENCRYPTION_KEY=...    # openssl rand -hex 32, distinct value
PLATOS_MESSAGE_ENCRYPTION_KEY=... # openssl rand -hex 32, distinct value
TRIGGER_INTERNAL_SECRET=...  # any strong random string

# DB
POSTGRES_USER=platos
POSTGRES_PASSWORD=<strong-random>
POSTGRES_DB=platos_control
DATABASE_URL=postgresql://platos:xxx@postgres:5432/platos_control
DIRECT_URL=postgresql://platos:xxx@postgres:5432/platos_control

# Redis
REDIS_URL=redis://redis:6379

# Providers
ANTHROPIC_API_KEY=sk-ant-...

# Email
FROM_EMAIL=noreply@platos.example.com
RESEND_API_KEY=re_...

# Pinned version
PLATOS_VERSION=0.5.2
```

**Never** use `latest` in production; pin to a release tag for reproducible deploys.

The webapp and agent share the canonical `platos_control` database. The
repository `docker-compose.platos.yml` creates it and applies the clean tenancy
migration before either application starts.

## First production boot

This section walks through a clean production deploy on a single Linux host with Docker + Docker Compose v2, Caddy on the host, and Cloudflare-managed DNS. Adapt the same sequence for Kubernetes / managed infra — only the reverse proxy and DNS layers change.

The reference deploy these notes were written from is `https://play.platos.dev` running on a 4 vCPU / 16 GB RAM Hostinger VPS.

### 1. Required environment variables

Compose refuses to boot if any of these are missing or empty. Generate locally with `openssl` — the values shown are length / format requirements, not literal defaults.

| Variable | Format | Generate with |
|---|---|---|
| `SESSION_SECRET` | non-empty | `openssl rand -hex 32` |
| `MAGIC_LINK_SECRET` | non-empty | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | New: **64 hex chars** (32 bytes); existing exact 32-byte UTF-8 is supported | `openssl rand -hex 32` |
| `PLATOS_ENCRYPTION_KEY` | **64 hex chars** (32 bytes) | `openssl rand -hex 32` |
| `PLATOS_MESSAGE_ENCRYPTION_KEY` | **64 hex chars** (32 bytes) | `openssl rand -hex 32` |
| `MANAGED_WORKER_SECRET` | non-empty | `openssl rand -hex 32` |
| `TRIGGER_INTERNAL_SECRET` | non-empty | `openssl rand -hex 32` |
| `POSTGRES_PASSWORD` | non-empty | `openssl rand -hex 16` |
| `CLICKHOUSE_PASSWORD` | non-empty | `openssl rand -hex 16` |
| `MINIO_ROOT_PASSWORD` | non-empty | `openssl rand -hex 16` |

Do not replace an existing 32-byte UTF-8 `ENCRYPTION_KEY` merely to adopt the new hex representation. Its exact bytes are required to decrypt historical rows; migrate ciphertext before any key replacement.

Plus the application config — most have safe defaults but a production deploy must set:

| Variable | Production value |
|---|---|
| `NODE_ENV` | `production` |
| `LOGIN_ORIGIN` | `https://your.host` |
| `APP_ORIGIN` | `https://your.host` |
| `POSTGRES_DB` | `platos_control` |
| `DATABASE_URL` / `DIRECT_URL` (webapp) | canonical `platos_control` connection |
| `DATABASE_URL` (agent) | the same canonical `platos_control` connection |
| `PLATOS_CORS_ORIGIN` | `https://your.host` (comma-separated for multiple) |
| `MINIO_PUBLIC_ENDPOINT` | `https://minio.your.host` (see §3 below — **boot will fail without this**) |
| `ANTHROPIC_API_KEY` (or other provider) | your key |
| `RESEND_API_KEY` | your key (see §5) |
| `FROM_EMAIL` | `noreply@your.verified.domain` (see §5) |
| `REPLY_TO_EMAIL` | a real human inbox |

### 2. Boot sequence

The full stack has a startup ordering that's easy to get wrong. Follow this sequence:

```bash
cd /opt/platos

# 1. Infra services first — Postgres, Redis, ClickHouse, MinIO must be
#    healthy before any app container starts.
docker compose -f docker-compose.platos.yml up -d --no-deps \
  postgres redis clickhouse minio minio-init

# Wait for healthchecks (~15-20s).
docker compose -f docker-compose.platos.yml ps

# 2. Create/migrate the canonical database and ClickHouse schema before app startup.
docker compose -f docker-compose.platos.yml up \
  migrations-init clickhouse-migrate

# 3. Start the canonical dashboard and agent services.
docker compose -f docker-compose.platos.yml up -d webapp agent

# 4. Verify all services healthy.
docker compose -f docker-compose.platos.yml ps
```

If an initializer fails, do not bypass it or repoint `DATABASE_URL`. Resolve the
image/database failure and rerun the same one-shot service.

### 3. MinIO needs a public-reachable endpoint

The webapp's boot guard intentionally refuses to start in production if `APP_ORIGIN` points at a public host but `MINIO_PUBLIC_ENDPOINT` resolves to `localhost`:

```
Error: [Platos boot] Refusing to start in production: APP_ORIGIN=https://play.platos.dev
but MINIO_PUBLIC_ENDPOINT=http://localhost:9001. Browsers hitting the public webapp
will be handed presigned URLs pointing at the operator's localhost.
```

This is correct — presigned URLs for attachments are handed to the visitor's browser, and `localhost:9000` doesn't resolve there. The fix is to expose MinIO on its own subdomain via your reverse proxy.

**Recommended pattern**:

1. Add a DNS A record for `minio.your.host` pointing at your VPS.
2. In your Caddyfile (or NGINX), proxy `minio.your.host` → MinIO API port `:9000` (NOT the console port `:9001`).
3. Set `MINIO_PUBLIC_ENDPOINT=https://minio.your.host` in `.env`.

Caddy snippet:

```caddy
minio.your.host {
    encode zstd gzip
    request_body { max_size 1GB }
    reverse_proxy localhost:9000 {
        transport http {
            read_timeout 5m
            write_timeout 5m
        }
    }
}
```

If you'd rather use external S3 (R2, GCS, AWS S3), set the `OBJECT_STORE_*` env vars instead and remove the `minio` service from your compose.

### 4. The worker token bootstrap

The `worker` service ships embedded inside the agent image (`WORKER_MODE=true`) but needs a `TRIGGER_WORKER_TOKEN` to authenticate against the run engine. The webapp generates this token automatically the first time it boots with `TRIGGER_BOOTSTRAP_ENABLED=1` (the default) — but it doesn't share the token with the worker via volume.

You extract it once and feed it back through `.env`:

```bash
# After the webapp has booted with the full Postgres schema, find the token:
docker logs platos-webapp-1 2>&1 | grep "TRIGGER_WORKER_TOKEN="
# Outputs a line like:
#   TRIGGER_WORKER_TOKEN=tr_wgt_rIGlI3WEGu8Hu3KrKFN88I5nSDqRwjgttWnZ3Uue

# Append it to .env (one-time), then bring the worker up.
echo "TRIGGER_WORKER_TOKEN=tr_wgt_..." >> .env
docker compose -f docker-compose.platos.yml up -d --no-deps --force-recreate worker
```

Once written, the token never needs to rotate unless you wipe the database. If you do wipe and re-bootstrap, replace the value in `.env` and restart the worker.

For multi-host worker scale-out: provision additional worker nodes pointed at the same `TRIGGER_API_URL` with the same `TRIGGER_WORKER_TOKEN`. The token is per-worker-group, not per-host.

### 5. Email — sender domain authentication

Outgoing email (magic-link login, security alerts, agent-side notifications) goes through Resend by default. Resend will silently reject sends from any domain that hasn't been verified in your Resend dashboard.

**Symptom**: magic-link emails never arrive; webapp logs show `[email] resend error { ... statusCode: 403 ... }`.

**Fix**:

1. In your Resend dashboard, add **the same domain you're hosting Platos on** (or a sister domain) and complete the SPF + DKIM DNS records.
2. Set `FROM_EMAIL=noreply@<verified-domain>` in `.env`.
3. Set `REPLY_TO_EMAIL=<a real human inbox>` so users hitting reply still reach a person — this address does NOT need to match the verified domain.
4. Restart the webapp.

If you're running multiple Platos instances under the same parent domain (e.g. `play.platos.dev` and `staging.platos.dev`), one domain verification in Resend covers all of them.

For SES or SMTP fallback, set `RESEND_API_KEY=` empty and supply the `EMAIL_TRANSPORT=ses` (or `smtp`) variables in `.env.example` instead.

### 6. Caddy reverse proxy template

Caddy auto-provisions Let's Encrypt certs as long as it can answer the HTTP-01 challenge on port 80. The catch: if your DNS is fronted by Cloudflare's proxy (orange cloud), Caddy never receives the challenge. **Set the A records to "DNS only" (gray cloud) for the first cert issuance**, then flip to orange cloud + Full (strict) once certs land.

Reference Caddyfile (drop in at `/etc/caddy/Caddyfile` and `systemctl reload caddy`):

```caddy
{
    email you@example.com
}

your.host {
    encode zstd gzip
    request_body { max_size 50MB }

    # Agent-direct paths — REST + WebSocket upgrades.
    @agent {
        path /api/v1/agent/* /tools/sync /tools/sync/* /metrics
    }
    handle @agent {
        reverse_proxy localhost:3100 {
            transport http {
                read_timeout 1h
                write_timeout 1h
            }
        }
    }

    # Socket.IO namespace served by the agent.
    @socketio {
        path /agent/* /agent /socket.io/*
    }
    handle @socketio {
        reverse_proxy localhost:3100 {
            transport http {
                read_timeout 1h
                write_timeout 1h
            }
        }
    }

    # Public docs API + everything else → webapp.
    handle {
        reverse_proxy localhost:3030 {
            transport http {
                read_timeout 5m
                write_timeout 5m
            }
        }
    }
}

mcp.your.host {
    encode zstd gzip
    # Host-aware middleware in the agent rewrites /mcp → /mcp/docs
    # internally based on the Host header, so we just preserve it.
    reverse_proxy localhost:3100 {
        transport http {
            read_timeout 1h
            write_timeout 1h
        }
    }
}

minio.your.host {
    encode zstd gzip
    request_body { max_size 1GB }
    reverse_proxy localhost:9000 {
        transport http {
            read_timeout 5m
            write_timeout 5m
        }
    }
}
```

Open ports `22 / 80 / 443` on the host firewall; nothing else needs public exposure. Postgres, Redis, ClickHouse, and MinIO stay on the docker bridge network.

### 7. First-login walkthrough

1. Browse to `https://your.host` — you'll be redirected to `/login`.
2. Enter your email. The webapp dispatches a magic link via Resend.
3. Click the link in the email; you're now logged in as the first admin user.
4. Create an organization, then a project, then an environment (`development` is created by default).
5. Settings → Providers → link your `ANTHROPIC_API_KEY` from `.env` so model picker shows Claude.
6. Agents → New → ship your first agent.

If the magic-link email never arrives, check §5 (sender domain) and `docker logs platos-webapp-1 | grep email`.

## Scaling considerations

### Webapp (Remix, port 3030)

- Stateless. Scale horizontally behind any HTTP LB.
- Session cookies signed by `SESSION_SECRET` work across replicas.
- Sticky sessions **not** required.

### Agent (NestJS, port 3100)

- Holds WebSocket connections. Use **sticky sessions** on the agent LB (IP hash or cookie-based) so reconnects land on the same pod.
- Cross-pod fan-out uses Redis pub/sub (`platos:agent:events:{threadId}` channel). A user with two tabs connected to different pods still sees synchronized streams.
- Cap `PLATOS_MAX_CONCURRENT_STREAMS` per pod based on RAM. 100 streams at ~8KB/sec buffering is ~800KB — fine for 4GB pods. If you're using heavy tool execution, size up.
- Autoscale on concurrent-stream count (exposed as a Prometheus metric `platos_agent_streams_active`). Target ~70% of the cap per pod.

### Postgres

- Connection pool: tune `DATABASE_URL?connection_limit=20` per process. With 2 webapp × 20 + 2 agent × 20 + trigger workers = ~200 connections. Set `max_connections` accordingly.
- Consider **PgBouncer** in transaction pool mode between app and Postgres once you exceed 4 replicas.
- Use `DIRECT_URL` (unpooled) for Prisma migrations; PgBouncer breaks prepared statements.
- Vacuum + autovacuum on schedule. Trigger's `TaskRun` table is high-churn and benefits from aggressive autovacuum.

### Redis

- For single-region, one primary + one replica is fine.
- For multi-region, avoid replicating pub/sub across regions (latency). Instead, run a Redis per region and let the agent pods use the local one.
- Enable AOF (`appendonly yes`, `appendfsync everysec`) for durability of approvals in flight during a crash.
- Cluster mode is supported but overkill until 10k+ concurrent agents.

### Trigger run engine

- Follows upstream trigger.dev scaling guidance. Same worker / supervisor / coordinator split.
- `apps/supervisor` and `apps/coordinator` in this repo — only relevant if you're running compute workers yourself. If you push everything through the webapp's in-process runner (fine up to ~1000 runs/min), you don't need them.

## Backup strategy

### Postgres

Daily logical dumps, retained 30 days:

```bash
pg_dump --format=custom --no-owner --no-acl "$DATABASE_URL" > platos-$(date +%F).dump
```

Weekly base backup + WAL archive for point-in-time recovery (PITR) on managed Postgres (RDS, Cloud SQL do this natively).

**What's in there:**
- All trigger.dev data (runs, tasks, deployments)
- All Platos data (agents, threads, messages, profiles, tool matrix, connected entities)

**What's encrypted:**
- All provider API keys + skill secrets live in the trigger.dev `SecretStore` / Environment Variables table, encrypted column-by-column with `ENCRYPTION_KEY` (webapp) and surfaced to the agent via the shared `SecretStore` abstraction.
- `PlatosConnectedEntity.serviceSecret` — the single encrypted field Platos owns outside the shared secret store. Encrypted with `PLATOS_ENCRYPTION_KEY` (agent).
- Platform session tokens are signed by one shared `SESSION_SECRET` on webapp and agent.

A dump without the keys is useless. Back up every secret separately into a secret manager, version them, and never commit.

### Redis

- Everything in Redis is either cache (rebuildable) or pending (e.g., in-flight approvals).
- Enable AOF so crashes don't drop in-flight approvals.
- Redis snapshots to S3 nightly are belt-and-suspenders; you won't usually need them.

### Object storage

If you use S3 for build caches / artifacts: enable versioning + lifecycle rules (expire old versions after 90 days).

### ClickHouse (EOBD.65)

ClickHouse holds spans, traces, run replications, and cost analytics — the entire observability surface. A lost ClickHouse instance means you lose every trace and every billable-minute accounting row the webapp + dashboards depend on.

Daily backups with [clickhouse-backup](https://github.com/Altinity/clickhouse-backup):

```bash
docker run --rm \
  --network platos_default \
  -v $(pwd)/.ch-backup:/var/lib/clickhouse-backup \
  -e CLICKHOUSE_HOST=clickhouse \
  -e CLICKHOUSE_USER=$CLICKHOUSE_USER \
  -e CLICKHOUSE_PASSWORD=$CLICKHOUSE_PASSWORD \
  altinity/clickhouse-backup:latest \
  create platos-$(date +%F)

# Ship to remote storage (S3, MinIO, GCS):
docker run --rm \
  --network platos_default \
  -v $(pwd)/.ch-backup:/var/lib/clickhouse-backup \
  -e CLICKHOUSE_HOST=clickhouse \
  -e REMOTE_STORAGE=s3 \
  -e S3_BUCKET=my-platos-backups \
  altinity/clickhouse-backup:latest \
  upload platos-$(date +%F)
```

Retain 30 daily + 12 monthly backups. Restore:

```bash
altinity/clickhouse-backup:latest download platos-2026-04-15
altinity/clickhouse-backup:latest restore platos-2026-04-15
```

### MinIO (EOBD.65)

MinIO is the attachment store — multimodal uploads (images / audio / docs) + user uploads. Lose MinIO and every uploaded conversation attachment is gone.

Daily mirror to a second bucket (can be a different MinIO, AWS S3, Cloudflare R2):

```bash
mc alias set platos-prod http://localhost:9001 $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD
mc alias set platos-backup https://s3.amazonaws.com $AWS_ACCESS_KEY $AWS_SECRET_KEY
mc mirror --overwrite platos-prod/platos-media platos-backup/platos-media-backup
```

Run this from a cron daily. For point-in-time recovery, enable versioning on the backup bucket + set a 90-day lifecycle policy.

Restore:

```bash
mc mirror --overwrite platos-backup/platos-media-backup platos-prod/platos-media
```

### Consistent-cut across all four stores

A "consistent cut" (all four stores backed up at the same logical point in time) matters for forensic replay of an incident. Redis + MinIO are rebuildable from Postgres / ClickHouse, so a drift of a few seconds is fine. Postgres and ClickHouse together are the durable state — take them as close as possible to simultaneously:

```bash
# 1. Pause the webapp + agent so new writes stop briefly.
docker compose -f docker-compose.platos.yml pause webapp agent

# 2. Snapshot Postgres (instant — pg_dump on a paused writer).
pg_dump --format=custom "$DATABASE_URL" > platos-pg-$(date +%F).dump

# 3. Snapshot ClickHouse.
altinity/clickhouse-backup:latest create platos-ch-$(date +%F)

# 4. Snapshot MinIO mirror.
mc mirror --overwrite platos-prod/platos-media platos-backup/platos-media-backup

# 5. Redis AOF is already on disk; `BGSAVE` produces a snapshot.
docker compose -f docker-compose.platos.yml exec redis redis-cli BGSAVE

# 6. Resume.
docker compose -f docker-compose.platos.yml unpause webapp agent
```

Total paused window is typically ~5 seconds. If that's unacceptable: snapshot Postgres + ClickHouse from their managed-storage snapshots at the same wall-clock time — both support point-in-time snapshots on most cloud providers.

### Restore drill (quarterly)

Test the restore path end-to-end every quarter against a fresh staging env:

1. Boot a fresh compose stack pointing at clean volumes.
2. `pg_restore` the latest Postgres dump.
3. `clickhouse-backup restore` the latest ClickHouse backup.
4. `mc mirror` the latest MinIO snapshot back into the fresh stack.
5. Rebuild Redis caches (they self-populate on first read; nothing to restore).
6. Smoke test: log in, open a thread, verify it loads with history + attachments + traces.

Document who ran the drill + when. A backup you haven't restored from is a hope, not a plan.

## Observability

### Tracing (OTEL)

Both services emit OTEL traces. Ship to any OTLP collector:

```
Browser ──HTTP─→ Webapp ──DB─→ Postgres
             └──WS─→ Agent ──LLM─→ Anthropic
                         └──Tool─→ External server
```

Every span in this chain is tied together by `trace_id`. Configure the collector:

```yaml
# otel-collector-config.yaml
receivers:
  otlp: { protocols: { http: {}, grpc: {} } }
exporters:
  otlphttp/tempo: { endpoint: http://tempo:4318 }
  prometheus: { endpoint: 0.0.0.0:9464 }
service:
  pipelines:
    traces: { receivers: [otlp], exporters: [otlphttp/tempo] }
    metrics: { receivers: [otlp], exporters: [prometheus] }
```

### Prometheus metrics

Key metrics to alert on:

| Metric | Meaning | Alert |
|---|---|---|
| `platos_agent_streams_active` | Concurrent LLM streams per pod | > 80% of cap for 5m |
| `platos_agent_stream_latency_ttfb_ms` | Time-to-first-byte from LLM | p99 > 5s for 5m |
| `platos_agent_tool_error_rate` | Tool invocation errors | > 10% for 10m |
| `platos_agent_cache_read_ratio` | Prompt cache hit rate | < 60% for 1h |
| `trigger_run_queue_depth` | Pending runs | > 1000 for 10m |
| `http_requests_total{route,status}` | Standard RED metrics | 5xx > 1% |

Expose metrics on `/metrics`. Lock it behind an IP allowlist or put it on a separate port (`PROMETHEUS_METRICS_PORT`).

### Logs

Agent logs structured JSON to stdout by default. Configurable via `PLATOS_LOG_LEVEL`. Ship to Loki / CloudWatch / Datadog.

Useful live tail during a runtime incident:

```bash
docker compose logs -f agent | jq 'select(.level == "error" or .level == "warn")'
```

### Dashboards

A prebuilt Grafana dashboard (Prometheus datasource) lives at `hosting/grafana-dashboard.json`. Import and point at your Prometheus. Covers streams, cache hit ratio, tool latency, run queue depth, and provider cost by model.

## Key rotation

### `SESSION_SECRET` (webapp cookies)

Rotate: generate new, set as `SESSION_SECRET`, old sessions invalidated. All users forced to re-log. No data loss. Safe to rotate on any cadence.

### `ENCRYPTION_KEY` (webapp column encryption — trigger secrets)

Rows in this domain do not all carry a key version. Back up Postgres, run a maintenance re-encryption pass with the old and new keys, verify reads, then cut every consumer over together. Do not replace the environment value before re-encryption.

### `PLATOS_ENCRYPTION_KEY` (provider credentials, HMAC secrets)

Use the same controlled backup → maintenance re-encryption → verification → coordinated cutover procedure. There is no supported `PLATOS_ENCRYPTION_KEY_NEXT` dual-read input.

### `PLATOS_MESSAGE_ENCRYPTION_KEY`

Message envelopes are versioned. Keep the old key as `PLATOS_MESSAGE_ENCRYPTION_KEY_V<N>`, place the replacement in the unsuffixed input, increment `PLATOS_MESSAGE_ENCRYPTION_KEY_V`, then re-encrypt historical envelopes before removing the old read key. See [Credential inventory](../content/docs/credential-inventory.md).

### `TRIGGER_INTERNAL_SECRET`

Must match between webapp and agent. Rotate simultaneously.

### Per-tool HMAC secrets

Rotate via the mapping UI (**Settings → Tools → [Tool] → [Mapping] → Regenerate**). The new secret is pushed to the tool server on next WebSocket reconnect. During the overlap, the server accepts both old and new for ~2 minutes.

## Security checklist

Before going live:

- [ ] **TLS everywhere.** Terminate at the LB. Redirect HTTP → HTTPS. HSTS.
- [ ] **Lock down the agent WebSocket path.** Don't expose `/tools/sync/` to the public internet unless you have external tool servers. If internal-only, firewall.
- [ ] **CORS.** Set `APP_ORIGIN` to your exact public origin. The webapp uses this to gate CORS.
- [ ] **Cookie flags.** `Secure`, `HttpOnly`, `SameSite=Lax` (defaults). Don't relax these.
- [ ] **Secrets not in env files checked into git.** Use a secret manager.
- [ ] **`/metrics` is not publicly reachable.** IP allowlist or separate port.
- [ ] **Prisma connection uses SSL** (`?sslmode=require`) for managed Postgres.
- [ ] **Redis AUTH enabled** (`REDIS_URL=redis://:password@host:6379`).
- [ ] **Rate limits on login** (built-in, default 10/min per IP — tune via env).
- [ ] **Backups tested.** Restore to a staging env quarterly.
- [ ] **Key rotation runbook** written and stored out-of-band.
- [ ] **OTEL traces include no raw provider keys.** The SDK sanitizers redact `Authorization`, `x-api-key`, etc. Verify your collector isn't logging request bodies.
- [ ] **Audit logs.** Enable the audit-log feature flag for `Settings → Audit Log` to track sensitive admin actions.

## Quarterly maintenance

A short list of host-level chores that prevent slow accumulation from biting you. Calendar these once a quarter; each one is a single command.

### `docker builder prune` — reclaim build-cache disk

Every `docker compose build` (deploys, image rebuilds, dependency bumps) leaves cached layers in `/var/lib/docker/buildkit`. They accumulate forever — on the reference deploy we found 149.7 GB of stale build cache across 566 entries (out of a 193 GB disk) after ~16 days of normal operation. The cache is **never load-bearing at runtime**; pruning is always safe.

```sh
sudo docker system df                # see what's reclaimable
sudo docker builder prune -af        # reclaim everything
```

This recovers tens to hundreds of GB on a long-lived host. Run before every dependency upgrade — fresh builds are faster anyway when the cache is clean and small.

Also worth checking opportunistically:

```sh
sudo docker image prune -af          # untagged image layers from old image versions
df -h /                              # spot inode pressure ("Use%" climbing above 75%)
```

### ClickHouse system-table sanity (operationally automatic)

Since `docker-compose.platos.yml` ships a `clickhouse-ttl-apply` sidecar that runs on every stack boot, ClickHouse's own observability tables (`system.metric_log`, `system.asynchronous_metric_log`, etc.) cannot grow past 7 days. There's nothing to maintain manually. If you ever bump the ClickHouse major version, re-run the sidecar once after the upgrade in case a new system log table got added that the script doesn't yet know about — the script's `run_alter` helper logs each table it touches.

## Upgrades

- Pin a version (`PLATOS_VERSION=0.5.2`).
- Watch the changelog (`CHANGELOG.md`) and release notes.
- **Schema migrations**: the `migrations-init` one-shot service in
  `docker-compose.platos.yml` runs `prisma migrate deploy` against Postgres
  before `webapp` boots. First-time boot and every upgrade re-run this
  init container. No manual host-side `pnpm run db:migrate` needed.
  **ClickHouse** uses a separate goose-based migration step — see the
  "ClickHouse migrations" section below.
- Do a staging deploy first. Smoke test: log in, create agent, chat, trigger a task.
- Roll forward. No blue/green needed unless a major version bump calls it out.

### ClickHouse migrations

The agent's run/queue/batch telemetry lives in ClickHouse. ClickHouse DDL
isn't managed by Prisma, so the webapp compose flag
`SKIP_CLICKHOUSE_MIGRATIONS=1` is permanent. Apply migrations with a
one-shot goose container:

```bash
# from repo root — first-time boot OR after upgrading Platos
docker run --rm \
  --network platos_default \
  -v "$(pwd)/internal-packages/clickhouse/schema:/migrations:ro" \
  -e CLICKHOUSE_URL="http://${CLICKHOUSE_USER:-default}:${CLICKHOUSE_PASSWORD}@clickhouse:8123" \
  ghcr.io/pressly/goose:3 \
  -dir /migrations clickhouse "$CLICKHOUSE_URL" up
```

If your compose network name isn't `platos_default`, grep the output of
`docker network ls` for the name with `platos` in it.

For fresh installs we ship this as a recommended pre-launch step; a future
iteration will fold it into a `clickhouse-migrate` compose service alongside
the Prisma `migrations-init`.

## Disaster recovery

Scenarios and RPO/RTO:

| Scenario | RPO | RTO |
|---|---|---|
| Webapp pod crash | 0 | <30s (auto-restart + LB retry) |
| Agent pod crash | <5s (in-flight streams drop) | <30s (reconnect from UI) |
| Postgres outage | 0 (managed failover) or last backup | 5m managed / hours self-host |
| Redis outage | 0 for durable data; in-flight approvals may re-prompt | <5m |
| AZ outage | 0 (multi-AZ DB) | <5m if running multi-AZ compute |
| Region outage | Last cross-region backup | Manual failover |

Losing Redis is not catastrophic. Losing Postgres is. Back it up like your life depends on it.

## Further reading

- Every env var: [env-vars.md](./env-vars.md)
- Architecture internals: [architecture.md](./architecture.md)
- Upgrading from trigger.dev: [upgrading-from-trigger.md](./upgrading-from-trigger.md)
