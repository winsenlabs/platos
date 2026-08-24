---
slug: jobs
title: Jobs
description: Platos-owned asynchronous background work and the spawn_job runtime tool.
category: platform
order: 9
questions:
  - "What is a Job?"
  - "How does an Agent start background work?"
  - "How are scheduled Jobs represented?"
related:
  - turns
  - schedules
  - tools
  - domain-vocabulary
---

# Jobs

A **Job** is user-visible, trackable asynchronous work owned by Platos. Jobs belong to an Environment and have a display name, input schema, handler, timeout, retry policy, schedule metadata, status, and optional Agent allow-list.

## Start a Job from an Agent

`spawn_job` is a Platos runtime tool. It accepts a Job identifier and validated input, returns the Job execution identity, and lets the originating Turn continue without waiting for completion.

```json
{
  "jobId": "job_monthly_summary",
  "input": {
    "accountId": "acct_123"
  }
}
```

## Status and retries

A Job uses the standard work statuses: `PENDING`, `ACTIVE`, `SUCCEEDED`, `FAILED`, and `CANCELLED`. Retry count and retry events are Job metadata. Runtime process details are not tenant-owned resources.

## Scheduling

A Job may be started immediately, at a future instant, or on a cron schedule. Time zone and schedule metadata remain on the Job. Disabling a schedule does not delete the Job definition or its history.

## External execution provider

Trigger may execute a Job through an optional external durable-runtime vendor integration. Its identifiers remain private integration metadata. The public Platos resource remains the Job.

## API direction

Use `/jobs` for REST resources, `jobs_*` for platform MCP operations, and `spawn_job` from an Agent. Older names are not public aliases.
