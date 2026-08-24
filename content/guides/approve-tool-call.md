---
slug: approve-tool-call
title: Add a human approval gate to a tool
description: Mark a tool as needing approval, then approve or reject from the inbox or via webhook.
category: recipes
order: 70
questions:
  - "How do I require approval for a destructive tool?"
  - "How is request_durable_approval different from a regular approval?"
  - "Where does the approver see pending requests?"
  - "Can I auto-approve based on the args?"
  - "How do I expire an unapproved request?"
related:
  - spawn-job
  - filter-pii
---

# Add a human approval gate to a tool

Pause a tool call until a human approves. Two flavours: inline (chat waits a few minutes) and durable (Job waits hours-to-days).

## The goal

A destructive tool like `refund_payment` cannot fire without an explicit human approval. The approver sees a card, picks approve or deny, and the tool resumes (or returns an error) with the decision.

## Steps (inline)

1. **Mark the tool.**

   Agent -> Tools tab -> find the tool -> "Per-tool perms" -> set `requiresApproval: true` (and `destructive: true` for the stronger UI badge). Save.

2. **The agent calls the tool.**

   The runtime opens an approval card. The chat panel shows "waiting for approval". Approver sees the card on `/approvals`.

3. **Approver decides.**

   `/approvals` -> click the request -> Approve or Deny with a reason. The tool resumes; the chat continues.

## Steps (durable)

For long waits, the agent calls the meta-tool:

```text
request_durable_approval({
  tool: "refund_payment",
  args: { customer_id: "cust_123", amount_cents: 5000 },
  policy: { timeout: "48h", autoDenyOnTimeout: true }
})
```

The runtime opens a [waiting state](/docs/approvals-and-hitl), sends a notification (Slack DM, email, dashboard alert), and the execution pauses. Resumes when an approver clicks the link or hits `POST /api/v1/agent/durable-approvals/:token/resolve`.

## Verify

- The agent's chat panel shows "waiting for approval" until decision.
- The audit log records the decision with actor + reason.
- A 48-hour pending durable approval auto-denies on the timeout.

## Auto-approve based on args

Wire a webhook on `approval.requested`. Your handler reads the safe argument summary, decides, and calls `POST /api/v1/agent/approvals/{approvalId}/resolve` when the conditions match. The dashboard records the machine actor.

## Next steps

- [Filter PII](/guides/filter-pii) to redact args before they hit the approval card.
- [Spawn a Job](/guides/spawn-job) -> approval pattern: Job does the work, approval gates the publish step.
