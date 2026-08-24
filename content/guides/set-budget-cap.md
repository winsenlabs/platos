---
slug: set-budget-cap
title: Set a per-agent budget cap
description: Cap daily or monthly spend per agent and decide what happens when the cap hits.
category: recipes
order: 80
questions:
  - "How do I set a daily cap on an agent?"
  - "What happens when the cap is reached?"
  - "Does shadow LLM spend count against the cap?"
  - "How do I get an alert when an agent gets close to its cap?"
related:
  - debug-cost-spike
---

# Set a per-agent budget cap

Cap an agent's spend per day, week, or month. Decide whether to alert-only or hard-block when the cap hits.

## The goal

A budget that fails loud and (optionally) refuses new turns when the cap is exceeded. The cap covers all four cost lanes (model, embeddings, extraction, judge).

## Steps

1. **Open the budgets page.**

   Sidebar -> Budgets (`/agent-budgets`).

2. **New cap.**

   Click "New cap":
   - Agent: pick or "All agents" for env-wide.
   - Period: `daily`, `weekly`, `monthly`.
   - Cap (cents): e.g. `5000` = $50/day.
   - Soft warn (cents): e.g. `4000` = warn at $40.
   - Hard cap: on (block) or off (alert only).

3. **Save.**

   The cap is active immediately. The agent header shows a pill with "X% used today".

4. **Wire alerts (optional).**

   Subscribe a webhook to `budget.soft_warn` and `budget.exceeded`. Tie to your alerting channel.

## Verify

- The agent's header shows the budget pill.
- Crossing the soft warn produces a `budget.soft_warn` webhook.
- Crossing the cap produces a `budget.exceeded` webhook; with hard cap on, the next turn returns `BUDGET_CAP_EXCEEDED` plus the reset time.

## Bypass during incident

```ts
await platos.platos_call("budgets.override", {
  capId,
  bypassUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  reason: "P0 incident workaround",
});
```

Logged in audit.

## Next steps

- [Debug a sudden cost spike](/guides/debug-cost-spike) to find what blew the cap.
- Cap restricted to specific lanes: in the cap settings, set `lanes` to e.g. `["model_inference"]` to leave embeddings unmetered.
