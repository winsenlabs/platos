---
slug: batches
title: Batches
description: Group of trigger.dev runs spawned together. Used by Platos for the agent_batch meta-tool.
category: engine
order: 50
trigger_dev_primitive: true
trigger_dev_link: "https://trigger.dev/docs/v3/triggering"
questions:
  - "What is a batch?"
  - "How do I spawn 100 runs in one call?"
  - "How do I see the status of every run in a batch?"
  - "What is agent_batch and how does it use batches?"
  - "How do I cancel a whole batch?"
related:
  - runs
  - platos-tasks
source_files_referenced:
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.batches/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.batches.$batchParam/route.tsx
  - apps/agent/src/trigger-tasks/agent-batch.task.ts
---

# Batches

A batch is a group of [runs](/docs/runs) spawned in one call. trigger.dev tracks the batch as a parent record so you can monitor and cancel the whole group as one.

Platos uses trigger.dev as the durable execution engine. Batches are a trigger.dev concept that Platos surfaces in the dashboard for visibility. The triggering call (`tasks.batchTrigger`) and the per-run semantics are unchanged from upstream.

## In Platos

The Batches page at `/orgs/{org}/projects/{project}/env/{env}/batches` lists every batch with its size, the per-status counts, and a progress bar. Click into a batch to see every run in the group.

The most common Platos use of batches is the `agent_batch` meta-tool. An agent calls `agent_batch({ items: [...], prompt: "...per item..." })`; the runtime turns each item into one run inside a single batch using `agent-batch.task.ts`. The agent gets one batch id back; the dashboard shows it as one row with progress.

Cancelling a batch cancels every running and queued run inside it. Completed runs stay completed. Cancellation cascades to tool calls each run had in flight.

## Reference

The full reference for batch triggers lives in the trigger.dev docs:

**[trigger.dev/docs/v3/triggering](https://trigger.dev/docs/v3/triggering)**

## Related

- [Runs](/docs/runs): each batch contains many runs.
- [Platos tasks](/docs/platos-tasks): `agent_batch` is the agent-level meta-tool.
