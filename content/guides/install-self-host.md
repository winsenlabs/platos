---
slug: install-self-host
title: Self-host with Docker Compose
description: Stand up the complete Platos Compose profile with production secrets, realistic memory, migrations, and health checks.
category: getting-started
order: 20
questions:
  - "Which services does docker-compose.platos.yml start?"
  - "How much memory does the default profile require?"
  - "Which secrets are required?"
  - "How do I verify the installation?"
related:
  - quickstart
  - fix-encryption-key
  - backup-and-restore
---

# Self-host with Docker Compose

The default profile runs Postgres, Redis, ClickHouse, MinIO, the Agent service, and the webapp, plus migration/init containers and an optional Docs MCP bridge.

## 1. Provision the host

The default container limits total approximately **9.5 GiB** before Docker, build, page-cache, and one-shot migration overhead. Use **12 GiB RAM as the practical floor** and **16 GiB or more for production**. Provision at least 4 vCPU and 50 GB of persistent disk.

This guide does not publish an untested reduced-memory profile. If the host has less than 12 GiB, lower limits only after load-testing your own workload; ClickHouse's 4 GiB default addresses observed merge OOMs.

## 2. Clone and configure

```bash
git clone https://github.com/winsenlabs/platos.git /opt/platos
cd /opt/platos
cp .env.example .env
```

Replace every development sentinel named in [Self-hosting](/docs/self-hosting). Compose requires the database passwords and ten platform secrets at parse or startup time; production also requires non-sentinel MinIO credentials.

## 3. Start the stack

```bash
docker compose -f docker-compose.platos.yml up -d --build
```

The long-running service names are `postgres`, `redis`, `clickhouse`, `minio`, `webapp`, and `agent`. `migrations-init`, `clickhouse-migrate`, `clickhouse-ttl-apply`, and `minio-init` are one-shot services and should exit zero. `docs-mcp-bridge` exits cleanly when its entity secret is unset.

## 4. Put TLS in front

The Compose file publishes webapp port 3030 and binds Agent port 3100 to loopback. A host-level Caddy configuration can proxy those exact bindings:

```caddyfile
platos.example.com {
  reverse_proxy 127.0.0.1:3030
}

agent.platos.example.com {
  reverse_proxy 127.0.0.1:3100
}
```

Set `APP_ORIGIN`, `LOGIN_ORIGIN`, `API_ORIGIN`, `PLATOS_AGENT_PUBLIC_WS_URL`, and the public MinIO endpoint for those external hosts before exposing the stack.

## 5. Create provider credentials

Sign in and create provider credentials on the target Environment's **Providers** page. Process env values are not a scoped provider-link fallback.

## Verify

```bash
docker compose -f docker-compose.platos.yml ps
curl --fail http://127.0.0.1:3030/healthcheck
curl --fail http://127.0.0.1:3100/api/health
```

Verify the six long-running services are healthy and the four init/migration services exited successfully. Then test the public TLS endpoints.

## Next steps

- [Add a provider key](/guides/add-provider-key) to make the model picker actionable.
- [Backup and restore](/guides/backup-and-restore) for Postgres, ClickHouse, and MinIO durability.
- [Fix an ENCRYPTION_KEY length error](/guides/fix-encryption-key) if validation fails.
