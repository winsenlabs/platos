---
slug: fix-encryption-key
title: Fix an ENCRYPTION_KEY length error
description: The webapp refuses to boot because ENCRYPTION_KEY isn't 32 ASCII characters. Fix it.
category: troubleshooting
order: 40
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "Why does the webapp say ENCRYPTION_KEY must be 32 bytes?"
  - "How do I generate a valid 32-character ASCII key?"
  - "I rotated the key and now messages can't be decrypted, what now?"
  - "What is the difference between ENCRYPTION_KEY and PLATOS_MESSAGE_ENCRYPTION_KEY?"
related:
  - install-self-host
  - backup-and-restore
source_files_referenced:
  - apps/webapp/app/env.server.ts
  - apps/agent/src/monitoring/message-crypto.service.ts
---

# Fix an ENCRYPTION_KEY length error

The webapp refuses to boot. The Zod validator says `ENCRYPTION_KEY must be 32 bytes`. Fix it.

## The goal

A boot-clean webapp with a valid `ENCRYPTION_KEY` of exactly 32 ASCII characters.

## The trap

Old comments and tutorials say "32-byte hex" which is 64 ASCII characters. The actual check is `Buffer.from(value, "utf8").length === 32`. A 64-char hex string fails the check.

The right way is `openssl rand -hex 16`: 16 hex bytes equals 32 ASCII characters.

## Steps

1. **Generate the key.**

   ```bash
   openssl rand -hex 16
   ```

   Sample output: `3a8b2f5c1e4d6a7b8c9d0e1f2a3b4c5d` (32 chars).

2. **Set in `.env`.**

   ```bash
   ENCRYPTION_KEY=3a8b2f5c1e4d6a7b8c9d0e1f2a3b4c5d
   ```

3. **Do the same for `PLATOS_MESSAGE_ENCRYPTION_KEY`.**

   ```bash
   echo "PLATOS_MESSAGE_ENCRYPTION_KEY=$(openssl rand -hex 16)" >> .env
   ```

4. **Restart.**

   ```bash
   docker compose -f docker-compose.platos.yml restart webapp agent
   ```

   Boot logs should show no env validator errors.

## Verify

- `docker compose ps` shows webapp and agent `healthy`.
- Sign in works.
- Existing chats decrypt and show their messages.

## Rotation gotcha

If you regenerated `ENCRYPTION_KEY` after data was already written, entity service secrets encrypted with the old key are now unreadable. Every entity row needs its `serviceSecret` re-rotated. There is no automatic recovery.

For `PLATOS_MESSAGE_ENCRYPTION_KEY`: see [Encryption and secrets](/docs/encryption-and-secrets) for the dual-key rotation flow that re-encrypts messages without losing data.

## Two keys

- `ENCRYPTION_KEY`: encrypts entity service secrets and other small admin secrets.
- `PLATOS_MESSAGE_ENCRYPTION_KEY`: encrypts message content and safety events.

Both must be set; both follow the same 32-char rule.

## Next steps

- [Self-host with docker compose](/guides/install-self-host) for the full env list.
- [Backup and restore](/guides/backup-and-restore) so you can recover even if a key is lost.
