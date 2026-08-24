---
slug: fix-encryption-key
title: Fix an ENCRYPTION_KEY format error
description: Generate canonical 64-hex-character Platos encryption keys while preserving historical ciphertext.
category: troubleshooting
order: 40
questions:
  - "Why does the webapp say ENCRYPTION_KEY must be 64 hex chars?"
  - "How do I generate a valid AES-256-GCM key?"
  - "I rotated a key and ciphertext no longer decrypts, what now?"
related:
  - install-self-host
  - backup-and-restore
  - encryption-and-secrets
---

# Fix an ENCRYPTION_KEY format error

New Platos encryption inputs use 64 hexadecimal characters, decoded to 32 bytes for AES-256-GCM. Existing exact 32-byte UTF-8 `ENCRYPTION_KEY` values remain valid and retain their original bytes.

## Generate independent keys

```bash
ENCRYPTION_KEY=$(openssl rand -hex 32)
PLATOS_ENCRYPTION_KEY=$(openssl rand -hex 32)
PLATOS_MESSAGE_ENCRYPTION_KEY=$(openssl rand -hex 32)
```

Run each command separately. Do not reuse one value across variables; the agent rejects duplicate key material. A 32-character hex string from `openssl rand -hex 16` is accepted only when it is the exact historical UTF-8 `ENCRYPTION_KEY`; it is not a valid format for a newly generated key.

Restart webapp, agent, and workers after updating the secret manager or `.env`:

```bash
docker compose -f docker-compose.platos.yml restart webapp agent start-worker
```

## Verify

- `docker compose ps` reports healthy services.
- Boot logs have no environment-validator errors.
- Existing encrypted secrets and chats decrypt successfully.
- New message envelopes have the configured `PLATOS_MESSAGE_ENCRYPTION_KEY_V`.

## If data was already encrypted

Do not generate a replacement merely to fix formatting unless you have retained the old key and a re-encryption plan. Ciphertext cannot be recovered without the exact key bytes that wrote it.

`ENCRYPTION_KEY` and `PLATOS_ENCRYPTION_KEY` domains require a maintenance re-encryption pass before cutover. Message encryption supports versioned reads: retain the old key as `PLATOS_MESSAGE_ENCRYPTION_KEY_V<N>`, increment the active version, and re-encrypt old envelopes before removing it.

See [Encryption and secrets](/docs/encryption-and-secrets) and [Credential inventory](/docs/credential-inventory) for the complete rotation procedures.
