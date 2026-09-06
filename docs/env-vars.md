# Environment Variables

Every environment variable Platos reads. Sourced from `.env` for the webapp and `apps/agent/.env` (which falls back to the root `.env`) for the agent. Production deployments should use secret managers; the table shows defaults as they appear in `.env.example`.

> Required variables have no default. They must be set or the service will refuse to boot.
>
> New keys use **64 hex chars = 32 bytes** and must be generated independently with `openssl rand -hex 32`; reused key material is rejected. Existing exact 32-byte UTF-8 `ENCRYPTION_KEY` values remain supported and must not be replaced without re-encrypting historical ciphertext.
>
> `SESSION_SECRET` is the single platform/session JWT input shared by webapp and agent. `MAGIC_LINK_SECRET` remains a distinct login-link signer. Generate both with `openssl rand -base64 24 | tr -d '\n'`.

## Core

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `DATABASE_URL` | — | Yes | Canonical clean Postgres connection string shared by the webapp and agent (for example `platos_control`). |
| `DIRECT_URL` | `$DATABASE_URL` | No | Unpooled connection used for migrations against the same canonical database. |
| `REDIS_URL` | — | Yes | Redis connection string. Both services. ACL-enabled URIs supported. |
| `REDIS_TLS_DISABLED` | `false` | No | Set `true` to disable TLS for Redis (e.g. local Docker). |
| `SESSION_SECRET` | — | Yes | Strong random value (minimum 16 chars; recommended: `openssl rand -base64 24`). Signs webapp cookies and platform bridge JWTs; the same value is supplied to the agent. Rotating invalidates all sessions. |
| `ENCRYPTION_KEY` | — | Yes | AES-256-GCM key for encrypted webapp columns and Platos-owned operator TOTP seeds. New values: 64 hex chars / 32 bytes. Existing exact 32-byte UTF-8 values remain valid. |
| `APP_ORIGIN` | `http://localhost:3030` | No | Public origin of the webapp. Used for magic links, OAuth callbacks, CORS. |
| `LOGIN_ORIGIN` | `$APP_ORIGIN` | No | Override if login page is served from a separate origin. |
| `NODE_ENV` | `development` | No | `development` · `test` · `production`. |

## Platos agent

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `PLATOS_AGENT_PORT` | `3100` | No | Port the NestJS agent service listens on. |
| `PLATOS_AGENT_HOST` | `0.0.0.0` | No | Bind host. |
| `PLATOS_ENCRYPTION_KEY` | — | Yes | Exactly 64 hex chars / 32 bytes. AES-256-GCM key for agent integration and secret-store ciphertext. Must differ from the other encryption domains. |
| `PLATOS_MESSAGE_ENCRYPTION_KEY` | — | Prod | Exactly 64 hex chars / 32 bytes. Active write key for message, audit, and PII-bearing content. Missing/invalid production configuration fails closed. |
| `PLATOS_MESSAGE_ENCRYPTION_KEY_V` | `1` | No | Positive integer version recorded on new message ciphertext envelopes. Retain old read keys as `PLATOS_MESSAGE_ENCRYPTION_KEY_V<N>`. |
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

## Provider keys

