---
slug: credential-inventory
title: Credential and secret inventory
description: Canonical inventory of Platos credentials, deployment secrets, expiry, audit, and rotation procedures.
category: operations
order: 21
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "Which Platos credentials and secrets exist?"
  - "How long does each token live?"
  - "How do I revoke or rotate a credential?"
  - "Why are there three encryption keys?"
related:
  - auth-modes
  - mcp-tokens-and-pat
  - encryption-and-secrets
source_files_referenced:
  - internal-packages/database/prisma/schema.prisma
  - apps/agent/src/shared/env.ts
  - apps/webapp/app/env.server.ts
  - apps/agent/src/mcp-platform/token.service.ts
  - apps/agent/src/mcp-platform/mcp-bearer-token.service.ts
  - apps/webapp/app/services/patService.server.ts
---

# Credential and secret inventory

This page is the canonical inventory for Platos-owned authentication, signing, encryption, and service-boundary secrets. Third-party provider credentials such as Anthropic, Voyage, object-store, Postgres, Redis, and ClickHouse passwords are operational dependencies, not Platos credential families; rotate those with their provider and update every consuming container.

Never log raw bearer tokens, token hashes, signing secrets, or encryption keys.

## Database-backed bearer credentials

| Family         | Prefix     | Random material            | Scope                                                          | Expiry                                                       | Revocation                                                                            | Audit and failure behavior                                                 |
| -------------- | ---------- | -------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Control plane  | `plt_mcp_` | 32 random bytes, base64url | Organization plus `scope` or `admin` tier                      | 90 days by default                                           | Revoke by credential ID; first revoke sets `revokedAt`; repeated revoke is idempotent | Atomic `control_plane/mint`, successful `use`, and first `revoke` evidence |
| Entity MCP     | `plt_ent_` | 48 random bytes, base64url | One entity, organization, project, and environment             | 90 days by default                                           | Revoke by credential ID and entity owner; repeated revoke is idempotent               | Atomic `entity_mcp/mint`, successful `use`, and first `revoke` evidence    |
| User API / CLI | `plt_pat_` | 32 random bytes, base64url | One user; organization/project access remains membership-bound | 90 days by default; explicit `ttlSeconds: 0` means no expiry | Owner revokes by PAT ID; repeated revoke is idempotent                                | Atomic `user_api/mint`, successful `use`, and first `revoke` evidence      |

All three store only SHA-256 token hashes. Verification checks the prefix before database access, performs a constant-time digest comparison, rejects `expiresAt <= now` and `revokedAt != null`, and atomically records `lastUsedAt` with use evidence. If audit persistence fails, authentication fails closed.

### Rotation

1. Mint a replacement with the narrowest required scope and tier.
2. Update the client without exposing either bearer in logs.
3. Confirm a successful-use audit row for the replacement.
4. Revoke the prior credential and confirm one revoke audit row.
5. Investigate any later use attempts for the revoked credential.

`pmt_` and `tr_pat_` are retired. There is no compatibility window or alias.

## Short-lived and row-bound credentials

| Credential                                 | Protection and scope                                                     | Lifetime                                                | Revocation / rotation                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Operator session                           | Browser/operator identity signed from `SESSION_SECRET`                   | 7 days maximum                                          | Revoke the session row for one user. Rotate `SESSION_SECRET` to invalidate all platform sessions.        |
| Entity session JWT                         | Entity-authorized request scope, signed by that entity's `serviceSecret` | 5 minutes by default                                    | Wait for expiry for a single token; rotate the entity secret to reject future handshakes and JWTs.       |
| Magic link                                 | Login link signed with `MAGIC_LINK_SECRET`                               | 15 minutes                                              | Single-use/expiry rules apply. Rotate the secret to invalidate every outstanding link.                   |
| Entity `serviceSecret`                     | One connected entity's HMAC and WebSocket bootstrap                      | No automatic expiry                                     | Generate a replacement, update the entity backend, reconnect, then remove the old value.                 |
| OAuth client secret and authorization code | One OAuth client / one short-lived exchange                              | Defined by the OAuth client and authorization-code flow | Rotate the client secret through OAuth client management; authorization codes are single-use and expire. |
| `BACKDOOR_PLATOS_DEV`                      | Development-only operator bypass                                         | Deployment lifetime                                     | Never enable in production. Disable first, then rotate/remove the value.                                 |

Platos has one platform session-signing input: `SESSION_SECRET`. The retired `PLATOS_SESSION_SECRET` must not be configured. `MAGIC_LINK_SECRET` remains separate because a leaked login-link signer and a leaked session signer have different blast radii.

### Rotating `SESSION_SECRET`

