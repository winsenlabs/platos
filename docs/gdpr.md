---
title: "GDPR + data deletion"
description: "Workflows for Platos self-hosters to handle data-deletion requests, retention, and user off-boarding."
sidebarTitle: "GDPR"
---

# GDPR + data deletion

Platos is self-hosted OSS. You, the operator, are the **data controller** under GDPR. This page documents the workflows Platos ships for common GDPR requests — right to erasure (Art. 17), right to data portability (Art. 20), and retention controls (Art. 5(1)(e)).

<Warning>
Platos OSS does not offer a managed "DELETE MY DATA" button for end users. Every erasure must be initiated by an operator with access to the admin routes below. If you expose a self-service deletion flow to end users, route it through your entity backend — never directly to the agent.
</Warning>

## What data Platos stores about a user

Four stores hold user-identifiable data:

1. **Postgres** (`@platos/database` schema):

   - `User` (auth record)
   - `PlatosAgentThread` (conversation containers, FK `userId`)
   - `PlatosAgentMessage` (messages, FK via `threadId`)
   - `PlatosMemory` + `PlatosMemoryEntity` + `PlatosMemoryRelationship` (semantic memory)
   - `PlatosAgentUserProfile` (per-agent user facts)
   - `PlatosMessageRating` (feedback)
   - `PlatosMessageAttachment` (attachment metadata)
   - `PlatosAdminAudit` + `PlatosToolCallAudit` (audit trails — retained for forensics; see "Audit exception" below)

2. **ClickHouse**: spans, traces, cost rows — may contain `userId` labels for per-user cost rollups.

3. **MinIO**: attachment bytes. Keyed by `organizationId/projectId/userId/...`.

4. **Redis**: in-flight state — cost counters, rate-limit windows, approval queues. Ephemeral; rebuildable from Postgres.

## Right to erasure — per-user delete

Use the hard-erasure API. It performs the whole cascade across Postgres, Redis, ClickHouse, and object storage in one idempotent operation and returns a durable receipt recording what was deleted and what was verified gone. The full request/response contract, the receipt status model, and the deployment prerequisites live in [Hard erasure — contract and evidence](./gdpr-erasure.md).

<Steps>
<Step title="Identify the subject">
A subject is resolved from an `externalUserId` within an `organizationId`. Platos matches on the external id, any linked external id, and any linked identity handle, so one request covers the same person arriving through several channels.

A single person may still hold data in more than one organization. Erasure is org-scoped by design — a request cannot reach across orgs — so raise one request per organization where they have data.
</Step>

<Step title="Request the erasure">
`POST /api/v1/agent/admin/privacy/erasures`

```json
{ "externalUserId": "…", "organizationId": "…", "idempotencyKey": "…" }
```

Authenticated with `Authorization: Bearer plt_mcp_...`. The credential must have `admin` tier and belong to the requested organization. Ordinary Platos session tokens, scope-tier credentials, cross-organization credentials, and static callback secrets cannot reach this route. The `idempotencyKey` is required: replaying a request returns the original receipt rather than running a second destructive pass.
</Step>

<Step title="Read the receipt">
`GET /api/v1/agent/admin/privacy/erasures/:operationId`

Each store reports independently. Treat only `deleted` and `nothing_to_delete` as settled. `not_provisioned` means that store is not wired in this deployment — it settles the operation but is **not** evidence of deletion, and if you run ClickHouse or object storage you must wire them before the receipt means anything. `failed` and `unknown` are retryable; `unknown` specifically means a store crashed mid-pass and its true state was never established, which is deliberately not rounded down to success.
</Step>

<Step title="Retry anything unsettled">
`POST /api/v1/agent/admin/privacy/erasures/:operationId/retry`

Retries only the stores that are not settled. Safe to call repeatedly — deletion is idempotent, and stores already `deleted` are skipped rather than re-swept.
</Step>

<Step title="Verify independently">
The receipt carries its own negative verification: after deleting, each executor re-probes for survivors and records the count. For an external audit, query the stores yourself rather than trusting the receipt — `GET /api/v1/agent/admin/privacy/subjects/:externalUserId/inventory` returns the per-store counts the operation would target, and should return zero across the board once the operation is settled.
</Step>
</Steps>

### If you are scrubbing ClickHouse by hand

The API handles this when ClickHouse is provisioned. If you are working on an older deployment, note that spans live in `trigger_dev.platos_spans_v1` and the identity columns are `user_id` (SHA256-hashed, the canonical join key), plus `user_display_name` and `user_email`, which hold plaintext when an entity signed a `userMeta` claim into the session token.

