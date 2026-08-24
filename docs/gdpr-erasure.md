---
title: "GDPR hard erasure"
description: "Canonical Platos contract for scoped, idempotent, cross-store subject deletion and evidence."
sidebarTitle: "Hard erasure"
---

# GDPR hard erasure

This page is the canonical operator contract for subject deletion. [GDPR and data lifecycle](./gdpr.md) covers broader access, portability, and retention responsibilities.

## Authorization and scope

Hard erasure is an operator capability under `/api/v1/agent/admin/privacy`. The caller must use an admin-tier platform credential bound to the requested Organization. End-user session tokens, scope-tier credentials, static callback secrets, and credentials from another Organization are rejected.

Authority comes from persisted tenancy ancestry. Request fields do not establish access.

## API contract

| Method and path | Purpose |
| --- | --- |
| `GET /api/v1/agent/admin/privacy/subjects/{externalUserId}/inventory` | Count records the subject currently owns in each configured store. |
| `POST /api/v1/agent/admin/privacy/erasures` | Create or replay an idempotent erasure operation. |
| `GET /api/v1/agent/admin/privacy/erasures/{operationId}` | Read the metadata-only receipt. |
| `POST /api/v1/agent/admin/privacy/erasures/{operationId}/retry` | Retry only stores that have not settled. |

Create request:

```http
POST /api/v1/agent/admin/privacy/erasures
Content-Type: application/json
Authorization: Bearer <admin-platform-token>

{
  "externalUserId": "customer-123",
  "organizationId": "00000000-0000-0000-0000-000000000001",
  "idempotencyKey": "privacy-case-2026-001"
}
```

The idempotency key is required. Repeating the same scoped request returns the original operation instead of starting a second destructive pass.

## Subject resolution

Platos resolves the requested external identity and linked identity handles inside the Organization. This covers one person who arrived through several channels. A separate request is required for each Organization where the person has data.

Legal-hold matching applies to every resolved alias. A match blocks the operation before any store changes and records the refusal as metadata-only evidence.

## Store order

The executor processes:

1. object storage;
2. Redis and ephemeral coordination;
3. ClickHouse when configured;
4. Postgres last.

Postgres remains last because it contains the ownership graph and object pointers needed by earlier phases. The observability outbox follows Turn ownership, so deleting a subject's Threads and Turns also prevents a pending projection from recreating analytical data after the sweep.

## Receipt states

Each store reports independently:

- `deleted`: matching data was removed and the negative probe found no survivor;
- `nothing_to_delete`: no matching data existed and the negative probe found no survivor;
- `not_provisioned`: the integration is not configured in this installation;
- `failed`: the executor returned a definite failure;
- `unknown`: the executor could not establish the final state.

Only `deleted` and `nothing_to_delete` are positive deletion evidence. `not_provisioned` can settle an operation only for a store the operator truly does not use. `failed` and `unknown` require investigation and retry.

Receipts contain operation metadata, per-store state, counts, timestamps, and safe errors. They must not retain erased message content, attachment keys, credential values, ciphertext, or sensitive identity profiles.

## Independent verification

After the operation settles:

1. call the subject inventory endpoint and expect zero survivors in every configured store;
2. inspect object-storage prefixes independently;
3. wait for ClickHouse mutations to finish when applicable;
4. verify no pending observability outbox record can recreate subject data;
5. verify in-flight channel or webhook events cannot write the subject again.

A successful delete call by itself is insufficient evidence. Some object stores accept deletion of an absent key, and analytical mutations may complete asynchronously.

## Recovery and restore

Retry only unsettled stores. Store deletion is idempotent, so an already settled store is not swept again.

Before restoring a backup, compare its timestamp with the erasure ledger. Reapply every later erasure to the restored copy before serving traffic, then repeat independent verification. A backup that silently resurrects erased data violates the lifecycle contract.
