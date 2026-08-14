---
slug: install-self-host
title: Self-host with docker compose
description: Stand up the full Platos stack with one compose file. Includes Postgres, Redis, ClickHouse, MinIO, agent, webapp.
category: getting-started
order: 20
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "What does the docker-compose.platos.yml file contain?"
  - "How much RAM/CPU does the stack need?"
  - "How do I run the database migrations?"
  - "How do I expose the webapp behind a reverse proxy?"
  - "How do I generate a valid ENCRYPTION_KEY?"
related:
  - quickstart
  - fix-encryption-key
  - backup-and-restore
source_files_referenced:
  - docker-compose.platos.yml
  - .env.example
  - docs/SELF_HOSTING.md
---

# Self-host with docker compose

A production self-host. One compose file, six services, one TLS terminator in front.

## The goal

A self-hosted Platos at your own domain (e.g. `platos.example.com`), backed by Postgres + Redis + ClickHouse + MinIO, with TLS termination via Caddy and the agent + webapp behind it.

## Steps

1. **Provision the host.**

   Minimum: 4 vCPU, 8 GB RAM, 50 GB disk. Linux with Docker and Docker Compose v2 installed.

2. **Clone and configure.**

   ```bash
   git clone https://github.com/platos-labs/platos.git /opt/platos
   cd /opt/platos
   cp .env.example .env
   ```

   Set required vars:

   ```bash
   ENCRYPTION_KEY=$(openssl rand -hex 32)
   PLATOS_MESSAGE_ENCRYPTION_KEY=$(openssl rand -hex 32)
   POSTGRES_PASSWORD=...        # any strong password
   MINIO_ROOT_USER=platos
   MINIO_ROOT_PASSWORD=...      # any strong password
   PUBLIC_HOST=platos.example.com
   ```

3. **Bring up the stack.**

   ```bash
   docker compose -f docker-compose.platos.yml up -d --build
   ```

   The webapp runs Postgres migrations at boot. ClickHouse migrations land via a one-shot goose container; if you customised the schema, run them manually.

4. **Add Caddy in front.**

   ```caddyfile
   platos.example.com {
     reverse_proxy webapp:3030
   }

   agent.platos.example.com {
     reverse_proxy agent:3100
   }
   ```

   Bind only the agent and webapp ports externally; keep Postgres/Redis/ClickHouse/MinIO private.

5. **Set up backups.**

   Configure a nightly cron for `pg_dump`, `clickhouse-backup`, and `mc mirror` to your S3-compatible storage. See [Backup and restore](/guides/backup-and-restore).

## Verify

- `docker compose ps` shows every service `healthy`.
- `https://platos.example.com` loads the login page over TLS.
- `https://platos.example.com/healthz` returns 200.
- The agent service health: `curl https://agent.platos.example.com/health` returns `{ "ok": true }`.

## Next steps

- [Add a provider key](/guides/add-provider-key) to make the model picker actionable.
- [Quickstart](/guides/quickstart) for the post-install agent flow.
- [Fix an ENCRYPTION_KEY length error](/guides/fix-encryption-key) if boot fails on the env validator.
- [Backup and restore](/guides/backup-and-restore) for the durability story.
