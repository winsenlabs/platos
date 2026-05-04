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

<Steps>
<Step title="Identify the scope">
A user lives within an `(organizationId, projectId, environmentId)` tuple. A single person may have separate records across multiple scopes — delete in each scope where they have data.
</Step>

<Step title="Run the admin delete route">
`DELETE /api/v1/admin/users/:userId/data?organizationId=…&projectId=…&environmentId=…`

Guarded by `PLATOS_ADMIN_TOKEN` in the `X-Platos-Admin-Token` header. Cascades:
- Delete `PlatosMemory` + `PlatosMemoryEntity` + `PlatosMemoryRelationship` for the user.
- Delete `PlatosAgentUserProfile`.
- Delete `PlatosMessageRating` written by the user.
- Delete `PlatosAgentMessage` rows in threads owned by the user.
- Delete `PlatosAgentThread` rows for the user.
- Delete `PlatosMessageAttachment` rows + schedule a MinIO object delete.
</Step>

<Step title="Purge attachment bytes">
The attachment deletion is asynchronous — the scheduled `platos.attachments.retention` task (runs hourly) sweeps the MinIO objects. To force immediate purge:
`POST /api/v1/agent/attachments/retention?forceUserId={userId}`
</Step>

<Step title="ClickHouse label scrub">
ClickHouse stores the `userId` as a label on span + cost rows. Labels are not indexed by user, so scrub via:
```sql
ALTER TABLE platos_spans_v1
  UPDATE platos_user_id = 'deleted'
  WHERE platos_user_id = '{userId}';
```
Run in `ON CLUSTER` mode if you're sharded.
</Step>

<Step title="Verify">
`GET /api/v1/admin/users/:userId/data?dryRun=1` returns a count per table. After deletion, every count should be zero except audit rows.
</Step>
</Steps>

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

Before deleting, check whether the user is subject to a legal hold (lit-hold, tax audit, ongoing incident). Platos does not automate hold management; track this in your operator playbook. The `PLATOS_LEGAL_HOLD_USER_IDS` env (comma-separated) is checked by the delete route and rejects the request for any user on the list.

## Breach notification

If you suspect a breach, rotate every secret in `docs/self-hosting.md#key-rotation-runbook` immediately and work through your privacy counsel's notification timeline (72 hours for GDPR Art. 33 notifications to supervisory authorities).

## Why this isn't baked into the UI yet

The OSS mode focuses on giving operators the primitives. A polished admin UI for deletion/export is a post-v1 item. If you need it sooner, wire the routes above into your own admin tooling — they're stable.
