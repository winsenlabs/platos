---
slug: hard-erasure
title: Hard erasure
description: The service-authenticated API that destroys everything Platos holds about one person and returns a receipt saying what it proved.
category: platform
order: 95
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How do I delete everything Platos knows about a user?"
  - "How do I prove to a regulator that a deletion happened?"
  - "What is an erasure receipt and what do its statuses mean?"
  - "How do legal holds stop an erasure?"
  - "Why does erasure need an idempotency key?"
  - "Which tables does erasure deliberately not touch?"
related:
  - safety-and-pii
  - legal-and-policies
  - memory
  - scope-and-multi-tenancy
source_files_referenced:
  - apps/agent/src/privacy/erasure.service.ts
  - apps/agent/src/privacy/erasure-orchestrator.ts
  - apps/agent/src/privacy/erasure-receipt.ts
  - apps/agent/src/privacy/subject-graph.ts
  - apps/agent/src/privacy/legal-hold.ts
  - apps/agent/src/privacy/redis-keys.ts
---

# Hard erasure

Deleting a person from an agent platform is harder than deleting rows. The same human arrives as a Slack id in one thread, an email in another, and a channel handle in a third; their content is spread across Postgres, Redis, ClickHouse, and object storage; and the operation has to be provable afterwards, when the evidence that would have proved it is exactly what you destroyed.

Hard erasure is one API call that resolves the person, sweeps every store, and returns a durable receipt recording what it deleted and what it verified gone.

## What it is

Four routes under `/api/v1/agent/admin/privacy`:

| Route | Purpose |
| --- | --- |
| `GET /subjects/:externalUserId/inventory` | What a request would target, without deleting |
| `POST /erasures` | Request an erasure |
| `GET /erasures/:operationId` | Fetch the receipt |
| `POST /erasures/:operationId/retry` | Re-run the stores that did not settle |

Authenticated with `Authorization: Bearer plt_mcp_...`. The control-plane credential must have `admin` tier and must be bound to the requested organization. **Ordinary Platos session tokens, scope-tier credentials, credentials from another organization, and static internal-callback secrets cannot reach these routes** — erasure is an operator capability, not something an end user's token can trigger.

```json
POST /api/v1/agent/admin/privacy/erasures
{ "externalUserId": "user@example.com", "organizationId": "org_…", "idempotencyKey": "…" }
```

`idempotencyKey` is required. Replaying a request returns the original receipt rather than running a second destructive pass — which matters because the natural response to an ambiguous erasure result is to fire it again.

## Why it matters

**One person is many handles.** Erasure resolves a subject from the requested `externalUserId`, any linked external id, and any channel identity handle. Deleting only rows matching the string you were given leaves the person reconstructable from the threads they entered by another route.

**Deletion is not evidence of deletion.** S3-compatible deletes succeed for keys that never existed, so a successful delete call proves nothing. Every executor re-probes after sweeping and records the surviving count. An inconclusive probe is recorded as *still present*, never rounded down to "gone" — that is the direction that manufactures a false certificate.

**Erasure order matters.** Stores are swept `minio → redis → clickhouse → postgres`. Postgres is last because it holds the pointers the other sweeps need; deleting it first would orphan objects that could no longer be found, let alone deleted.

**Some tables must never be swept.** A `userId` column appears on operator tables too — accounts, access tokens, MFA recovery codes. Deleting by column name across every table carrying it would destroy an operator's account while purporting to serve a customer's request. The tables are therefore enumerated explicitly in `subject-graph.ts`: an allow-list is auditable, a column scan is a loaded gun.

## Reading a receipt

Each store reports independently, and the operation's status is derived from them.

- `deleted` — swept, and verified gone. Settled.
- `nothing_to_delete` — the subject had nothing here. Settled.
- `not_provisioned` — this store is not wired in this deployment. **Settles the operation but is not evidence of deletion.** If you run ClickHouse or object storage, wire them before the receipt means anything.
- `failed` — the sweep errored. Retryable.
- `unknown` — the executor crashed mid-pass and the true state was never established. Retryable, and deliberately *not* reported as failed: the distinction between "we know it didn't work" and "we don't know what happened" is the one a regulator will ask about.
- `blocked_legal_hold` — see below. Nothing was destroyed.

Receipts are content-free by construction. They record counts, statuses, and error *classes* — never the erased content, and never the raw external user id, which is stored only as a salted org-scoped hash. A receipt that quoted the data it destroyed would reintroduce the thing the erasure removed.

## Legal holds

Set `PLATOS_LEGAL_HOLD_USER_IDS` to a comma-separated register of held identifiers. The check runs before the operation row is created and before any executor touches a store; a match returns `blocked_legal_hold` naming the entry that stopped it and destroys nothing. The refused request is still recorded — a refusal is itself an event you may have to evidence.

Matching runs across **every alias the subject resolves to**, not just the requested identifier, so a hold registered against a Slack id also blocks an erasure requested by that person's email. Registering any one identifier is sufficient. Changing the register requires a restart.

## Common pitfalls

- **Treating `not_provisioned` as success.** It means "not wired here", not "nothing to delete". Check it against the stores you actually run.
- **Erasure is org-scoped by design.** A request cannot reach across organizations. Someone present in several needs one request per org.
- **ClickHouse is not swept automatically yet.** The executor detects the deployment but does not submit a mutation. Scrub by hand and record it alongside the receipt — see [GDPR + data deletion](https://github.com/winsenlabs/platos/blob/main/docs/gdpr.md).
- **Late writes can resurrect a subject.** An in-flight write landing after the sweep reintroduces rows. Quiesce, or re-run, for anyone active at the moment of erasure.
- **Audit rows survive on purpose.** Tool-call and admin audit records retain identifiers for forensics. Document that window in your privacy notice; it is the one thing that outlives the request.

## Related

- [Safety and PII](/docs/safety-and-pii): redaction before data is stored.
- [Legal and policies](/docs/legal-and-policies): what applies when you self-host.
- [Memory](/docs/memory): the per-user memory delete, a narrower operation than this one.
- [Scope and multi-tenancy](/docs/scope-and-multi-tenancy): why the org boundary is the erasure boundary.
