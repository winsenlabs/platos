---
slug: audit-log
title: Audit log
description: Append-only audit trail of admin actions and tool calls, scoped per environment.
category: observability
order: 50
questions:
  - "What admin actions are audited?"
  - "How is the tool-call audit different from the trace?"
  - "How long is audit data retained?"
  - "How do I export audit data?"
  - "Are audit entries encrypted?"
related:
  - safety-and-pii
  - traces
  - encryption-and-secrets
---

# Audit log

Two append-only logs sit alongside conversations and traces: admin audit (who did what to which agent or scope) and tool audit (every tool call's args and result). Both are scope-isolated, encrypted on the wire, and exportable for compliance review.

## What it is

Two services, two tables:

- **Admin audit** (`AdminAuditService` -> `AdminAudit`): operator actions such as creating an Agent, rotating a provider key, overriding a Budget, or requesting hard erasure.
- **Tool audit** (`ToolAuditService` -> `ToolCallAudit`): every Tool Call dispatched by an Agent. Carries scoped identity, status, timing, and policy-redacted arguments or results.

Audit entries are append-only; updates are not allowed and the table has no `updatedAt`. Replays (re-active a tool call from an audit row) write a new audit row; the original is preserved.

## Why it matters

Trace data is operational, audit data is legal. A trace tells you what the system did; an audit tells you who asked the system to do it. The split is what lets you keep traces lean (drop on retention) while keeping audits long (compliance retention).

The encrypted-at-rest tool audit is a key compliance feature: it records the arguments the model passed to entity tools (which may contain customer data) without leaving them in cleartext. Reads decrypt only inside the audit endpoint.

## How to use it

### View admin audits

`/orgs/{org}/projects/{project}/env/{env}/agent-monitoring` -> Activity tab. Sort by actor, action, or time. Click an entry to see the before/after diff (provider key rotation, agent config change, etc.).

### View tool audits

The trace view's tool span has a "View audit" link. The audit page shows the full args (decrypted) and the result, plus a "Replay" button.

### Replay a Tool Call

`POST /api/v1/agent/tool-calls/{toolCallId}/replay` re-dispatches a persisted Tool Call through the generated public contract. The replay is a new operation; the original evidence remains unchanged. Replays execute real work and remain subject to authorization and Budget enforcement.

### Export

The generated public contract does not currently expose a tool-audit CSV export route. If an installation needs compliance export, query its operator-owned audit store through a separately reviewed, scope-enforcing process rather than relying on an undocumented HTTP endpoint.

### Retention

Default retention is 1 year for admin audits and 90 days for tool audits. Configure via `PLATOS_ADMIN_AUDIT_RETENTION_DAYS` and `PLATOS_TOOL_AUDIT_RETENTION_DAYS`. The retention sweep runs on the internal scheduler.

## Common pitfalls

- Audit reads require admin scope by default. A non-admin operator viewing the activity tab sees a redacted view; full args are admin-only.
- Tool audit and trace data are duplicated; the split exists for retention. A long retention on traces is wasteful (most are not legally required); a short retention on audits is dangerous (you may need them in two years).
- Replays charge real cost. The replayed call goes through the same cost path; budget caps apply.
- Append-only means deletes are exceptional. The GDPR delete cascade is the only legitimate way to remove an audit row, and it logs that delete in a parent audit.

## Related

- [Safety and PII](/docs/safety-and-pii): the third leg of the governance audit trail.
- [Traces](/docs/traces): operational counterpart to the audit log.
- [Encryption and secrets](/docs/encryption-and-secrets): the encryption key both audit tables use.