```sql
ALTER TABLE trigger_dev.platos_spans_v1
  UPDATE user_display_name = '', user_email = ''
  WHERE user_id = '{hashedUserId}';
```

Null the plaintext columns and keep the hashed `user_id`: it carries no personal data on its own and it is what every cost and usage rollup joins on, so blanking it corrupts historical billing to no privacy benefit. ClickHouse mutations are asynchronous — poll `system.mutations` for `is_done` before reporting the erasure complete. Run `ON CLUSTER` if you are sharded.

### Audit exception

`PlatosAdminAudit` + `PlatosToolCallAudit` rows retain the user's `actorUserId` / `userId` for forensics (6 years is typical for SOC-2 / SOX — check your regulator). These are the only rows that persist after user delete. Document the retention window in your privacy notice.

If a regulator requires audit deletion too, add `--purge-audit` to the admin call; it will remove those rows but you lose the forensic trail.

## Right to data portability

Export all data the operator holds about a user:

```
GET /api/v1/admin/users/:userId/data/export?organizationId=…&projectId=…&environmentId=…
```

Returns a zip containing:

- `messages.jsonl` (one message per line)
- `memories.jsonl`
- `threads.jsonl`
- `ratings.jsonl`
- `attachments/` (actual bytes, pulled from MinIO)

Streaming response — safe for users with many GB of attachments. Expires after 24 hours (signed URL).

## Retention controls

<Info>
Platos defaults to "keep forever" for messages and memories. This is sensible for agent memory quality but hostile for privacy. Every production deployment should pick explicit retention windows.
</Info>

### Message retention

Set `PLATOS_MESSAGE_RETENTION_DAYS` to auto-expire messages older than N days. The scheduled `platos.messages.retention` task (runs nightly) deletes expired rows.

### Memory retention

Memories don't have per-row TTL in MVP. Delete via the admin route above or via the memory UI.

### Attachment retention

Already has a TTL — `PLATOS_ATTACHMENT_TTL_DAYS` (default 30). Past the TTL, attachments are GC'd by the scheduled retention task.

### Audit retention

`PLATOS_AUDIT_RETENTION_DAYS` — default 2190 (6 years). Nightly purge task deletes rows older than the window.

## Legal holds

Before deleting, check whether the user is subject to a legal hold (lit-hold, tax audit, ongoing incident).

Set `PLATOS_LEGAL_HOLD_USER_IDS` to a comma-separated register of held identifiers. The erasure API checks it before creating the operation and before any executor touches a store; a match returns a receipt with status `blocked_legal_hold` naming the register entry that stopped it, and destroys nothing. The refused request is still recorded as an operation, because a refusal is itself an event you may have to evidence.

Matching runs across **every alias the subject resolves to**, not just the identifier in the request. A hold registered against a Slack user id therefore also blocks an erasure requested by that person's email. Registering any one of a subject's identifiers is sufficient; matching is case-insensitive.

The API also accepts a `legalHoldPolicyId` in the request body for a hold the caller already knows about. That is a supplement, not a substitute — it only protects a subject when whoever fires the request is already aware of the hold, which is exactly the knowledge a register exists because people do not reliably have.

Platos does not manage hold lifecycle: adding, reviewing, and releasing holds stays in your operator playbook. Changing the env requires a restart to take effect.

## Breach notification

If you suspect a breach, rotate every secret in `docs/self-hosting.md#key-rotation-runbook` immediately and work through your privacy counsel's notification timeline (72 hours for GDPR Art. 33 notifications to supervisory authorities).

## Why this isn't baked into the UI yet

The OSS mode focuses on giving operators the primitives. A polished admin UI for deletion/export is a post-v1 item. If you need it sooner, wire the routes above into your own admin tooling — they're stable.

## Known gaps

Be precise with regulators about what the receipt currently proves:

- **ClickHouse is not swept automatically.** The executor detects the deployment and reports `not_provisioned` where the table is absent, but it does not yet submit and poll a mutation. Where you run ClickHouse, scrub by hand as above and record it alongside the receipt.
- **`not_provisioned` is not evidence of deletion.** It settles an operation so the receipt is not left hanging, and it means only that a store is not wired here. Confirm every store you actually run reports `deleted` or `nothing_to_delete`.
- **Late-event resurrection is not prevented.** An in-flight write that lands after the sweep can reintroduce rows for an erased subject. Quiesce or re-run for a subject who was active at the moment of erasure.
- **Object storage and Redis executors are lightly exercised.** Both are implemented and unit-tested, but have not been run against a large real corpus.
