---
slug: self-hosting
title: Self-hosting
description: Operate the source-defined Docker Compose stack with its exact services, required secrets, resource floor, and optional durable-runtime adapter.
category: dx
order: 90
questions:
  - "Which Compose services run?"
  - "Which environment variables are required?"
  - "How much memory does the default profile need?"
  - "Which secrets configure the external durable-runtime adapter?"
related:
  - encryption-and-secrets
  - environments
  - providers
---

# Self-hosting

`docker-compose.platos.yml` is the installation contract. It runs six long-lived product/data services, four one-shot initialization services, and one optional integration sidecar. One more long-lived service, `core-api`, is opt-in behind the `core-api` Compose profile and starts only when that profile is named.

## Service names

| Compose service | Lifecycle | Purpose |
| --- | --- | --- |
| `postgres` | long-running | Canonical Postgres and pgvector store |
| `redis` | long-running | Ephemeral coordination, rate limits, and local Job state |
| `clickhouse` | long-running | Analytical and observability projections |
| `minio` | long-running | S3-compatible attachment and Artifact bytes |
| `webapp` | long-running | Dashboard on host port 3030 |
| `agent` | long-running | Agent runtime on loopback host port 3100 |
| `core-api` | long-running, opt-in `core-api` profile | V1 composition root on loopback host port 3200; no existing path is routed to it |
| `migrations-init` | one-shot | Postgres Prisma migrations |
| `clickhouse-migrate` | one-shot | ClickHouse Goose migrations |
| `clickhouse-ttl-apply` | one-shot | ClickHouse system-log TTLs |
| `minio-init` | one-shot | Private bucket creation |
| `docs-mcp-bridge` | optional sidecar | Connects the public Docs MCP when its entity secret is set |

The persistent volume names are `platos-postgres`, `platos-redis`, `platos-clickhouse`, and `platos-minio`; they are not service names.

## Resource floor

Default memory limits are:

| Service | Default limit |
| --- | ---: |
| `postgres` | 1 GiB |
| `redis` | 256 MiB |
| `clickhouse` | 4 GiB |
| `minio` | 256 MiB |
| `agent` | 2 GiB |
| `webapp` | 2 GiB |
| `core-api` (opt-in profile, not in the total below) | 1 GiB |

That is approximately **9.5 GiB** before Docker, build, filesystem cache, and migration overhead. Use **12 GiB RAM as the practical minimum** and **16 GiB or more for production**. Platos does not publish a supported reduced-memory profile; lowering limits requires installation-specific load testing. In particular, the 4 GiB ClickHouse limit addresses observed merge OOMs.

## Required Compose variables

Compose requires these variables through `${NAME:?required}`:

- `POSTGRES_PASSWORD`
- `CLICKHOUSE_PASSWORD`
- `SESSION_SECRET`
- `MAGIC_LINK_SECRET`
- `ENCRYPTION_KEY`
- `PLATOS_ENCRYPTION_KEY`
- `PLATOS_MESSAGE_ENCRYPTION_KEY`
- `PLATOS_CREDENTIAL_ROOT_KEY_VERSION`
- `PLATOS_CREDENTIAL_ROOT_KEYS`
- `PLATOS_COMPONENT_AUTH_SECRET`
- `PLATOS_INTERNAL_AUTH_TOKEN`
- `PLATOS_ERASURE_HASH_SALT`
- `MANAGED_WORKER_SECRET`

Production must also replace the default `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD`; the application rejects the development sentinels.

Generate independent key material. Do not reuse a value across encryption, signing, credential-root, erasure, or component-auth domains.

```bash
openssl rand -hex 32
openssl rand -base64 24
```

Use 64 hex characters for `ENCRYPTION_KEY`, `PLATOS_ENCRYPTION_KEY`, `PLATOS_MESSAGE_ENCRYPTION_KEY`, each value inside `PLATOS_CREDENTIAL_ROOT_KEYS`, `PLATOS_COMPONENT_AUTH_SECRET`, `PLATOS_INTERNAL_AUTH_TOKEN`, `PLATOS_ERASURE_HASH_SALT`, and `MANAGED_WORKER_SECRET`. `SESSION_SECRET` and `MAGIC_LINK_SECRET` accept independent high-entropy strings. The credential root map is JSON, for example `{"1":"<64-hex-root>"}`, with `PLATOS_CREDENTIAL_ROOT_KEY_VERSION=1`.

## Provider and embedding credentials

