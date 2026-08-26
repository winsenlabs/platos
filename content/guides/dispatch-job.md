---
slug: dispatch-job
title: Create and dispatch a Job
description: Create an Environment-owned Job through the generated REST API and dispatch it through the configured durable runtime.
category: integrations
order: 60
questions:
  - "How do I create a Job through REST?"
  - "How do I dispatch an active Job?"
  - "Does accepted mean completed?"
related:
  - spawn-job
  - trace-a-turn
---

# Create and dispatch a Job

This guide uses the canonical `/api/v1/agent/jobs` contract. It does not require or imply an outbound webhook surface.

## 1. Create the Job

```http
POST /api/v1/agent/jobs
Content-Type: application/json

{
  "jobId": "monthly-report",
  "displayName": "Monthly report",
  "invocationType": "manual",
  "payloadSchema": {
    "type": "object",
    "required": ["accountId"],
    "properties": {
      "accountId": { "type": "string" }
    }
  },
  "handler": "return { accountId: payload.accountId, generated: true };",
  "timeout": 300,
  "maxRetries": 3
}
```

Keep the returned `job.id`. The path parameter used by fetch, update, delete, and dispatch is this persisted identifier; `jobId` is the Environment-scoped external name.

## 2. Dispatch it

```http
POST /api/v1/agent/jobs/{id}/dispatch
Content-Type: application/json

{
  "payload": {
    "accountId": "acct_123"
  }
}
```

Dispatch requires an active Job and a configured external durable-runtime adapter. A response with `accepted: false` means the adapter is not configured. A response with `accepted: true` means the adapter accepted the request; it is not a completion receipt.

## 3. Inspect the definition

```http
GET /api/v1/agent/jobs/{id}
```

The Job resource reports its definition, schedule metadata, enabled state, handler version, and last-started timestamp. Use runtime observability for execution progress; do not treat the Job definition's active state as an execution status.

## MCP equivalents

The platform MCP operations are `jobs.create`, `jobs.get`, `jobs.update`, `jobs.delete`, `jobs.dispatch`, `jobs.set_enabled`, and `jobs.validate_handler`.
