---
slug: encryption-and-secrets
title: Encryption and secrets
description: Deliberate encryption domains, the credential root-key ring, fail-closed behavior, and rotation.
category: governance
order: 50
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "Where are provider keys and skill secrets stored?"
  - "How are conversations encrypted at rest?"
  - "What format do Platos encryption keys use?"
  - "Why is the credential root-key ring separate from other encryption keys?"
  - "How do I rotate a message key safely?"
related:
  - credential-inventory
  - providers
  - connected-entities
  - self-hosting
source_files_referenced:
  - internal-packages/database/src/secrets.ts
  - apps/webapp/app/utils/encryptionKey.server.ts
  - apps/agent/src/monitoring/message-crypto.service.ts
  - apps/agent/src/auth/secrets.service.ts
  - apps/agent/src/shared/env.ts
---

# Encryption and secrets

Platos keeps native Environment credentials in a versioned root-key ring that is independent from fixed webapp, agent-integration, message, and authentication domains. Compromise or rotation in one domain must not unlock another.

| Input                           | Domain                                                           |
| ------------------------------- | ---------------------------------------------------------------- |
| `ENCRYPTION_KEY`                | Webapp encrypted columns and operator TOTP material              |
| `PLATOS_ENCRYPTION_KEY`         | Agent integration ciphertext outside the native credential store |
| `PLATOS_MESSAGE_ENCRYPTION_KEY` | Message, audit, and other PII-bearing content envelopes          |
| `PLATOS_CREDENTIAL_ROOT_KEYS`   | Native Environment provider/MCP credential envelopes             |

A credential root must not reuse any of these keys or session, magic-link, internal-auth, or worker secret material.

## Key format

Generate every new encryption key as 64 hexadecimal characters, decoded to 32 bytes before AES-256-GCM use:

```bash
ENCRYPTION_KEY=$(openssl rand -hex 32)
PLATOS_ENCRYPTION_KEY=$(openssl rand -hex 32)
PLATOS_MESSAGE_ENCRYPTION_KEY=$(openssl rand -hex 32)
CREDENTIAL_ROOT_V1=$(openssl rand -hex 32) # place under key "1" in PLATOS_CREDENTIAL_ROOT_KEYS
```

Run the command separately for each input. Do not copy one generated value into several variables. Existing exact 32-byte UTF-8 `ENCRYPTION_KEY` values remain accepted with their original bytes so historical ciphertext stays decryptable. Never replace an existing value solely to convert its representation; re-encrypt first.

Production fails closed for missing or invalid keys. In particular, the message service does not silently write new plaintext rows when `PLATOS_MESSAGE_ENCRYPTION_KEY` is absent.

## Storage boundaries

1. **Webapp encrypted columns and operator TOTP** use `ENCRYPTION_KEY`.
2. **Agent integration data outside the native credential store** uses `PLATOS_ENCRYPTION_KEY`.
3. **Messages and PII-bearing audit content** use `PLATOS_MESSAGE_ENCRYPTION_KEY`. Ciphertext envelopes record a key version so historical reads can retain old keys during rotation.
4. **Dashboard-created provider and MCP credentials** use the credential root-key ring. Every envelope binds Environment ID, credential ID, secret revision, format version, and root version through HKDF-SHA256 and AES-256-GCM AAD.

Credential metadata and references never contain plaintext or envelope fields. Runtime resolution requires authenticated Environment scope, has no provider `process.env` fallback, and records every successful decrypt in immutable audit. Audit failure aborts the read.

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

### Native credential roots

Set `PLATOS_CREDENTIAL_ROOT_KEY_VERSION` to a positive active version and provide its 64-hex root plus any still-referenced prior roots in the `PLATOS_CREDENTIAL_ROOT_KEYS` JSON object.

To rotate root 1 to 2: add the new `"2"` root-map entry on webapp, agent, and worker while active remains 1; switch all three to active version 2; rewrap every active credential; wait for `status().activeVersionsByRoot[1]` to reach zero and require `canRemoveRoot(..., 1)`; then remove the `"1"` root-map entry everywhere. Any nonzero count or failed check blocks removal.

Provider-secret rotation is independent: it creates a new secret revision under the active root. In-flight holders may finish with already-acquired material; subsequent reads receive the replacement.

### Fixed-key legacy domains

`ENCRYPTION_KEY` and `PLATOS_ENCRYPTION_KEY` do not put the native credential root version on every encrypted row. Do not replace either as an environment-only change. Back up the database, run a maintenance re-encryption pass with old and new keys, verify representative reads, then cut every consumer over together. Losing the prior key before re-encryption makes ciphertext unrecoverable.

See [Credential and secret inventory](/docs/credential-inventory) for the full rotation checklist.

## Common pitfalls

- `openssl rand -hex 16` produces only 32 hex characters and is not a valid Platos encryption-key input.
- A 64-character hex value must be decoded as hex, not passed to AES as 64 UTF-8 bytes.
- Reusing a key across domains defeats blast-radius separation and is rejected.
- Removing a credential root while active envelopes reference it is forbidden; status and `canRemoveRoot` are the removal gate.
- Removing an old versioned message key before all older envelopes and backups have aged out breaks historical reads.
- Encryption keys belong in a secret manager and an off-host recovery process, never in source control or logs.
