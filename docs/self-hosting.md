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

```yaml
version: "3.9"

services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: platos
    volumes:
      - pgdata:/var/lib/postgresql/data
    command:
      ["postgres", "-c", "max_connections=200", "-c", "shared_buffers=2GB"]
    restart: always

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes", "--appendfsync", "everysec"]
    volumes:
      - redisdata:/data
    restart: always

  webapp:
    image: ghcr.io/platos-dev/platos-webapp:${PLATOS_VERSION:-latest}
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/platos
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
    depends_on: [postgres, redis]
    restart: always
    deploy:
      replicas: 2

  agent:
    image: ghcr.io/platos-dev/platos-agent:${PLATOS_VERSION:-latest}
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/platos
      REDIS_URL: redis://redis:6379
      PLATOS_ENCRYPTION_KEY: ${PLATOS_ENCRYPTION_KEY}
      PLATOS_SESSION_SECRET: ${PLATOS_SESSION_SECRET}
      PLATOS_MAX_CONCURRENT_STREAMS: "100"
      TRIGGER_API_URL: http://webapp:3030
      TRIGGER_INTERNAL_SECRET: ${TRIGGER_INTERNAL_SECRET}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
      OTEL_SERVICE_NAME: platos-agent
    ports: ["3100:3100"]
    depends_on: [postgres, redis, webapp]
    restart: always
    deploy:
      replicas: 2

volumes:
  pgdata:
  redisdata:
```

Env cheat sheet for production:

```bash
# Secrets. The two encryption keys have DIFFERENT formats:
# - Webapp ENCRYPTION_KEY: exactly 32 ASCII chars — `openssl rand -hex 16`.
# - Agent PLATOS_ENCRYPTION_KEY: exactly 64 hex chars (32 bytes) — `openssl rand -hex 32`.
# Session secrets can be any non-empty string — `openssl rand -base64 24 | tr -d '\n'`.
SESSION_SECRET=...           # openssl rand -base64 24 | tr -d '\n'
MAGIC_LINK_SECRET=...        # openssl rand -base64 24 | tr -d '\n'
ENCRYPTION_KEY=...           # openssl rand -hex 16    (32 chars)
PLATOS_ENCRYPTION_KEY=...    # openssl rand -hex 32    (64 hex chars = 32 bytes)
PLATOS_SESSION_SECRET=...    # openssl rand -base64 24 | tr -d '\n'
TRIGGER_INTERNAL_SECRET=...  # any strong random string

# DB
POSTGRES_USER=platos
POSTGRES_PASSWORD=<strong-random>
DATABASE_URL=postgresql://platos:xxx@postgres:5432/platos

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
- Session tokens signed by `SESSION_SECRET` (webapp) and `PLATOS_SESSION_SECRET` (agent).

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

Rotate via the upstream trigger.dev key rotation flow (re-encrypts `EncryptedSecretValue` rows). See their docs.

### `PLATOS_ENCRYPTION_KEY` (provider credentials, HMAC secrets)

Rotate in three phases:

1. **Dual-read phase.** Set `PLATOS_ENCRYPTION_KEY_NEXT=<new-key>`. Platos decrypts with current, re-encrypts with next on write. Takes effect immediately.
2. **Re-encrypt phase.** Run `pnpm --filter @platos/agent rotate-keys`. This re-encrypts every row in `OrgProviderCredential` and `OrgToolMapping.hmacSecret` with the new key.
3. **Cutover.** Swap: `PLATOS_ENCRYPTION_KEY=<new>`. Remove `PLATOS_ENCRYPTION_KEY_NEXT`. Restart.

Do **not** rotate while agent service is handling traffic without `PLATOS_ENCRYPTION_KEY_NEXT` — you'll lose access to encrypted secrets.

### `PLATOS_SESSION_SECRET`

Same as `SESSION_SECRET`: invalidates open WebSocket sessions. Users reconnect automatically.

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
