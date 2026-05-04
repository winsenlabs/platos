---
slug: debug-cost-spike
title: Debug a sudden cost spike
description: Drill from the cost dashboard into the run that caused the spike.
category: troubleshooting
order: 20
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "Why did my spend triple yesterday?"
  - "How do I find the agent or user that caused a cost spike?"
  - "How is shadow LLM spend (embeddings, judges) shown?"
  - "How do I roll back the agent version that caused the spike?"
related:
  - trace-a-turn
  - set-budget-cap
source_files_referenced:
  - apps/agent/src/monitoring/cost.service.ts
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-monitoring._index/route.tsx
---

# Debug a sudden cost spike

Yesterday's spend tripled. Find why and stop the bleeding.

## The goal

Identify the agent, user, or version responsible. Take action: roll back, cap, or pause.

## Steps

1. **Open the cost dashboard.**

   Sidebar -> Monitoring -> index page. The chart shows daily spend by agent. The spike's date stands out.

2. **Drill by agent.**

   Click the spike day. The breakdown shows top agents. The leader is your suspect.

3. **Drill by lane.**

   Click the suspect agent. Cost by lane shows whether the spike is in `model_inference`, `embedding`, `extraction`, or `judge`. The lane tells you what to suspect:
   - `model_inference` up: a prompt change increased per-turn cost or volume increased.
   - `embedding` up: extraction is over-firing or memory imports happened.
   - `extraction` up: the extractor's policy got chatty.
   - `judge` up: an auto-eval started running on every save.

4. **Drill by user.**

   Same dashboard, switch to "Top users". A single user dominating the agent's spend is likely a bot or a leaking integration.

5. **Drill into a turn.**

   Pick the most expensive thread of the day. Click into [Traces](/docs/traces). Find the slowest model.call span; check whether the prompt is unexpectedly large.

6. **Roll back if it was a version regression.**

   Compare timestamps: if the spike correlates with an agent version save, [Rollback](/guides/version-and-rollback) to the previous version.

7. **Cap.**

   Even if you fix the root cause, [Set a budget cap](/guides/set-budget-cap) so a future regression fails loud, not silent.

## Verify

- Post-rollback, daily spend returns to baseline.
- The cap fires alerts when you exceed expected normal-day spend.

## Common findings

- Auto-eval on save was enabled and a new version triggered a 50-input judge run.
- A user's session was held open and the chat client was retrying every 2 seconds.
- A new tool returned huge results inflating the next turn's prompt.
- Memory extraction policy moved from `batched` to `post-turn`.

## Next steps

- [Set a budget cap](/guides/set-budget-cap).
- [Trace a single turn](/guides/trace-a-turn) for forensic detail on a specific spike.
