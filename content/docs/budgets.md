---
slug: budgets
title: Budget caps
description: Per-agent and per-environment spend caps that throttle or block turns when the budget is exceeded.
category: governance
order: 20
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How do I set a daily budget cap on an agent?"
  - "What happens when an agent hits its budget?"
  - "How is shadow LLM spend (embeddings, judges) counted?"
  - "Can I set a soft warn before hard cap?"
  - "How does the budget interact with rate limits?"
  - "How do I see remaining budget for an agent?"
related:
  - costs
  - rate-limits
  - safety-and-pii
source_files_referenced:
  - apps/agent/src/monitoring/budget.service.ts
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-budgets._index/route.tsx
  - docs/themes/THEME_H.md
---

# Budget caps

A budget cap is a per-period spend ceiling. When an agent or environment hits its cap, the runtime blocks new turns (and emits a webhook). Caps roll up across the four spend lanes the runtime tracks: model inference, embeddings, LLM-judge evals, and skill metering. Without caps, a runaway prompt loop is a runaway invoice.

## What it is

A `PlatosBudgetCap` row keyed on `(scope, agentId | null, period)`. Carries:

- `period`: `daily`, `weekly`, `monthly`. Wall-clock periods aligned to UTC midnight.
- `capCents`: the limit.
- `softWarnCents`: optional; emits a warn webhook when crossed.
- `hardCap`: when true, blocks turns. When false, alerts only.
- `lanes`: optional; restrict to specific cost lanes (e.g. cap only on `model_inference`, leave embeddings unmetered).

`BudgetService` reads the cap on every turn start and rolls up actual spend from the cost rows. Spend updates land via `CostService`; the cap check is a Redis lookup against a rolling counter, not a Postgres scan.

Override capability: an admin can `POST /agent/v1/budgets/:capId/override` with a `bypassUntil` timestamp to let a single agent run beyond cap during incidents.

## Why it matters

The default LLM cost curve is exponential to the agent. A single prompt with the wrong loop (model calls itself in a tool, model emits a memory write that triggers extraction that calls itself) can spend $1000 in an hour. Budget caps fail loud before that becomes a postmortem. The runtime stops you from shooting yourself in the foot; the cap is the safety on the gun.

Shadow lanes matter because they are easy to miss. A judge eval at $0.01 per call across 50 inputs and 3 criteria is $1.50, just on the eval. If you only cap on `model_inference`, the eval lane runs free. The default cap covers all four lanes; restrict only when you know why.

## How to use it

### Set a cap

`/orgs/{org}/projects/{project}/env/{env}/agent-budgets`. Pick the agent (or "all agents" for env-wide). Set period, cap, optional soft warn, hard cap toggle. Save.

### See remaining budget

The agent detail header shows a budget pill with "X% used today" when a cap exists. Hover for the breakdown by lane. The budgets page shows every cap with current spend.

### When the cap hits

A turn that would exceed the cap is rejected before it dispatches to the model. The agent's response to the user is `BUDGET_CAP_EXCEEDED` plus the reset time (next period boundary). A webhook (`budget.exceeded`) fires; tie it to your alerting.

### Soft warn

Set `softWarnCents` to (say) 80% of cap. A `budget.soft_warn` webhook fires when spend crosses the threshold. The agent keeps running; the warn is informational.

### Bypass during an incident

```ts
await platos.platos_call("budgets.override", {
  capId,
  bypassUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  reason: "P0 incident workaround",
});
```

Logged in the [Audit log](/docs/audit-log).

## Common pitfalls

- Caps roll up wall-clock; a midnight UTC boundary is not your local midnight. Configure your alerting accordingly.
- The cap check is per-turn, not per-tool-call. A single turn that fans out into 100 LLM judge calls can briefly exceed the cap before the post-turn write lands. Use lane restrictions plus aggressive soft-warn for tight bounds.
- Override bypasses the cap, not the rate limit. A capped agent under heavy load is still rate-limited. See [Rate limits](/docs/rate-limits).
- A budget cap on `agentId: null` means "scope-wide". Per-agent caps stack on top; the agent hits whichever fires first.

## Related

- [Costs](/docs/costs): the per-lane spend rollup the cap reads from.
- [Rate limits](/docs/rate-limits): the orthogonal axis (RPS, not dollars).
- [Safety and PII](/docs/safety-and-pii): the broader governance surface.
