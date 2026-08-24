---
slug: spawn-job
title: Start background work with spawn_job
description: Define a Job, allow an Agent to use it, and start it from a Turn.
category: recipes
order: 8
questions:
  - "How do I start a Job from an Agent?"
  - "How do I validate Job input?"
related:
  - jobs
  - tools
  - trace-a-turn
---

# Start background work with `spawn_job`

Use a Job when work should continue independently from the originating Turn.

## 1. Define the Job

Create a Job in the target Environment. Give it a stable name, a handler, a timeout, a retry limit, and a JSON Schema for accepted input.

## 2. Allow the Agent

Add the Agent identifier to the Job's allow-list. The runtime rejects requests from other Agents before scheduling work.

## 3. Start the Job

Ask the Agent to call the `spawn_job` runtime tool:

```json
{
  "jobId": "job_report",
  "input": {
    "customerId": "cus_123",
    "month": "2026-08"
  }
}
```

The tool returns a Job execution identity. Store it if your UI needs to link the originating Turn to the background work.

## 4. Observe completion

Watch the Job status and correlated trace. A failed Job records retry metadata and a safe error. Do not infer completion from the originating Turn; the Turn may complete before the Job.
