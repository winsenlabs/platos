---
slug: platos-tasks
title: Platos tasks (BGOs)
description: Long-running background operations spawned from agents via the spawn_bgo meta-tool.
category: platform
order: 200
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "What is a BGO and how is it different from an engine-layer task?"
  - "How do I spawn a BGO from an agent's tool call?"
  - "What is spawn_bgo and where is the deprecated spawn_task alias going?"
  - "How does a BGO post results back into the conversation?"
  - "Can I schedule a BGO to run later?"
  - "How do I list active BGOs for an agent?"
  - "How is a BGO sandboxed when it runs untrusted code?"
related:
  - runs
  - schedules
  - agent-clusters
  - tools
source_files_referenced:
  - apps/agent/src/agent-runtime/platos-tasks.controller.ts
  - apps/agent/src/agent-runtime/agent-task.service.ts
  - apps/agent/src/agent-runtime/agent.service.ts
  - apps/agent/src/trigger-tasks/agent-tool-block.task.ts
  - apps/agent/src/trigger-tasks/agent-batch.task.ts
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.platos-tasks._index/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.platos-tasks.new/route.tsx
  - docs/BGO_RENAME.md
---

# Platos tasks (BGOs)

A BGO ("background operation") is a long-running unit of work an agent dispatches and forgets about. The agent calls `spawn_bgo`, the runtime queues a trigger.dev task, and the BGO runs to completion (minutes to days), posting results back into the originating conversation when it finishes. Use them for "render this PDF", "scrape this site", "wait for the customer to reply".

## What it is

A `PlatosTask` row plus a backing trigger.dev task run. The Platos row owns the agent-facing metadata (the originating thread, the meta-tool args, the optional `idempotencyKey`); the trigger.dev run owns the durable execution semantics (retries, attempts, cancellation, machine size).

The naming is a deliberate split. At the engine layer, the primitive is a "task" (trigger.dev's own concept; see [Runs](/docs/runs)). At the Platos surface, an agent calls `spawn_bgo` and reads `list_bgos`. The deprecated `spawn_task` alias still works during the rename grace window and routes to the same code path.

`agent-tool-block.task.ts` is the canonical BGO template: it spins up a sub-agent turn loop with a restricted tool subset, runs to completion, and writes the result back as a message in the parent thread.

`agent-batch.task.ts` is the `agent_batch` meta-tool's backing task: same pattern but loops one turn per item in a list (CSV row, search result page, etc.) with an internal cap.

## Why it matters

LLM tool calls have a tight latency budget. A turn that waits 90 seconds for an external API blocks the chat stream and ties up a model context. BGOs invert it: the chat returns immediately ("started", here is the BGO id), the BGO runs in the durable engine, and the result lands as a fresh message when ready.

Durable means restart-safe. A trigger.dev task survives an agent service restart, a Platos deploy, even a Postgres restart (with idempotency-keyed). That guarantee is what makes BGOs viable for "wait for the customer's email" scenarios.

## How to use it

### Spawn from the agent

The agent calls the meta-tool:

```text
spawn_bgo({
  prompt: "Render the slides into a PDF and reply when ready",
  threadId: currentThread,
  idempotencyKey: "render-slides-2025-05-04",
})
```

The runtime queues a trigger.dev task. The agent gets a tool result with the BGO id. The conversation continues. When the BGO writes its final message, it lands as a new message in the same thread, attributed to the BGO agent (in a [cluster](/docs/agent-clusters), the cluster member; otherwise the same agent).

### Schedule for later

`schedule_bgo({ prompt, runAt: "2025-05-05T09:00Z" })` enqueues with a delay. Same shape as `spawn_bgo`, plus a future timestamp. Backed by `wait.forToken` under the hood (see [Waitpoints](/docs/waitpoints)).

### List active BGOs

The agent calls `list_bgos({ threadId? })` to enumerate active BGOs. The dashboard surfaces the same list at `/orgs/{org}/projects/{project}/env/{env}/platos-tasks` with status filters (queued, running, completed, failed).

### Author a BGO from the dashboard

PIFSP-12 added in-dashboard BGO authoring with a vm2 sandbox. Navigate to `/platos-tasks/new`, write the BGO body in TypeScript or via a code-runner skill, configure inputs, and save. The runtime registers it as a callable BGO that agents can dispatch by name.

## Common pitfalls

- `spawn_bgo` and `spawn_task` both default on for new agents during the rename grace window (drift D-002). Customer prompts should mention `spawn_bgo`; `spawn_task` will be removed in a future release.
- Idempotency keys are strongly recommended. A retried tool call without an idempotency key spawns a second BGO; the engine layer cannot deduplicate at this layer.
- BGO output is a message; it is not magic. The model running the BGO has to call `messages.create` (or its equivalent) to write back. The default `agent-tool-block.task.ts` does this for you.
- Stop is two-step. Cancelling the trigger.dev run cancels the engine; the agent runtime detects the cancel and writes a synthetic "cancelled" message into the thread. If the engine cancel races with a final write, you can see both. Reconcile via the audit log.

## Related

- [Runs](/docs/runs): the engine-layer surface that backs every BGO.
- [Schedules](/docs/schedules): for cron-style BGOs (different primitive, related goals).
- [Agent clusters](/docs/agent-clusters): cross-agent BGO dispatch.
- [Tools](/docs/tools): `spawn_bgo`, `list_bgos`, `schedule_bgo`, `agent_batch` are meta-tools.