Create provider and embedding credentials in the dashboard for each Environment. Scoped provider, health, and embedding resolution does not fall back to `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, or `VOYAGE_API_KEY` from the Agent process.

`PLATOS_EMBEDDING_PROVIDER` and `PLATOS_EMBEDDING_MODEL` select the embedding configuration, but the corresponding raw key must be an Environment credential linked through the dashboard.

## External durable-runtime vendor boundary

Direct Turns and the local Redis Job path do not require a vendor account. To enable the optional external durable-runtime adapter, set both:

- `TRIGGER_API_URL`: the explicit external or self-hosted vendor API URL.
- `TRIGGER_SECRET_KEY`: that vendor installation's secret key.

`PLATOS_COMPONENT_AUTH_SECRET` is the required Platos-side HMAC boundary for component callbacks and must be set independently. No hosted, localhost, webapp, or ambient provider fallback is inferred when the adapter pair is absent.

## Install and verify

```bash
docker compose -f docker-compose.platos.yml up -d --build
docker compose -f docker-compose.platos.yml ps
curl --fail http://127.0.0.1:3030/healthcheck
curl --fail http://127.0.0.1:3100/api/health
```

Expect the six long-running services to be healthy, the four init/migration services to exit zero, and `docs-mcp-bridge` either to run with a valid entity secret or exit zero when disabled.

To run the opt-in V1 composition root as well:

```bash
docker compose -f docker-compose.platos.yml --profile core-api up -d --build core-api
curl --fail http://127.0.0.1:3200/livez
curl http://127.0.0.1:3200/readyz
```

`/livez` answers 200 whenever the process is running, independent of any store. `/readyz` answers 503 until every declared adapter binding is satisfied, and some bindings are still generated interfaces that no configuration can satisfy, so a 503 there is the expected answer today rather than a failed install. The detailed body is returned only with `Authorization: Bearer $PLATOS_CORE_API_ADMIN_HEALTH_TOKEN`; the variables it reads are listed in `docs/env-vars.md`.

`core-api` requires `PLATOS_ENVIRONMENT` (one of `development`, `test`, `staging`, `production`). Compose does not refuse to parse without it, so installs that never enable the profile are unaffected; the container itself exits 78 before binding a port when it is blank.

What composes depends on the security variables, which `.env.example` leaves unset:

| Set in `.env` | `/readyz` bindings | `composedContexts` |
|---|---|---|
| `PLATOS_ENVIRONMENT` only | 49 of 63 | `tenancy` |
| plus `PLATOS_SECURITY_SESSION_SECRET`, `PLATOS_SECURITY_ENCRYPTION_KEY`, `PLATOS_SECURITY_ENCRYPTION_KEY_VERSION` | 53 of 63 | `identityAccess`, `tenancy`, `secrets`, `providers`, `tools` |
| plus `PLATOS_CHANNELS_SLACK_SIGNING_SECRET` | 55 of 63 | the same five |
| plus `PLATOS_CHANNELS_DISCORD_PUBLIC_KEY` | 57 of 63 | the same five |
| plus `PLATOS_CHANNELS_EMAIL_SMTP_URL`, `PLATOS_CHANNELS_EMAIL_FROM`, `PLATOS_CHANNELS_EMAIL_LOGIN_URL` | 59 of 63 | the same five |

Every row was read back off the built composition root rather than derived: each is a
`/readyz` body from `node apps/core-api/dist/main.js` started with exactly the variables
its row names, plus the two store URLs the Compose profile always passes. The four that
remain unsatisfied at the last row are the bindings on directories that are still
generated interfaces, which no `.env` can reach.

Operator authentication, secrets, providers and tools are therefore not running until the three security variables are set. Generate the session secret and the encryption key with `openssl rand -hex 32`, independently of every other key in `.env`.

`core-api` is reachable at the edge only through its own host block in `deploy/Caddyfile`, and that block removes `Set-Cookie` from every response: the process does not yet trust the proxy for the Secure-cookie decision, so it would otherwise issue the operator session cookie without `Secure` behind TLS. Bearer-token calls work through it; browser sessions do not.

## Network boundary

The Compose file publishes the webapp on `0.0.0.0:3030`, binds Agent port 3100 to `127.0.0.1`, and binds Postgres, Redis, ClickHouse, and MinIO to loopback by default. Put TLS and access controls in front of the webapp and Agent ports; do not expose data-store ports directly.

## Backup

- Postgres: `pg_dump`.
- ClickHouse: `clickhouse-backup` or another tested snapshot process.
- MinIO: `mc mirror` to independent S3-compatible storage.
- Redis contains ephemeral state but still affects in-flight work; document the recovery behavior for your installation.

See [Backup and restore](/guides/backup-and-restore).