Deploy the new value to webapp, agent, and any worker that mints or verifies platform session JWTs in one coordinated restart. Existing sessions and in-flight bridge tokens become invalid; plan a forced sign-in. Do not run mixed old/new signers longer than the deployment rollout.

## Encryption domains

Generate new AES-256-GCM deployment keys as exactly **64 hexadecimal characters (32 bytes)**, independently:

```bash
openssl rand -hex 32
```

| Input                           | Domain                                                                                    | Why it remains separate                                                          | Production behavior                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `ENCRYPTION_KEY`                | Webapp encrypted columns, scoped provider values, and Platos-owned operator TOTP material | Compromise should not decrypt agent integration secrets or conversation content  | Required and format-validated; known example sentinel is rejected                      |
| `PLATOS_ENCRYPTION_KEY`         | Agent integration/secret-store ciphertext                                                 | Integration credentials have a different operational and rotation blast radius   | Required; invalid/missing key fails closed in production                               |
| `PLATOS_MESSAGE_ENCRYPTION_KEY` | Message, audit, and PII-bearing content envelopes                                         | Content can be versioned and re-encrypted independently from service credentials | Required; missing/invalid key fails closed in production rather than writing plaintext |

Existing exact 32-byte UTF-8 `ENCRYPTION_KEY` values remain supported. Keep their exact bytes until every historical row has been re-encrypted; changing only the environment value makes those rows unrecoverable.

The agent compares configured key bytes pairwise and refuses reused material, including hex strings that differ only by letter case.

### Webapp and agent secret-store rotation

These ciphertext domains do not currently carry a per-row key version. Do not replace either key in place before re-encrypting every row in that domain. The safe procedure is:

1. Take and verify a database backup.
2. Run a maintenance re-encryption job that decrypts with the old key and writes with the new key.
3. Verify representative rows and application reads before cutover.
4. Deploy the new key to every consumer simultaneously.
5. Retain the old key only in the approved secret manager rollback window, then destroy it.

If no re-encryption tooling is available, rotation is a planned maintenance migration, not an environment-only change.

### Message-key rotation

Message envelopes persist a key version. The unsuffixed key is the active write key; `PLATOS_MESSAGE_ENCRYPTION_KEY_V` is its positive integer version. Prior read keys remain available as `PLATOS_MESSAGE_ENCRYPTION_KEY_V<N>`.

For version 1 to version 2:

1. Keep `PLATOS_MESSAGE_ENCRYPTION_KEY_V1=<old key>`.
2. Set `PLATOS_MESSAGE_ENCRYPTION_KEY=<new key>` and `PLATOS_MESSAGE_ENCRYPTION_KEY_V=2`.
3. Restart writers. New rows record version 2; old version-1 rows decrypt through `..._V1`.
4. Re-encrypt historical rows to version 2 and verify the migration.
5. Remove `..._V1` only after no version-1 envelopes remain and backups have aged out.

## Service-to-service secrets

| Input                           | Boundary                                               | Authentication shape                                                     | Rotation                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLATOS_INTERNAL_AUTH_TOKEN`    | Dedicated webapp/agent scheduled and durable callbacks | `X-Platos-Internal-Auth` with length check plus constant-time comparison | Mint a random replacement, update caller and receiver together, restart, verify one callback, then remove the old value. It never authorizes hard erasure. |
| `PLATOS_DOCS_MCP_BRIDGE_SECRET` | Agent to docs MCP bridge                               | Bridge-specific secret                                                   | Rotate both bridge endpoints in a coordinated deployment and verify a docs lookup.                                                                         |
| `TRIGGER_INTERNAL_SECRET`       | Trigger durable-execution internal API                 | Trigger-specific internal signature/secret                               | Follow the Trigger deployment rotation sequence and update every Trigger caller/receiver together.                                                         |
| `MANAGED_WORKER_SECRET`         | Mode-C managed worker handshake                        | Worker-specific bearer/handshake                                         | Unchanged by WIN-122. Preserve until the run-engine work in WIN-132 owns removal or replacement.                                                           |

`PLATOS_ADMIN_TOKEN` is retired. Operator-facing irreversible erasure uses an organization-bound, admin-tier `plt_mcp_` credential. Static service secrets must not impersonate an operator credential.

## Audit review

`PlatosCredentialAudit` records only:

- family and credential row ID;
- action (`mint`, `use`, or `revoke`);
- applicable organization, project, environment, and actor user IDs;
- timestamp.

It never records raw credentials or hashes. Alert on use after intended revocation, repeated failed cross-organization attempts, unexpected admin-tier minting, and long-lived `plt_pat_` credentials created with `ttlSeconds: 0`.
