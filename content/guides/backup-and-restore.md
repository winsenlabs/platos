---
slug: backup-and-restore
title: Backup and restore Postgres, ClickHouse, MinIO
description: Snapshot Platos's three persistent stores and restore them onto a fresh host.
category: troubleshooting
order: 60
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How do I back up Postgres?"
  - "How do I back up ClickHouse without downtime?"
  - "How do I back up MinIO buckets?"
  - "How do I restore onto a fresh VPS?"
  - "How do I encrypt the backups?"
related:
  - install-self-host
  - fix-encryption-key
source_files_referenced:
  - docker-compose.platos.yml
  - docs/SELF_HOSTING.md
---

# Backup and restore Postgres, ClickHouse, MinIO

Snapshot all three persistent stores. Restore onto a fresh host without losing scope-isolated data.

## The goal

A nightly backup of every Platos data store, restorable to a clean VPS in under an hour, with the encryption keys backed up off-host.

## Steps (backup)

1. **Postgres.**

   ```bash
   docker exec platos-postgres-1 \
     pg_dump -U postgres -F c platos > /backup/platos-$(date +%F).dump
   aws s3 cp /backup/platos-$(date +%F).dump s3://my-backups/postgres/
   ```

   Cron daily at off-peak.

2. **ClickHouse.**

   Use `clickhouse-backup` with the same S3 target. ClickHouse can back up live; no downtime needed.

   ```bash
   docker exec platos-clickhouse-1 clickhouse-backup create
   docker exec platos-clickhouse-1 clickhouse-backup upload latest
   ```

3. **MinIO.**

   ```bash
   mc alias set local http://localhost:9000 $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD
   mc mirror --overwrite local/platos-attachments s3://my-backups/minio/attachments/
   mc mirror --overwrite local/platos-artifacts s3://my-backups/minio/artifacts/
   ```

4. **Encryption keys.**

   `ENCRYPTION_KEY` and `PLATOS_MESSAGE_ENCRYPTION_KEY` are not in the database. Back them up to a separate secrets vault. Without them, encrypted rows are unrecoverable.

## Steps (restore)

1. **Provision a fresh VPS.**

   Same shape as the original; install Docker.

2. **Clone the repo.**

   ```bash
   git clone https://github.com/platos-labs/platos.git /opt/platos
   cd /opt/platos
   cp .env.example .env
   ```

3. **Restore env vars.**

   Pull `ENCRYPTION_KEY`, `PLATOS_MESSAGE_ENCRYPTION_KEY`, `POSTGRES_PASSWORD`, `MINIO_ROOT_*` from your secrets vault into `.env`.

4. **Bring up the dependencies only.**

   ```bash
   docker compose -f docker-compose.platos.yml up -d postgres redis clickhouse minio
   ```

5. **Restore the data.**

   ```bash
   # Postgres
   aws s3 cp s3://my-backups/postgres/latest.dump /tmp/
   docker exec -i platos-postgres-1 pg_restore -U postgres -d platos < /tmp/latest.dump

   # ClickHouse
   docker exec platos-clickhouse-1 clickhouse-backup download latest
   docker exec platos-clickhouse-1 clickhouse-backup restore latest

   # MinIO
   mc mirror s3://my-backups/minio/attachments/ local/platos-attachments
   mc mirror s3://my-backups/minio/artifacts/ local/platos-artifacts
   ```

6. **Bring up the app.**

   ```bash
   docker compose -f docker-compose.platos.yml up -d agent webapp
   ```

## Verify

- Sign in works with the original credentials.
- Existing chats load and decrypt.
- The runs page shows the historical run list.
- The cost dashboard shows pre-restore data.

## Encrypt the backups

S3 server-side encryption (`--sse aws:kms`) is the minimum. For higher assurance, encrypt locally with `age` or `gpg` before upload; the restore reverses.

## Next steps

- [Self-host with docker compose](/guides/install-self-host) covers the install side.
- [Fix an ENCRYPTION_KEY length error](/guides/fix-encryption-key) for the env-var trap.
