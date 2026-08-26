---
slug: hard-erasure
title: Hard erasure
description: The scoped API that deletes one subject across configured stores and records independently verified outcomes.
category: platform
order: 95
questions:
  - "How do I erase one subject?"
  - "How does ClickHouse erasure work?"
  - "What do receipt states mean?"
related:
  - safety-and-pii
  - legal-and-policies
  - memory
  - scope-and-multi-tenancy
---

# Hard erasure

Hard erasure resolves one subject and linked aliases inside an Organization, sweeps each configured store, verifies survivors, and persists a metadata-only receipt.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/v1/agent/admin/privacy/subjects/{externalUserId}/inventory` | Inventory without deletion |
| `POST /api/v1/agent/admin/privacy/erasures` | Create or replay an erasure |
| `GET /api/v1/agent/admin/privacy/erasures/{operationId}` | Read the receipt |
| `POST /api/v1/agent/admin/privacy/erasures/{operationId}/retry` | Retry unsettled stores |

```http
POST /api/v1/agent/admin/privacy/erasures
Content-Type: application/json

{
  "externalUserId": "user@example.com",
  "organizationId": "org_123",
  "idempotencyKey": "privacy-case-2026-001"
}
```

The caller needs an Organization-bound admin-tier platform credential. Session tokens, scope-tier credentials, cross-Organization credentials, and static component secrets cannot authorize erasure.

## Store order

The executor processes `minio → redis → clickhouse → postgres`. Postgres stays last because it contains aliases, Thread identifiers, and object pointers needed by the earlier store executors.

When ClickHouse is configured, Platos probes the expected erasure tables and columns, counts matching rows, submits `ALTER TABLE … DELETE` mutations, waits for the relevant `system.mutations` entries, and recounts. A completed mutation with surviving rows does not pass verification. An unreachable, unauthorized, malformed, or timing-out configured ClickHouse reports `failed` or `unknown`; it is never treated as absent.

`not_provisioned` is valid only when no ClickHouse endpoint is configured or when the schema probe proves no erasure tables exist. It settles the store but is not positive deletion evidence. The default Compose stack configures the Agent's ClickHouse URL, so operators should expect a verified ClickHouse outcome rather than `not_provisioned`.

## Receipt states

- `deleted`: matching data was removed and the negative probe found no survivor.
- `nothing_to_delete`: no matching data existed and the negative probe found no survivor.
- `not_provisioned`: the store or relevant erasure schema is absent; settled but not deletion evidence.
- `failed`: the executor established a failure; retryable.
- `unknown`: the final state could not be established; retryable.

Only `deleted` and `nothing_to_delete` are positive deletion evidence. Receipts store counts, statuses, timestamps, and safe error classes, never erased content or raw subject identifiers.

## Legal holds and resurrection prevention

Legal-hold matching runs across every resolved alias before deletion. A match records a refusal and destroys nothing.

A successful erasure seals hashed aliases in the erased-subject register so late channel, Turn, or memory writes cannot recreate the subject during the tombstone window. After restoring a backup, reapply all later erasures before serving traffic.

## Verify

1. Read the receipt and require positive evidence for every configured store.
2. Call the inventory endpoint and expect zero survivors.
3. Confirm no ClickHouse mutation remains active or failed.
4. Confirm no pending observability outbox row can recreate subject analytics.
5. Verify object prefixes independently.

See the canonical operator contract in `docs/gdpr-erasure.md`.
