---
slug: encryption-and-secrets
title: Encryption and secrets
description: Where keys live, how conversations are encrypted at rest, and the single secret-store invariant.
category: governance
order: 50
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "Where are provider keys and skill secrets stored?"
  - "How are conversations encrypted at rest?"
  - "What is PLATOS_MESSAGE_ENCRYPTION_KEY and how do I generate one?"
  - "How is an entity's service secret protected?"
  - "What happens if I rotate the encryption key?"
  - "Why does ENCRYPTION_KEY have to be 32 ASCII characters?"
  - "How does the fork/edit flow re-encrypt messages?"
related:
  - providers
  - connected-entities
  - safety-and-pii
  - self-hosting
source_files_referenced:
  - apps/agent/src/monitoring/message-crypto.service.ts
  - apps/agent/src/monitoring/message-crypto.test.ts
  - apps/agent/src/auth/secrets.service.ts
  - docs/themes/THEME_H.md
---

# Encryption and secrets

Platos has one secret store and one encryption boundary. Provider keys, skill secrets, and user-tool secrets live in trigger.dev's `Environment Variables` table; entity `serviceSecret` rows live encrypted in `PlatosConnectedEntity`. Conversations and safety events are AES-256 at rest using `PLATOS_MESSAGE_ENCRYPTION_KEY`. That is the whole story; if it does not fit this page, it does not exist.

## What it is

Three boundaries:

1. **Environment variables (trigger.dev table)**: provider keys, skill `required_env`, BGO env. Encrypted at rest by trigger.dev's own crypto. Read at runtime by `ScopedEnvService`. The single source of truth for "secrets the runtime needs to call out".
2. **Entity service secret (Postgres + AES)**: each `PlatosConnectedEntity` carries a `serviceSecret` column encrypted with `ENCRYPTION_KEY`. The plaintext is shown once at create time via Redis GETDEL; subsequent reads decrypt only inside the auth path.
3. **Message + safety event content (Postgres + AES)**: messages and safety events store their content encrypted with `PLATOS_MESSAGE_ENCRYPTION_KEY`. Reads decrypt in `MessageCryptoService`; the database carries ciphertext only.

`SecretsService` is the consolidated reader. It picks the right boundary for the requested key, reads, and returns plaintext. Secrets never log; the audit log carries only `{ key, action, ts }`.

## Why it matters

Compliance failures cluster in two places: secrets-in-logs and conversation-data-at-rest. The single-store invariant fixes the first: there is no per-feature encrypted store to forget; provider keys and skill secrets share the same vault. Encrypted-at-rest conversations fix the second: even with full database access, an operator without the message key cannot read a single user message.

The 32-byte ASCII trap is real and frequently mis-set. The webapp's Zod validator does `Buffer.from(value, "utf8").length === 32`. A "32-byte hex string" is 64 ASCII chars and trips the check. Generate the key with `openssl rand -hex 16` (16 hex bytes = 32 ASCII chars). The error is loud at boot; do not paste random hex.

## How to use it

### Generate keys

```bash
# 32-byte ASCII (the trap-free way):
openssl rand -hex 16            # -> ENCRYPTION_KEY (32 chars)
openssl rand -hex 16            # -> PLATOS_MESSAGE_ENCRYPTION_KEY (32 chars)
```

Add to your `.env`:

```bash
ENCRYPTION_KEY=...
PLATOS_MESSAGE_ENCRYPTION_KEY=...
```

Restart the agent service.

### Add a provider key

See [Providers](/docs/providers). The key is written to trigger.dev's env-var table, encrypted by trigger.dev. The `PlatosProviderKey` row carries the metadata (label, last-used, status), not the secret.

### Rotate the message key

Rotation is a special case. With an old key K1 and a new key K2:

1. Set `PLATOS_MESSAGE_ENCRYPTION_KEY_NEXT=K2` and keep `PLATOS_MESSAGE_ENCRYPTION_KEY=K1`. Reads try K1 then K2; writes use K2.
2. Run the rotation job: `pnpm -F @platos/database run rotate-message-key`. Decrypts each row with K1, re-encrypts with K2.
3. After the job completes, swap: `PLATOS_MESSAGE_ENCRYPTION_KEY=K2`, drop `PLATOS_MESSAGE_ENCRYPTION_KEY_NEXT`. Reads now try K2 first.

The fork and edit-and-rerun flows decrypt-then-re-encrypt transparently; there is no special path needed.

### Read entity service secret

Plaintext is shown once at create-time. The `initial-secret` page reads from Redis with GETDEL so the page refresh does not show it again. Save the secret in your entity backend's env at that point.

### Audit secret access

The audit log records every secret read with `{ user, key, scope, ts, success }`. Plaintext is never logged. Surface the log via [Audit log](/docs/audit-log) or via `GET /agent/v1/monitoring/admin-audit`.

## Common pitfalls

- The 32-byte ASCII check is a Zod validator at boot. A wrong-length key crashes the process; you cannot run the webapp with a malformed key. Use the troubleshooting recipe at [Fix an ENCRYPTION_KEY length error](/guides/fix-encryption-key).
- Losing `PLATOS_MESSAGE_ENCRYPTION_KEY` makes every encrypted message and safety event unrecoverable. There is no key-recovery service. Keep an off-host backup.
- Rotating `ENCRYPTION_KEY` is more involved than rotating `PLATOS_MESSAGE_ENCRYPTION_KEY` because it touches entity service secrets that customers' backends have. Rotate entity secrets first, then the env key.
- The fork-and-edit round-trip is tested in `message-crypto.test.ts`. Adding a new code path that touches messages must also pass these round-trip tests; silent breakage of the encryption invariant is the EOBD-18-22 family of bugs.

## Related

- [Providers](/docs/providers): provider keys and the BYOK lifecycle.
- [Connected entities](/docs/connected-entities): the entity `serviceSecret` rotation.
- [Safety and PII](/docs/safety-and-pii): events stored under the same encryption key as messages.
- [Self-hosting](/docs/self-hosting): the env vars list and the bootstrap order.