These are optional bootstrap keys for local development. In production, create an encrypted Environment-owned Credential, then link its reference name on the dashboard **Providers** page. Provider metadata APIs never reveal stored key material, and scoped runtime resolution does not fall back to deployment environment variables.

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
| `PLATOS_INTERNAL_AUTH_TOKEN` | — | Yes (agent + callback callers) | Dedicated internal callback secret sent as `X-Platos-Internal-Auth` and compared in constant time. It does not authorize operator hard erasure. |
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
DATABASE_URL=postgresql://platos:platos@localhost:5432/platos_control
DIRECT_URL=postgresql://platos:platos@localhost:5432/platos_control
REDIS_URL=redis://localhost:6379
SESSION_SECRET=$(openssl rand -base64 24 | tr -d '\n')
MAGIC_LINK_SECRET=$(openssl rand -base64 24 | tr -d '\n')
ENCRYPTION_KEY=$(openssl rand -hex 32)
PLATOS_ENCRYPTION_KEY=$(openssl rand -hex 32)
PLATOS_MESSAGE_ENCRYPTION_KEY=$(openssl rand -hex 32)
PLATOS_MESSAGE_ENCRYPTION_KEY_V=1
PLATOS_INTERNAL_AUTH_TOKEN=$(openssl rand -hex 32)
ANTHROPIC_API_KEY=sk-ant-...
```

The webapp and agent must use the same canonical `platos_control` database.

## V1 core-api (`apps/core-api`)

The V1 deployable reads a **separate, typed** configuration surface. It shares no
variable name with the tables above: those are the legacy webapp and agent
processes' inputs, and the V1 process is a different deployable with a different
contract.

Two properties hold for every row below, and both are gated:

- **Nothing is read at first use.** `apps/core-api/src/config/environment.ts`
  takes one frozen snapshot at startup and every section is a pure function over
  it. A missing or malformed value fails the process with exit code **78**
  (`EX_CONFIG`) before a port is bound, and the diagnostic names every bad
  variable across every section in one run. A `secret` value is never echoed
  back, not even when the complaint is that it is malformed.
- **Sections are DECLARED or ABSENT.** Each group has an **anchor**: set it and
  the group is wired, leave it unset and the group is absent, which is a
  legitimate answer for an install part-way through wiring. Setting a member
  without its anchor is an error (`is set but <ANCHOR> is not, so nothing reads
  it`), because such a value silently configures nothing. Setting an anchor
  without a required member is an error too.

`scripts/arch/env-access.mjs` keeps this table honest from the other side: no
file under `packages/kernel`, `packages/contexts`, `packages/adapters`,
`apps/core-api` or `apps/mcp-stdio` may read the environment except the two
declared readers, and `apps/core-api/src/config/sections.test.ts` reconciles the
rows below against the field tables themselves, so a variable cannot be added to
the code without appearing here.

### Core — the process

Anchored by nothing: `PLATOS_ENVIRONMENT` is required outright, because a process
without one is not a process.

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `PLATOS_ENVIRONMENT` | — | Yes | `development` · `test` · `staging` · `production`. |
| `PLATOS_CORE_API_HOST` | `127.0.0.1` | No | The interface the HTTP listener binds. |
| `PLATOS_CORE_API_PORT` | `3030` | No | TCP port; `0` asks the kernel for a free one. |
| `PLATOS_CORE_API_SHUTDOWN_TIMEOUT_MS` | `10000` | No | How long graceful shutdown waits for in-flight work. |
| `PLATOS_CORE_API_DRAIN_GRACE_MS` | `0` | No | How long to keep serving, readiness-red, before the listener stops accepting. Set to at least one poll interval behind a load balancer that polls `/readyz`. |
| `PLATOS_CORE_API_REQUEST_ID_HEADER` | `x-request-id` | No | Inbound header carrying an upstream correlation identifier. |
| `PLATOS_LOG_LEVEL` | `info` | No | `debug` · `info` · `warn` · `error`. |
| `PLATOS_CORE_API_ADMIN_HEALTH_TOKEN` | — | No | Bearer token gating the detailed readiness body. Minimum 16 characters. Omit to keep detail off entirely: the readiness detail names every unsatisfied binding, which is an inventory of what this install has not wired. |

### Stores

Four independent groups. Each anchor may be set alone.

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `PLATOS_STORE_POSTGRES_URL` | — | anchor | The canonical PostgreSQL database. Scheme must be `postgres:` or `postgresql:`. |
| `PLATOS_STORE_POSTGRES_POOL_MAX` | `10` | No | Pooled connections this process may hold open (1–1000). |
| `PLATOS_STORE_POSTGRES_STATEMENT_TIMEOUT_MS` | `15000` | No | How long one statement may run before the server cancels it. |
| `PLATOS_STORE_POSTGRES_SCHEMA` | `public` | No | The schema the canonical tables live in. |
| `PLATOS_STORE_REDIS_URL` | — | anchor | Redis behind the cache, rate limiter and event bus. Scheme `redis:` or `rediss:`. |
| `PLATOS_STORE_REDIS_KEY_PREFIX` | `platos` | No | Keeps two installs on one instance apart. |
| `PLATOS_STORE_REDIS_TLS` | `false` | No | Exactly `true` or `false`. |
| `PLATOS_STORE_CLICKHOUSE_URL` | — | anchor | The span store endpoint. Scheme `http:` or `https:`. |
| `PLATOS_STORE_CLICKHOUSE_DATABASE` | — | with anchor | The database spans are written into. No default on purpose: the vendor image ships one called `default`, so a typo would write every span somewhere that exists and nobody queries. |
| `PLATOS_STORE_CLICKHOUSE_TIMEOUT_MS` | `5000` | No | How long a span write may take. |
| `PLATOS_STORE_OBJECT_ENDPOINT` | — | anchor | S3-compatible endpoint for attachments and artifacts. |
| `PLATOS_STORE_OBJECT_BUCKET` | — | with anchor | The bucket. |
| `PLATOS_STORE_OBJECT_ACCESS_KEY_ID` | — | with anchor | Access key. |
| `PLATOS_STORE_OBJECT_SECRET_ACCESS_KEY` | — | with anchor | Secret paired with the access key. |
| `PLATOS_STORE_OBJECT_REGION` | `us-east-1` | No | Region the signing algorithm uses. |

### Providers

There is **no provider API key here, and that is the design.** Provider
credentials are per-organisation rows in the `providers` context's canonical
store, sealed under the security section's root key. A process-level variable
holding one would be a tenant-scoped secret at a scope with no tenant: every
organisation on the install would share it, the cost ledger would attribute its
spend to nobody, and revoking it would be a redeploy rather than a row update.

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `PLATOS_PROVIDERS_DEFAULT_MODEL` | — | anchor | Vendor-qualified, `vendor:model` — e.g. `anthropic:claude-haiku-4-5-20251001`. Used when nothing else names a model. |
| `PLATOS_PROVIDERS_REQUEST_TIMEOUT_MS` | `120000` | No | How long one provider call may take. |
| `PLATOS_PROVIDERS_MAX_RETRIES` | `2` | No | `0` disables retrying. |
| `PLATOS_PROVIDERS_EMBEDDING_MODEL` | — | No | Vendor-qualified. Omit to leave embedding unwired. |

### Channels

The inbound channel APP's identity, one per deployable — not the per-workspace
INSTALLATION tokens, which are rows in the `channels` context's store.

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `PLATOS_CHANNELS_SLACK_SIGNING_SECRET` | — | anchor | Verifies every inbound channel request. Minimum 32 characters. Anchoring the group on the signing secret rather than on an outbound token means "the channel is wired" and "the channel can tell a real caller from a forged one" are the same statement. |
| `PLATOS_CHANNELS_SLACK_REQUEST_MAX_AGE_S` | `300` | No | How old a signed request may be before it is refused as a replay. |
| `PLATOS_CHANNELS_EMAIL_SMTP_URL` | — | anchor | Relay for budget notifications. Scheme `smtp:` or `smtps:`. |
| `PLATOS_CHANNELS_EMAIL_FROM` | — | with anchor | Envelope sender. |
| `PLATOS_CHANNELS_WEBHOOK_SIGNING_KEY` | — | anchor | Signs outbound notification bodies. Minimum 32 characters. |
| `PLATOS_CHANNELS_WEBHOOK_TIMEOUT_MS` | `10000` | No | How long one delivery may take. |

### Durable runtime

Named after the port (ADR M0.3 §4 `DurableRuntime`) rather than after the
supplier. Only what it takes to REACH the service: which work runs there is a
`jobs` context decision and lives in rows.

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `PLATOS_DURABLE_RUNTIME_API_URL` | — | anchor | The durable execution service. |
| `PLATOS_DURABLE_RUNTIME_SECRET_KEY` | — | with anchor | How this process authenticates to it. Minimum 16 characters. An endpoint with no key would boot, be refused on every dispatch, and present as "background work silently stopped happening". |
| `PLATOS_DURABLE_RUNTIME_NAMESPACE` | `platos` | No | Keeps two installs on one service apart. |
| `PLATOS_DURABLE_RUNTIME_DISPATCH_TIMEOUT_MS` | `15000` | No | Bounds handing work OVER, not the work — a durable service exists so the work can outlive this process. |

### Security

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `PLATOS_SECURITY_SESSION_SECRET` | — | anchor | Signs operator session cookies. Minimum 32 characters. |
| `PLATOS_SECURITY_SESSION_COOKIE_NAME` | `platos_session` | No | Must satisfy the cookie-name grammar; a space here produces a `Set-Cookie` the client silently discards. |
| `PLATOS_SECURITY_SESSION_TTL_S` | `43200` | No | How long an operator session stays valid. |
| `PLATOS_SECURITY_SESSION_SAME_SITE` | `lax` | No | `strict` · `lax` · `none`. |
| `PLATOS_SECURITY_SESSION_COOKIE_SECURE` | `true` | No | Defaults to `true` deliberately: an install serving the operator surface over plain HTTP must say so out loud. |
| `PLATOS_SECURITY_ENCRYPTION_KEY` | — | anchor | The active credential root, exactly 64 hexadecimal characters. |
| `PLATOS_SECURITY_ENCRYPTION_KEY_VERSION` | — | with anchor | Stamped on every credential sealed under the active root. Rotation without a version is a change you cannot roll back. |

### The shortest environment that boots the V1 process

```bash
PLATOS_ENVIRONMENT=development
```

That is the whole of it, and it is not a simplification. Nothing is wired, so
`/readyz` answers 503 with the exact list of unsatisfied adapter bindings, which
is the honest answer for an install part-way through wiring. Add an anchor and
its required members to wire one store at a time.

### The stdio binary (`apps/mcp-stdio`)

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `PLATOS_MCP_STDIO_RUNTIME_MODULE` | — | Yes | Module the host install provides, exporting a factory that returns a `ToolsContract`. Unset, unloadable, or not exporting the factory: the process refuses to start. See `apps/mcp-stdio/src/runtime.ts` for why this binary cannot compose itself. |
