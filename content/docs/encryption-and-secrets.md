---
slug: encryption-and-secrets
title: Encryption and secrets
description: The three deliberate AES-256-GCM domains, canonical key format, fail-closed behavior, and rotation.
category: governance
order: 50
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "Where are provider keys and skill secrets stored?"
  - "How are conversations encrypted at rest?"
  - "What format do Platos encryption keys use?"
  - "Why does Platos retain three encryption keys?"
  - "How do I rotate a message key safely?"
related:
  - credential-inventory
  - providers
  - connected-entities
  - self-hosting
source_files_referenced:
  - apps/webapp/app/utils/encryptionKey.server.ts
  - apps/agent/src/monitoring/message-crypto.service.ts
  - apps/agent/src/auth/secrets.service.ts
  - apps/agent/src/shared/env.ts
---

# Encryption and secrets

Platos intentionally retains three AES-256-GCM key domains. They use one canonical deployment format but protect data with different consumers and rotation/data-loss blast radii.

| Input                           | Domain                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `ENCRYPTION_KEY`                | Webapp encrypted columns, scoped provider values, and operator TOTP material |
| `PLATOS_ENCRYPTION_KEY`         | Agent integration and secret-store ciphertext                                |
| `PLATOS_MESSAGE_ENCRYPTION_KEY` | Message, audit, and other PII-bearing content envelopes                      |

A compromise in one domain must not decrypt the other two. The agent rejects configured keys that normalize to the same bytes.

## Key format

Generate every new encryption key as 64 hexadecimal characters, decoded to 32 bytes before AES-256-GCM use:

```bash
ENCRYPTION_KEY=$(openssl rand -hex 32)
PLATOS_ENCRYPTION_KEY=$(openssl rand -hex 32)
PLATOS_MESSAGE_ENCRYPTION_KEY=$(openssl rand -hex 32)
```

Run the command separately for each input. Do not copy one generated value into several variables. Existing exact 32-byte UTF-8 `ENCRYPTION_KEY` values remain accepted with their original bytes so historical ciphertext stays decryptable. Never replace an existing value solely to convert its representation; re-encrypt first.

Production fails closed for missing or invalid keys. In particular, the message service does not silently write new plaintext rows when `PLATOS_MESSAGE_ENCRYPTION_KEY` is absent.

## Storage boundaries

1. **Webapp and scoped environment values** use `ENCRYPTION_KEY`. Webapp crypto consumers call the shared `normalizeAes256Key` decoder before invoking Node crypto.
2. **Agent integration secrets** use `PLATOS_ENCRYPTION_KEY`. `SecretsService` requires stable 32-byte key material in production; development may use an explicitly warned ephemeral key only where the agent env validator permits it.
3. **Messages and PII-bearing audit content** use `PLATOS_MESSAGE_ENCRYPTION_KEY`. Ciphertext envelopes record a key version so historical reads can retain old keys during rotation.

Plaintext secret material is never written to credential-audit rows or application logs.

## Rotation

### Message content

The unsuffixed message key is the active writer. `PLATOS_MESSAGE_ENCRYPTION_KEY_V` identifies its positive integer version. Prior read keys use `PLATOS_MESSAGE_ENCRYPTION_KEY_V<N>`.

To rotate version 1 to version 2:

```bash
PLATOS_MESSAGE_ENCRYPTION_KEY_V1=<old-key>
PLATOS_MESSAGE_ENCRYPTION_KEY=<new-key>
PLATOS_MESSAGE_ENCRYPTION_KEY_V=2
```

Restart writers, confirm new envelopes record version 2, re-encrypt version-1 rows, and remove `..._V1` only after no version-1 data or retained backup requires it.

### Webapp and agent secret stores

Those domains do not currently put a key version on every encrypted row. Do not replace either key as an environment-only change. Back up the database, run a maintenance re-encryption pass with old and new keys, verify representative reads, then cut every consumer over together. Losing the prior key before re-encryption makes ciphertext unrecoverable.

See [Credential and secret inventory](/docs/credential-inventory) for the full rotation checklist.

## Common pitfalls

- `openssl rand -hex 16` produces only 32 hex characters and is not a valid Platos encryption-key input.
- A 64-character hex value must be decoded as hex, not passed to AES as 64 UTF-8 bytes.
- Reusing a key across domains defeats blast-radius separation and is rejected.
- Removing an old versioned message key before all older envelopes and backups have aged out breaks historical reads.
- Encryption keys belong in a secret manager and an off-host recovery process, never in source control or logs.
