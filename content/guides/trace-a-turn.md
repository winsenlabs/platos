---
slug: trace-a-turn
title: Trace a single turn end to end
description: Open the trace view, walk the spans, and find the slow tool.
category: troubleshooting
order: 10
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "Where do I open the trace view for a turn?"
  - "How do I find the slowest span?"
  - "Why does my trace show extra LLM calls I didn't make?"
  - "How do I correlate a span with a run?"
related:
  - debug-cost-spike
  - chat-stream-disconnects
source_files_referenced:
  - apps/agent/src/monitoring/trace.service.ts
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.trace.$threadId/route.tsx
---

# Trace a single turn end to end

Open the trace view for a slow or unexpected turn. Find the slowest span. Confirm the cost vs the time taken.

## The goal

A clear answer to "why did this turn take 12 seconds and cost 3 cents?". The trace shows you exactly which spans took the time and which model calls happened.

## Steps

1. **Find the turn.**

   Chat panel -> click the timestamp on a message -> "View trace". Or navigate directly: `/agents/{agentId}/trace/{threadId}` and scroll to the turn.

2. **Read the waterfall.**

   Top span: the turn root (`turn.run`). Children:
   - `prompt.assemble` (with cache-hit attributes).
   - `model.call` (with `costCents`, token counts, finish reason).
   - `tool.call.start` -> `tool.call.execute` -> `tool.call.result` (one per tool call).
   - `memory.recall` and `memory.write` if the agent uses them.

3. **Find the slowest.**

   Sort by duration. The slowest span is usually one of:
   - A long tool call (entity backend was slow).
   - A long model call (large prompt or large output).
   - A retrieval round-trip (slow embedding + search).

4. **Drill in.**

   Click the slow span. Attributes show what happened. For tool calls, link out to the [audit log](/docs/audit-log) entry to see decrypted args.

5. **Cross-link to the run.**

   If the turn spawned a BGO, the trace has a `bgo.spawn` span. Click it; jump to the [Runs](/docs/runs) page for the underlying engine run.

## Verify

- Sum of model.call `costCents` matches the cost in the [Costs](/docs/costs) view (small drift acceptable).
- Total turn duration matches what you saw in the chat panel.

## Common findings

- Many small model calls vs one big one usually means a sub-agent loop. Inspect the agent's `subAgentConfig`.
- Repeated `memory.recall` spans mean the model is calling recall multiple times per turn. Tune the recall block in [Prompts](/docs/prompts).
- A tool with intermittent slow times shows as a wide variance in duration; instrument inside the entity backend.

## Next steps

- [Debug a sudden cost spike](/guides/debug-cost-spike).
- [Recover a stuck run](/guides/recover-stuck-run).
