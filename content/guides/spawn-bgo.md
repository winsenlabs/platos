---
slug: spawn-bgo
title: Spawn a long-running task (BGO)
description: Use the spawn_bgo meta-tool to kick off durable work that exceeds a single turn.
category: recipes
order: 50
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "When should I use spawn_bgo vs an inline tool call?"
  - "How does the BGO post results back to the conversation?"
  - "How do I list all running BGOs?"
  - "How do I cancel a BGO?"
  - "What is the spawn_task alias and when does it go away?"
related:
  - schedule-recurring-task
  - approve-tool-call
source_files_referenced:
  - apps/agent/src/agent-runtime/agent.service.ts
  - apps/agent/src/trigger-tasks/agent-tool-block.task.ts
  - docs/BGO_RENAME.md
---

# Spawn a long-running task (BGO)

Kick off durable background work the agent does not want to wait for.

## The goal

A chat turn returns immediately ("started, BGO id is X") while the actual work runs in the engine for minutes or hours, posting its result back as a fresh message in the same thread when ready.

## When to use

- Inline tool call: <30 seconds, the user is happy to wait.
- BGO: longer than 30 seconds, or wants to survive deploys, restarts, or user disconnects. "Render this PDF", "wait for the customer's email reply", "process this 30k-row CSV".

## Steps

1. **Ensure the agent has the meta-tool enabled.**

   On the agent, Tools tab. Confirm `spawn_bgo` is on. Default for new agents.

2. **Prompt the agent to dispatch.**

   "Render the slides into a PDF and reply when ready."

   The model issues:

   ```text
   spawn_bgo({
     prompt: "Render the slides into a PDF and reply in the thread when ready",
     threadId: currentThread,
     idempotencyKey: "render-slides-2025-05-04"
   })
   ```

3. **Watch the BGO.**

   The agent gets a tool result with the BGO id. The chat continues. In the dashboard, `/platos-tasks` lists the BGO with status `running`.

4. **Receive the result.**

   When the BGO finishes, it writes a new message to the same thread. The chat panel renders the message; the user is notified.

## Verify

- The chat turn returns within seconds even when the BGO has not finished.
- `/platos-tasks` shows the BGO status updates in real time.
- The BGO's eventual message appears in the original thread, attributed to the BGO agent (or cluster member).

## Cancel

`/platos-tasks` -> click the BGO -> Cancel. The engine cancels; the runtime writes a synthetic "cancelled" message to the thread.

## Idempotency

Always pass `idempotencyKey`. A retried tool call without one spawns a second BGO; the engine cannot deduplicate without the key.

## spawn_task alias

`spawn_task` is the deprecated alias for `spawn_bgo`. Both work during the rename grace window. Drift D-002 noted the alias has lived past its one-release deadline; customer prompts should mention `spawn_bgo`.

## Next steps

- [Schedule a recurring task](/guides/schedule-recurring-task) for cron-style BGOs.
- [Add a human approval gate](/guides/approve-tool-call) for BGOs that touch production data.
