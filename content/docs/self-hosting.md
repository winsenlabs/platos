---
slug: self-hosting
title: Self-hosting
description: Run Platos on your own infra with a single docker compose up. Postgres, Redis, ClickHouse, MinIO, agent, webapp.
category: dx
order: 90
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "What does it take to self-host Platos?"
  - "Which services run in the compose file?"
  - "How do I run database migrations against the deployed Postgres?"
  - "What format do the three encryption keys use?"
  - "How do I back up Postgres, ClickHouse, and MinIO?"
  - "How do I put Caddy or another TLS terminator in front?"
  - "What env vars are required vs optional?"
related:
  - encryption-and-secrets
  - environments
  - providers
source_files_referenced:
  - docker-compose.platos.yml
  - docs/SELF_HOSTING.md
  - .env.example
---

# Self-hosting

Self-host with one `docker compose up`. The compose file ships everything Platos needs to run end-to-end: Postgres for the relational store, Redis for queues and rate limits, ClickHouse for traces and cost rollups, MinIO for attachments and artifacts, plus the agent service and the webapp.

## What it is

`docker-compose.platos.yml` orchestrates six services:

| Service | Image | Purpose |
|---|---|---|
| postgres | postgres:16 | Relational data (agents, threads, memory, audits) |
| redis | redis:7 | Queues, rate limit counters, ephemeral state |
| clickhouse | clickhouse/clickhouse-server | Spans + cost rollups |
| minio | minio/minio | Attachments + artifact binaries |
| agent | platos-agent | NestJS agent runtime, port 3100 |
| webapp | platos-webapp | Remix dashboard, port 3030 |

A single `.env` file feeds the compose. The example file ships every required and optional variable with comments.

Migrations: Postgres uses Prisma migrations; ClickHouse uses goose. The compose's webapp runs Postgres migrations at boot; ClickHouse migrations land via a one-shot goose container or by running `pnpm run db:migrate` from the host.

## Why it matters

A self-hosted deployment is the OSS pitch. You own the data, the infra, the cost curve, the upgrade cadence. The single-compose approach takes a customer from "I want to try it" to "I have a running instance" in under fifteen minutes. The migration paths into Kubernetes (helm chart, K.12) are post-launch; for now, compose plus a TLS terminator gets you to production.

## How to use it

### First-time install

```bash
git clone https://github.com/winsenlabs/platos.git
cd platos
cp .env.example .env
# Edit .env: set ENCRYPTION_KEY, PLATOS_MESSAGE_ENCRYPTION_KEY, MINIO_ROOT_*
docker compose -f docker-compose.platos.yml up -d --build
```

Open `http://localhost:3030` and sign in. See the [Quickstart](/guides/quickstart) for the post-install steps (provider key, first agent).

### Run Postgres migrations from the host

```bash
pnpm run db:migrate
```

Migrations are idempotent; re-running is safe.

### Required env vars

**Boot-required (compose refuses to start without these):**

- `ENCRYPTION_KEY`: new values use 64 hex chars / 32 bytes (`openssl rand -hex 32`); existing exact 32-byte UTF-8 values remain valid and must not be replaced without re-encryption.
- `PLATOS_ENCRYPTION_KEY`: 64 hex chars / 32 bytes (`openssl rand -hex 32`).
- `PLATOS_MESSAGE_ENCRYPTION_KEY`: 64 hex chars / 32 bytes.
- `SESSION_SECRET`: one shared platform/session JWT secret for webapp and agent.
- `MAGIC_LINK_SECRET`: a distinct login-link signing secret.
- `MANAGED_WORKER_SECRET`: 64 hex chars (`openssl rand -hex 32`).
- `TRIGGER_INTERNAL_SECRET`: 64 hex chars.
- `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`: MinIO admin credentials.
- `POSTGRES_PASSWORD`, `CLICKHOUSE_PASSWORD`: db credentials.

**Feature-required (compose boots without these, but the named feature errors at runtime):**

- **At least one LLM provider key** — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY`. Without one, no agent can run a turn; the model picker shows zero options. Per-scope keys via the dashboard Providers UI override these.
- **An embedding provider key** — `VOYAGE_API_KEY` (default, recommended) or `OPENAI_API_KEY` with `PLATOS_EMBEDDING_PROVIDER=openai`. Without one, **every memory write throws** — including the hourly `MemoryExtractionScheduler` cron — so multi-turn conversations never produce long-term memory. The agent log surfaces `VOYAGE_API_KEY not configured` (or the OpenAI equivalent) on every failed extraction; the [Memory](/docs/memory) doc explains the cascade. Voyage's `voyage-large-2` is 1536-dim native, matching the pgvector column with no schema migration. See [Memory § Setup](/docs/memory#setup).

Optional but commonly set:

- `PLATOS_OTEL_CLICKHOUSE_URL`: enables ClickHouse-backed traces. Without it, falls back to Redis sorted-sets.
- `PLATOS_TELEMETRY_DISABLED`: set to `true` to opt out of anonymised usage telemetry.
- `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL`: enables OIDC mode on MCP gateway.
- `E2B_API_KEY`: enables `platos-code-runner` skill.
- `RESEND_API_KEY` + `EMAIL_TRANSPORT=resend` + `FROM_EMAIL`: magic-link email delivery (without this, links print to console).

### Put Caddy in front

```caddyfile
platos.example.com {
  reverse_proxy webapp:3030
}

agent.platos.example.com {
  reverse_proxy agent:3100
}
```

Bind only the agent and webapp ports; Postgres/Redis/ClickHouse/MinIO stay private.

### Backup

- Postgres: `pg_dump` to S3-compatible storage on a cron.
- ClickHouse: `clickhouse-backup` is the canonical tool; configure with the same S3-compatible target.
- MinIO: `mc mirror` to a sibling MinIO or to S3 directly.
- Run all three in the same window so a restore is point-in-time consistent.

See [Backup and restore](/guides/backup-and-restore).

## Common pitfalls

- Do NOT run `pnpm run docker`; that brings up the legacy dev stack and collides with `docker-compose.platos.yml`. The platos compose is the only source of truth.
- Generate new encryption-domain keys independently as 64-hex-character (32-byte) values. Existing 32-byte UTF-8 `ENCRYPTION_KEY` values remain supported; reusing key material is rejected.
- ClickHouse 25.3 broke JSON-column VIEWs; the `tmp_eric_*` views were dropped in Theme R.3. If you import older migrations, re-drop.
- `pnpm-workspace.yaml` includes `docs` which is `.dockerignore`d, so Dockerfiles run `RUN sed -i '/docs/d' pnpm-workspace.yaml` before `pnpm install`. If you fork the build, mirror that pattern.
- A `references/entity-hello-world/` standalone example exists outside the workspace (drift D-010). The quickstart guide tells you to install it with its own `package.json`; do not try to make pnpm pick it up from the root.

## Related

- [Encryption and secrets](/docs/encryption-and-secrets): the env keys this doc references.
- [Environments](/docs/environments): the runtime axis you create after install.
- [Providers](/docs/providers): the BYOK keys you wire after first login.
