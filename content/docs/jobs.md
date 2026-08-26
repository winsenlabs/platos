---
slug: jobs
title: Jobs
description: Environment-owned asynchronous definitions, jobs.* platform operations, and the spawn_job runtime tool.
category: platform
order: 9
questions:
  - "What is a Job?"
  - "How do I create and dispatch a Job?"
  - "What payload does spawn_job accept?"
related:
  - turns
  - schedules
  - tools
  - domain-vocabulary
---

# Jobs

A **Job** is Environment-owned asynchronous work. A persisted Job definition has an external `jobId`, display name, CommonJS handler source, payload schema, timeout, retry policy, invocation type, optional schedule metadata, status, and optional Agent allow-list.

## Persisted Job definitions

Create a definition through `POST /api/v1/agent/jobs` or `jobs.create`:

```http
POST /api/v1/agent/jobs
Content-Type: application/json

{
  "jobId": "monthly-summary",
  "displayName": "Monthly summary",
  "invocationType": "manual",
  "payloadSchema": {
    "type": "object",
    "required": ["accountId"],
    "properties": {
      "accountId": { "type": "string" }
    }
  },
  "handler": "return { accountId: payload.accountId, complete: true };",
  "timeout": 300,
  "maxRetries": 3
}
```

The REST collection supports `GET` and `POST`; `/jobs/{id}` supports `GET`, `PATCH`, and `DELETE`; `/jobs/{id}/dispatch` accepts `{ "payload": { ... } }`. The `{id}` parameter is the persisted `job.id`, while `jobId` is its Environment-scoped external name.

Platform MCP exposes `jobs.list`, `jobs.get`, `jobs.create`, `jobs.update`, `jobs.delete`, `jobs.dispatch`, `jobs.set_enabled`, and `jobs.validate_handler`.

## The `spawn_job` runtime tool

`spawn_job` is an Agent runtime tool for background instructions. Its source contract requires `jobType` and `instruction`; `tools` and `timeout` are optional:

```json
{
  "jobType": "monthly-summary",
  "instruction": "Summarize account acct_123 for August 2026.",
  "tools": ["billing.list_invoices"],
  "timeout": "5m"
}
```

The tool returns `spawned`, `durable`, `jobId`, `jobType`, and a message. `durable: true` means the configured external durable-runtime adapter accepted the work. Without that adapter, the local Redis runtime returns `durable: false` and retains the queued record for 24 hours.

`spawn_job` does not accept the persisted Job dispatch shape `{ jobId, input }`. To dispatch a persisted definition with schema-validated payload, use `POST /api/v1/agent/jobs/{id}/dispatch` or `jobs.dispatch`.

## Status and scheduling

Persisted Job definitions use `PENDING`, `ACTIVE`, `SUCCEEDED`, `FAILED`, and `CANCELLED` storage states. `isActive` projects whether the definition is dispatchable; it is not a completion state for an individual execution.

Invocation types are `manual`, `schedule`, `webhook`, and `agent-spawn`. Schedule cron and time zone remain on the Job definition. The current public API does not provide a general outbound webhook delivery surface.

## External execution provider

Trigger may execute Job work through the optional external durable-runtime vendor adapter. Its identifiers remain private integration metadata; the public resource remains the Platos Job.
