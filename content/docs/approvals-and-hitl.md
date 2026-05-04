---
slug: approvals-and-hitl
title: Approvals and HITL
description: Pause a tool call until a human approves or rejects, with durable waitpoints that survive restarts.
category: governance
order: 10
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How do I add a human approval gate to a tool?"
  - "What is the difference between an inline approval and request_durable_approval?"
  - "How long can a pending approval stay open?"
  - "Where do I see all pending approvals across agents?"
  - "How do approvals interact with cost caps?"
  - "Can an approval auto-expire?"
related:
  - safety-and-pii
  - waitpoints
  - tools
source_files_referenced:
  - apps/agent/src/monitoring/approvals.service.ts
  - apps/agent/src/monitoring/approval-keys.ts
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.approvals._index/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.approvals.$approvalId/route.tsx
---

# Approvals and HITL

Approvals pause a tool call until a human approves or rejects. Two flavours: inline approvals (the chat turn waits at most a few minutes) and durable approvals (the run waits hours-to-days, surviving restarts). Both write into the same `PlatosApproval` table and surface on the same dashboard.

## What it is

A `PlatosApproval` row keyed on `(scope, agentId, toolCallId)`. Carries:

- `requester`: the agent and the user behind the request.
- `tool` and `args`: the tool and arguments the agent wants to invoke.
- `policy`: who can approve, the approval timeout, the auto-deny on timeout flag.
- `state`: `pending`, `approved`, `denied`, `expired`.
- `decision`: who decided, when, and why.

Two paths into the row:

- **Inline approval**: triggered by a tool's `requiresApproval: true` flag in the agent's `toolsBlockConfig.perToolPerms`. The turn pauses; the approver picks "approve" or "deny" from the dashboard alert; the tool call resumes (or returns an error) and the turn continues. The wait is a normal blocking wait, capped at minutes.
- **Durable approval**: the agent calls the `request_durable_approval` meta-tool. The runtime opens a [waitpoint](/docs/waitpoints) and writes the row; the run can hold for hours-to-days. Resumes when an operator resolves via dashboard, email click-through, or API.

The expiry sweep (PPR-67 scheduled task) auto-expires pending approvals past their SLA and resolves the waitpoint with a synthetic deny.

## Why it matters

Some tool calls cannot be left to the model. Sending a $10k refund, deleting a customer record, posting to a public channel: each one wants a human in the loop. Without approvals, the only options are "the tool is always on" or "the tool is always off". With approvals, you get a third option: "the tool is on but a human signs off each time".

Durable approvals open the door to async patterns. The agent kicks off "wait for the customer to confirm by email", the run pauses at the waitpoint, and the approve link in the email completes the token when the customer clicks. No webhook plumbing on your side; the engine layer owns the durable wait.

## How to use it

### Gate a single tool

In the agent's tools tab, find the tool, expand its row, set `requiresApproval: true`. Optionally set `destructive: true` to render a stronger UI badge. The next turn that calls this tool pauses; the approver sees a card on the agent's monitoring page.

### Approve from the dashboard

`/orgs/{org}/projects/{project}/env/{env}/approvals` lists every pending approval. Click an approval to see the full request: the user message, the tool, the args (with PII redaction). Approve or deny with a reason. The agent receives the decision and continues.

### Approve from MCP / API

```ts
await platos.platos_call("approvals.resolve", {
  approvalId,
  decision: "approve",
  reason: "manual review passed",
});
```

For durable approvals: `POST /agent/v1/durable-approvals/:token/resolve` with the same body. The token is the waitpoint id, surfaced on the approval row.

### Auto-expire

Set `policy.timeout = "30m"` and `policy.autoDenyOnTimeout: true`. The expiry sweep cancels the waitpoint and writes a synthetic deny after 30 minutes if no human resolved it.

### Cost interaction

Approvals do not pause cost. Token spend on the in-flight turn keeps accruing while the approval waits. For durable approvals, the run holds (no LLM spend) but the waitpoint itself has no cost. See [Budgets](/docs/budgets) for the cap interaction.

## Common pitfalls

- Approve / deny is per tool call, not per session. The next call to the same tool will pause again. If you want session-wide trust, wrap the gate in your prompt logic or remove the approval flag.
- Durable approvals require the engine layer to be running. A self-host with a paused trigger.dev queue silently never resumes durable approvals; check the [Queues](/docs/queues) page.
- The dashboard's approval card shows tool args with PII redaction. The full args are always available in the audit log; redaction is presentation-only.
- Inline approvals contend with chat-turn timeouts. A non-responsive approver blocks the chat for the turn timeout (default 10 minutes); the user sees a "waiting on approval" indicator. Use durable approvals for anything that should be allowed to take longer.

## Related

- [Safety and PII](/docs/safety-and-pii): PII filters that fire alongside approvals.
- [Waitpoints](/docs/waitpoints): the durable engine primitive that backs `request_durable_approval`.
- [Tools](/docs/tools): the per-tool `perToolPerms` config that gates approval.
