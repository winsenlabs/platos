---
slug: spawn-job
title: Start background work with spawn_job
description: Call the runtime tool with its source-defined jobType, instruction, tools, and timeout payload.
category: recipes
order: 8
questions:
  - "What payload does spawn_job accept?"
  - "How do I dispatch a persisted Job instead?"
related:
  - jobs
  - tools
  - trace-a-turn
---

# Start background work with `spawn_job`

Use `spawn_job` when an Agent should continue background work independently from the originating Turn.

## Runtime-tool payload

Ask the Agent to call the tool with the schema implemented by `agent.service.ts`:

```json
{
  "jobType": "customer-report",
  "instruction": "Prepare the August report for customer cus_123.",
  "tools": ["billing.list_invoices", "crm.get_customer"],
  "timeout": "10m"
}
```

- `jobType`: required string identifying the kind of background work.
- `instruction`: required description of what the Job must do.
- `tools`: optional tool-name allow-list.
- `timeout`: optional duration string; defaults to `5m`.

A successful result includes:

```json
{
  "spawned": true,
  "durable": true,
  "jobId": "7e9ba50a-54a5-4f40-8c30-23cd14bf9960",
  "jobType": "customer-report",
  "message": "Job \"customer-report\" was accepted by the durable runtime."
}
```

When no external durable-runtime adapter is configured, the local Redis path returns `durable: false`. The originating Turn may complete before the background work.

## Persisted Job definitions use another operation

Do not call `spawn_job` with `{ jobId, input }`; that is not its runtime schema. To dispatch an Environment-owned Job definition, call:

```http
POST /api/v1/agent/jobs/{id}/dispatch
Content-Type: application/json

{
  "payload": {
    "customerId": "cus_123",
    "month": "2026-08"
  }
}
```

The equivalent platform MCP operation is `jobs.dispatch` with `{ id, payload }`.
