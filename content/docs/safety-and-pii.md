---
slug: safety-and-pii
title: Safety, PII, governance
description: Per-agent PII filters, safety event logging, and the governance dashboard that rolls them up.
category: governance
order: 30
questions:
  - "What is a safety event?"
  - "How do I configure a PII filter on an agent?"
  - "Which PII categories are detected by default?"
  - "How are filter hits logged and where are they viewed?"
  - "Can a safety event auto-pause an agent?"
  - "How do I export safety events for compliance review?"
related:
  - hard-erasure
  - approvals-and-hitl
  - audit-log
  - encryption-and-secrets
---

# Safety, PII, governance

The safety layer runs on every turn and on every memory write. PII filters detect sensitive content (emails, phone numbers, credit cards, custom regex sets), log a `SafetyEvent`, and either redact, block, or pass through depending on policy. The governance dashboard rolls events up so you can audit what was filtered, by which agent, on whose behalf.

## What it is

Three services tied together:

- `SafetyService`: runs the rule engine over messages and memory writes. Configurable per agent (PIFSP-18 added per-agent filter sets).
- `SafetyEventService`: persists each rule hit as a `SafetyEvent` record, encrypted at rest like Turn content.
- `GovernanceService`: rolls up events by category, agent, and user; exposes the data to the governance dashboard.

Default categories: `email`, `phone`, `credit_card`, `ssn`, `api_key`, `iban`. Custom categories: a regex catalog stored on the agent's safety config; each entry has a name, pattern, and policy (`redact`, `block`, `flag`).

Policy:

- `redact`: mask the match in the model input or memory write; the safety event records what was masked.
- `block`: refuse the turn or memory write entirely.
- `flag`: pass through but emit an event for review.

Events are encrypted at rest; the dashboard decrypts on read. Plaintext PII never lands on disk in cleartext.

## Why it matters

Compliance is a one-way valve. Once a customer's credit card hits an unencrypted log, the only fix is "delete everything and email an apology". Safety events catch the most common cases (regex-detectable PII) before they hit logs, prompts, or memory. The encrypted-at-rest store is the safety net for the events themselves.

The per-agent filter set (PIFSP-18) is the difference between "we have one global filter that fits no one" and "each agent declares the categories that matter for its domain". An e-comm chat agent needs credit-card filters; an internal HR agent needs SSN filters; the chat support agent needs both.

## How to use it

### Configure filters

In the agent's safety tab, toggle default categories on/off and add custom regex entries. Each entry has a policy (`redact`, `block`, `flag`). Save; the next turn picks up the new config.

### View safety events

`/orgs/{org}/projects/{project}/env/{env}/agent-governance` lists events by category, agent, and user. Click an event to see the rule hit (decrypted) plus the surrounding context. Filter by date, category, or policy outcome.

### Auto-pause on incident

Wire a webhook on the `safety.event` topic. When a `block` event fires more than N times in M seconds for the same agent, your alerting flips a feature flag (or calls `agents.update` with `isActive: false`) to pause the agent for review.

### Export for compliance

The governance dashboard has an "Export" button. Pick a date range and category set; the runtime returns a signed CSV download with rows in the schema:

```
event_id, ts, scope, agent_id, user_id, category, policy, redacted_match
```

Decrypted on the fly, scoped to the requesting user's permissions.

## Common pitfalls

- Default regex catalog is opinionated. A US phone number regex will miss international formats; pad your custom catalog before relying on default.
- `block` policy throws a turn error. Users see "blocked by safety policy"; the model never sees the input. Consider `redact` for first-party data the agent does need to acknowledge.
- Safety events are encrypted with the same key as messages. Losing `PLATOS_MESSAGE_ENCRYPTION_KEY` loses safety event readability.
- The PII filter runs on the model input, not the model output. Output filtering is a separate pass; configure it via the agent's `outputFilters` config.
- Visitor name and email signed into a session token's `userMeta` claim land in the trace's `user_display_name` / `user_email` columns in plaintext (not message-encrypted). They sit alongside the always-hashed `user_id`, so a GDPR deletion can null the PII columns without breaking trace lookups. See [Auth modes](/docs/auth-modes) and [Traces](/docs/traces).

## Related

- [Approvals and HITL](/docs/approvals-and-hitl): the human-gate complement to automated filters.
- [Audit log](/docs/audit-log): admin actions and tool-call audits, alongside safety events.
- [Encryption and secrets](/docs/encryption-and-secrets): how safety events are encrypted at rest.
