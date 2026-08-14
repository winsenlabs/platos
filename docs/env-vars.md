# Environment Variables

Every environment variable Platos reads. Sourced from `.env` for the webapp and `apps/agent/.env` (which falls back to the root `.env`) for the agent. Production deployments should use secret managers; the table shows defaults as they appear in `.env.example`.

> Required variables have no default. They must be set or the service will refuse to boot.
>
> **The two encryption keys have DIFFERENT formats. Read both recipes.**
>
> - **Webapp `ENCRYPTION_KEY`:** exactly **32 ASCII chars**. Generate with `openssl rand -hex 16` (32 hex chars). Do NOT use `openssl rand -hex 32` (64 chars → fails `Buffer.from(val, "utf8").length === 32` in `env.server.ts:71-76` → boot refuses).
> - **Agent `PLATOS_ENCRYPTION_KEY`:** exactly **64 hex chars → 32 bytes**. Generate with `openssl rand -hex 32` (64 hex chars). `keyHex.length === 64` + `Buffer.from(keyHex, "hex")` in `apps/agent/src/auth/secrets.service.ts:31`. Using `openssl rand -hex 16` here falls back to an ephemeral dev key (secrets don't survive restart) and logs a warning.
>
> **Session/magic-link secrets** (`SESSION_SECRET`, `MAGIC_LINK_SECRET`, `PLATOS_SESSION_SECRET`) have no length requirement. Generate with `openssl rand -base64 24 | tr -d '\n'`.

## Core

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `DATABASE_URL` | — | Yes | Postgres connection string. Use `postgresql://user:pass@host:5432/db?schema=public`. Both webapp and agent read this. |
| `DIRECT_URL` | `$DATABASE_URL` | No | Unpooled connection used for Prisma migrations. Set to bypass PgBouncer. |
| `REDIS_URL` | — | Yes | Redis connection string. Both services. ACL-enabled URIs supported. |
| `REDIS_TLS_DISABLED` | `false` | No | Set `true` to disable TLS for Redis (e.g. local Docker). |
| `SESSION_SECRET` | — | Yes | Any non-empty string (recommended: `openssl rand -base64 24`). Signs webapp cookies. Rotating invalidates all sessions. |
| `ENCRYPTION_KEY` | — | Yes | Exactly 32 ASCII chars. `openssl rand -hex 16`. AES-256-GCM key for encrypted webapp columns and Platos-owned operator TOTP seeds. **Do NOT use `-hex 32`** (64 chars → boot-fail). |
| `APP_ORIGIN` | `http://localhost:3030` | No | Public origin of the webapp. Used for magic links, OAuth callbacks, CORS. |
| `LOGIN_ORIGIN` | `$APP_ORIGIN` | No | Override if login page is served from a separate origin. |
| `NODE_ENV` | `development` | No | `development` · `test` · `production`. |

## Platos agent

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `PLATOS_AGENT_PORT` | `3100` | No | Port the NestJS agent service listens on. |
| `PLATOS_AGENT_HOST` | `0.0.0.0` | No | Bind host. |
| `PLATOS_ENCRYPTION_KEY` | — | Yes | Exactly **64 hex chars** (32 bytes decoded). `openssl rand -hex 32`. AES-256-GCM key for encrypted provider credentials (BYOK) and per-tool HMAC secrets. Rotate via key-rotation flow. Different format from `ENCRYPTION_KEY` — see callout at top of page. |
| `PLATOS_SESSION_SECRET` | — | Yes | Any non-empty string (recommended: `openssl rand -base64 24`). Signs WebSocket session tokens handshaken from the webapp. |
| `PLATOS_TEST_MODE` | `false` | No | If `true`, replaces provider calls with deterministic local mocks. Production builds structurally omit token-minting test routes. |
| `PLATOS_DEFAULT_MODEL` | `anthropic:claude-sonnet-4-6` | No | Fallback model when an agent config omits one. |
| `PLATOS_TOOL_GATEWAY_PATH` | `/tools/sync` | No | Path prefix for the external tool-server WebSocket endpoint. |
| `PLATOS_TOOL_HMAC_MAX_SKEW_SECONDS` | `300` | No | Allowable clock skew for `X-Platos-Timestamp` replay protection. |
| `PLATOS_APPROVAL_TIMEOUT_SECONDS` | `300` | No | How long `request_approval` waits before rejecting. |
| `PLATOS_COMPACT_MODEL` | `anthropic:claude-haiku-4-5` | No | Model used to summarize old turns during compaction. |
| `PLATOS_SUBAGENT_MODEL` | `anthropic:claude-haiku-4-5` | No | Model used as the sub-agent tool-caller in `sub-agent` mode. |
| `PLATOS_CACHE_TTL_SECONDS` | `300` | No | Local TTL hint for decrypted credential cache in Redis. |
| `PLATOS_MAX_CONCURRENT_STREAMS` | `200` | No | Per-instance cap on concurrent LLM streams. Backpressure-signal to the gateway. |
| `PLATOS_LOG_LEVEL` | `info` | No | `error` · `warn` · `info` · `debug` · `trace`. |

## Trigger SDK (durable task spawning)

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `TRIGGER_SECRET_KEY` | — | No | Project key (`tr_dev_...` or `tr_prod_...`) used by `@trigger.dev/sdk` to call an external Trigger service. Durable agent dispatch requires this and `TRIGGER_API_URL`; with neither set, turns dispatch direct and BGOs use their existing Redis fallback. |
| `TRIGGER_API_URL` | — | No | Explicit origin of an external Trigger Cloud or separately deployed self-hosted Trigger.dev service. There is intentionally no Cloud, localhost, or Platos-webapp default. Setting only this variable (or only the secret) logs an incomplete-config warning and disables durable dispatch. |
| `TRIGGER_PROJECT_REF` | — | No | `proj_...` project ref, required if `TRIGGER_SECRET_KEY` is set and you have multiple projects. |
| `TRIGGER_INTERNAL_SECRET` | — | No | Shared secret for privileged agent↔webapp calls (run metadata, realtime subscribe). Required if you split agent and webapp across processes/hosts. |
| `TRIGGER_INTERNAL_BASE_URL` | `$TRIGGER_API_URL` | No | Agent-side base URL for privileged calls; can point to an internal DNS name. |

## Provider keys

These are **seed** keys for bootstrap / local dev. Platos does NOT have a separate encrypted provider-credential store. In production, add provider keys via the dashboard's **Side menu → Providers** page (route: `/agent-providers`). Each provider manifest declares `required_env`; clicking **[Link env]** redirects to `/environment-variables/new?key=<KEY>`, where the value is stored in trigger.dev's Environment Variables table, encrypted at rest, and scoped per `(org, project, env)`. See [quickstart.md §4](./quickstart.md#4-link-a-provider-api-key).

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | — | No* | Anthropic API key. At least one provider is required at bootstrap time so `claude-sonnet-4-6` smoke tests pass. |
| `OPENAI_API_KEY` | — | No | OpenAI key. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | — | No | Google AI Studio key (Gemini). |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | No | Path to a GCP service-account JSON for Vertex AI. |
| `VERTEX_PROJECT_ID` | — | No | Vertex AI GCP project ID. |
| `VERTEX_LOCATION` | `us-central1` | No | Vertex AI region. |

## Webapp (Remix)

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `REMIX_APP_PORT` | `3030` | No | Port the webapp listens on. |
| `REMIX_APP_HOST` | `0.0.0.0` | No | Bind host. |
| `FROM_EMAIL` | — | No | Outbound email address for magic links. |
| `REPLY_TO_EMAIL` | `$FROM_EMAIL` | No | Reply-To header. |
| `RESEND_API_KEY` | — | No | Resend API key. If set, used for email delivery. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_SECURE` | — | No | SMTP credentials, used if Resend is not configured. |
| `APP_LOG_LEVEL` | `info` | No | Webapp log level. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | No | OTLP collector URL for traces + metrics. |
| `OTEL_EXPORTER_OTLP_HEADERS` | — | No | Comma-separated `k=v` headers (e.g. auth). |
| `PROMETHEUS_METRICS_ENABLED` | `true` | No | Expose `/metrics` on the webapp. |
| `PROMETHEUS_METRICS_PORT` | — | No | If set, metrics are exposed on a separate port (recommended for prod). |

## Webapp infrastructure + migrations

These are read by the webapp image and set as defaults in `docker-compose.platos.yml`. Override in `.env` for non-default deployments.

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `DATABASE_HOST` | — | No | Host:port for the Postgres instance used by the internal trigger.dev run engine (webapp reads this separately from `DATABASE_URL`). Compose sets `postgres:5432`. |
| `CLICKHOUSE_URL` | — | Yes (webapp) | ClickHouse HTTP URL for run/queue/batch telemetry. Compose form: `http://default:${CLICKHOUSE_PASSWORD}@clickhouse:8123?secure=false`. |
| `CLICKHOUSE_LOG_LEVEL` | `info` | No | Webapp-side log level for the ClickHouse client. |
| `RUN_REPLICATION_ENABLED` | `0` | No | `1` enables the webapp → ClickHouse run-replication worker. Compose sets `1`. |
| `RUN_REPLICATION_CLICKHOUSE_URL` | `$CLICKHOUSE_URL` | No | Separate URL for the replication worker if you want a dedicated ClickHouse role. |
| `RUN_REPLICATION_LOG_LEVEL` | `info` | No | Log level for the replication worker. |
| `SKIP_POSTGRES_MIGRATIONS` | `0` | No | `1` = webapp container does NOT run Prisma migrations at boot. Compose sets `1` — prod images don't ship Prisma CLI, so run `pnpm run db:migrate` from the host. |
| `SKIP_CLICKHOUSE_MIGRATIONS` | `0` | No | `1` = webapp container does NOT run ClickHouse goose migrations at boot. Compose sets `1` — run the one-shot goose container from the host. |
| `WEBAPP_NODE_MAX_OLD_SPACE_SIZE_MB` | `1536` | No | Runtime V8 old-space ceiling in MiB. Startup enforces that it remains at or below 75% of the effective container limit and leaves at least 512 MiB outside old-space. With compose's default `WEBAPP_MEM_LIMIT=2g`, 1536 is the maximum accepted value. |
| `WEBAPP_BUILD_MAX_OLD_SPACE_SIZE_MB` | `1536` | No | Build-only V8 old-space ceiling in MiB. The guarded build also requires another 2048 MiB of currently available memory and refuses to run otherwise. Build production images off-box. |
| `WEBAPP_BUILD_SOURCEMAPS` | `false` | No | Enables Remix production source maps and Sentry upload. Map generation materially increases peak memory; enable only on an off-box builder with additional measured headroom. |

## Webapp — trigger.dev run engine internals

Upstream trigger.dev plumbing that Platos inherits. Required when the webapp boots a worker group or issues managed-worker deploys.

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `MANAGED_WORKER_SECRET` | — (no default) | **Yes** | Shared secret for managed-worker JWT auth between webapp and supervisor/coordinator. Must be at least 16 characters. Generate with `openssl rand -hex 32`. EOBD.52 removed the prior silent `managed-worker-secret-dev` fallback — compose + webapp both fail-fast on missing value. |
| `DEPLOY_REGISTRY_HOST` | `localhost:5000` | No | Docker registry host for worker image deploys (v3). Override to your OCI registry. |
| `V4_DEPLOY_REGISTRY_HOST` | `localhost:5000` | No | Same as above, for the v4 deploy pipeline. |
| `DEPLOY_REGISTRY_NAMESPACE` | `trigger` | No | Namespace (repository prefix) under the registry host. |
| `TRIGGER_BOOTSTRAP_ENABLED` | `0` | No | `1` bootstraps a default worker group on first boot. Compose sets `1`. |
| `TRIGGER_BOOTSTRAP_WORKER_GROUP_NAME` | `bootstrap` | No | Name of the auto-created worker group. |
| `OBJECT_STORE_BASE_URL` | — | No | S3-compatible endpoint for run-artifact storage (build caches, large payloads). Leave blank to disable artifact offload. |
| `OBJECT_STORE_ACCESS_KEY_ID` | — | No | Access key for the artifact store. |
| `OBJECT_STORE_SECRET_ACCESS_KEY` | — | No | Secret key for the artifact store. |

## Platos agent — service wiring

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `PLATOS_CORS_ORIGIN` | `http://localhost:3030` | No | Comma-separated list of browser origins allowed to open the agent's Socket.IO + HTTP endpoints. **Narrow this before exposing the stack externally.** |
| `PLATOS_AGENT_API_URL` | `http://agent:3100` | No | Webapp → agent internal base URL (compose-network DNS). |
| `PLATOS_AGENT_PUBLIC_API_URL` | `$APP_ORIGIN` | No | Public HTTPS URL the browser should call for agent REST endpoints. Set when the agent is proxied at a separate path/subdomain. |
| `PLATOS_AGENT_PUBLIC_WS_URL` | `wss://test.platos.dev` | No | Public wss:// URL the browser should use for the agent Socket.IO endpoint. Override for every non-test-platos deployment. |
| `PLATOS_ADMIN_TOKEN` | — | Yes (agent + webapp) | Shared bearer token for privileged agent ↔ webapp calls (scheduled attachment retention, admin endpoints). Generate with `openssl rand -hex 32`. Rotate on both containers simultaneously. |
| `PLATOS_WEBAPP_ADMIN_URL` | `http://webapp:3000` | No | Agent-side base URL for posting to webapp admin endpoints over the compose network. |

## Platos agent — attachments / MinIO (Theme D)

Platos stores multimodal attachments (images, audio, video, documents) in MinIO or any S3-compatible store. Both the webapp and agent read these.

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `MINIO_ROOT_USER` | `platos-minio-admin` | No | MinIO admin user. Also used by the agent + webapp as `MINIO_ACCESS_KEY`. **Override** before exposing MinIO externally. |
| `MINIO_ROOT_PASSWORD` | `platos-minio-password` | No | MinIO admin password. Also used as `MINIO_SECRET_KEY`. **Override** before exposing MinIO externally. |
| `MINIO_ACCESS_KEY` | `$MINIO_ROOT_USER` | No | Access key the webapp + agent present when signing presigned URLs / reading objects. Defaults to the compose `MINIO_ROOT_USER`. |
| `MINIO_SECRET_KEY` | `$MINIO_ROOT_PASSWORD` | No | Secret key for the same. |
| `MINIO_ENDPOINT` | `http://minio:9000` | No | In-cluster S3 endpoint used by the webapp to sign presigned URLs and by the agent to download attachments. |
| `MINIO_PUBLIC_ENDPOINT` | `http://localhost:9001` | No | Public URL embedded in presigned PUT/GET URLs sent to the browser. The `http://localhost:9001` default is correct ONLY for single-host dev. **Override to a public-reachable URL** (e.g. `https://minio.example.com`) before exposing externally — otherwise the browser will try to POST to the operator's localhost. |
| `MINIO_BUCKET` | `platos-media` | No | Bucket name. The `minio-init` one-shot container creates it on first boot. |
| `MINIO_REGION` | `us-east-1` | No | Region string used for S3 signature v4. Any value works for MinIO; match your real region for AWS S3. |
| `PLATOS_ATTACHMENT_MAX_BYTES` | `104857600` (100 MB) | No | Per-upload size cap enforced by the webapp's presign endpoint. |
| `PLATOS_ATTACHMENT_ORG_QUOTA_BYTES` | `10737418240` (10 GB) | No | Per-org total quota enforced at presign time. |
| `PLATOS_ATTACHMENT_GRACE_DAYS` | `7` | No | Days an uploaded-but-not-attached file is kept before the retention task garbage-collects it. |
| `PLATOS_ATTACHMENT_TTL_DAYS` | `30` | No | Days an attached file is kept after its thread is deleted. Both webapp + agent read this; must match. |

## Observability (both services)

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `OTEL_SERVICE_NAME` | `platos-webapp` / `platos-agent` | No | Service name tag in traces. |
| `OTEL_RESOURCE_ATTRIBUTES` | — | No | Extra resource attrs (`env=prod,region=us-east-1`). |
| `SENTRY_DSN` | — | No | Sentry DSN, if you want crash reporting. |

## Auth (optional SSO/OAuth)

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | — | No | Google OAuth for login. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | — | No | ^ |
| `GITHUB_OAUTH_CLIENT_ID` | — | No | GitHub OAuth for login. |
| `GITHUB_OAUTH_CLIENT_SECRET` | — | No | ^ |
| `MAGIC_LINK_SECRET` | `$SESSION_SECRET` | No | Separate signing key for magic links, if you want to rotate them independently. |
| `WHITELISTED_EMAILS` | — | No | Regex. Only matching emails can sign up. |

## Feature flags

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `PLATOS_FEATURE_COMPACTION` | `true` | No | Turn off conversation compaction globally. |
| `PLATOS_FEATURE_PROFILING` | `true` | No | Turn off per-agent-per-user profiling globally. |
| `PLATOS_FEATURE_TOOL_GATEWAY` | `true` | No | Disable external tool-server WebSocket endpoint. |
| `PLATOS_FEATURE_HITL_APPROVALS` | `true` | No | Disable `request_approval` meta-tool. |

## Minimum viable `.env`

The shortest env file that will boot a working Platos:

```bash
DATABASE_URL=postgresql://platos:platos@localhost:5432/platos
REDIS_URL=redis://localhost:6379
SESSION_SECRET=$(openssl rand -base64 24 | tr -d '\n')
MAGIC_LINK_SECRET=$(openssl rand -base64 24 | tr -d '\n')
ENCRYPTION_KEY=$(openssl rand -hex 16)              # 32 chars for webapp
PLATOS_ENCRYPTION_KEY=$(openssl rand -hex 32)       # 64 hex chars (32 bytes) for agent
PLATOS_SESSION_SECRET=$(openssl rand -base64 24 | tr -d '\n')
ANTHROPIC_API_KEY=sk-ant-...
```

That's it. Everything else has sensible defaults.
