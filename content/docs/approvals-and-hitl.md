---
slug: approvals-and-hitl
title: Approvals and human review
description: Pause a Tool Call while a human approves or rejects the requested action.
category: governance
order: 4
questions:
  - "How do Tool Call approvals work?"
  - "What happens while an approval is pending?"
related:
  - tools
  - turns
  - audit-log
  - budgets
---

# Approvals and human review

An approval belongs to the Tool Call that requested a sensitive action. It records the owning Environment, Agent, Thread, Turn, requested capability, safe argument summary, status, expiry, and actor metadata.

## Status

Approval status is `PENDING`, `APPROVED`, `REJECTED`, or `EXPIRED`. While review is pending, the owning Turn or Job remains in its normal work status. Platos does not expose a separate waiting resource.

## Resolve an approval

```http
POST /api/v1/agent/approvals/{approvalId}/resolve
Content-Type: application/json

{"decision":"approved"}
```

The runtime verifies the operator's persisted scope before resolving the approval. Resolution is idempotent and writes an audit record.

## Durable review

Long review windows can be delegated to the configured durable-execution provider. Vendor state remains private integration metadata; the public approval and owning Turn or Job stay authoritative.

Expiry denies the Tool Call by default. An approval never widens the Agent's tool policy or the caller's tenancy scope.
