---
slug: costs
title: Costs and spend
description: How Platos counts every input + output token, plus shadow spend on embeddings, extraction, and judge calls.
category: observability
order: 30
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How are token costs calculated?"
  - "Where do model prices come from?"
  - "How is shadow LLM spend (embedding, extraction, eval judge) tracked?"
  - "How do I export cost data to my own warehouse?"
  - "Can I see cost broken down by skill?"
  - "How do reconcile jobs catch missed costs?"
related:
  - monitoring
  - budgets
  - models
source_files_referenced:
  - apps/agent/src/monitoring/cost.service.ts
  - apps/agent/src/monitoring/cost.service.test.ts
---

# Costs and spend

Platos tracks every token spent across four lanes: model inference (the chat turn), embeddings (memory writes, retrieval), extraction (memory and graph), and judges (eval criteria). Each is a row in the cost table with `(scope, agentId, threadId, lane, model, inputTokens, outputTokens, cachedTokens, costCents)`. Reconciliation jobs catch what live tracking misses.

## What it is

`CostService` records per-token cost on every model call. The model price is read from the model catalogue at call time; cached tokens are priced separately at the provider's cache rate.

### Where prices come from

Three layers, most authoritative last:

1. **LiteLLM's public price map**, refreshed daily by a scheduled task into the `cost:model_catalog` Redis key. It has broad coverage and is the baseline for models nobody has hand-checked.
2. **Verified overrides** in `verified-prices.ts` — rates read off the provider's own pricing page and committed with the date they were checked. LiteLLM lags provider price cuts by weeks and has been wrong by an order of magnitude on newly released models, so any model you actually spend money on belongs here. An override always wins over the fetched map.
3. **The rate recorded on the row itself.** Every cost row stores the unit rates it was priced with, not just the resulting cents. Prices change; a re-priced history would silently rewrite what you were billed. Historical charts read the rate as it stood at the time.

Cache rates are tracked as their own multipliers because they are not a fixed fraction of the input rate. Reads are typically 0.1× input, but writes are *more expensive than input* — 1.25× on Anthropic, and as much as 2.5× elsewhere. Pricing a cache write at the input rate understates a cache-heavy agent's real spend.

Cost rows are written:

- **At turn time**: per-call rows attribute live spend to a thread + agent.
- **At extraction time**: extraction calls a model (or an embedding endpoint) and writes a row tagged `lane: extraction` or `lane: embedding`.
- **At eval time**: each judge criterion call writes a row tagged `lane: judge`.
- **Reconcile**: PPR-24 scheduled task pulls provider billing data where available and writes drift rows tagged `lane: reconcile_drift`.

The cost rollups feed [Monitoring](/docs/monitoring), [Budgets](/docs/budgets), and the per-agent cost charts. Per-skill rollups (the `monitoring/cost/skills/daily` and `range` endpoints) attribute spend to specific skills.

### What counts as a task

A **task** is one completed unit of work the agent did for a user — a turn that ran to completion. It is not a model call and not a tool call. An agent that searches, reads three documents, and replies has done *one* task while writing five or six cost rows.

Every surface that reports task counts derives them from `billable-usage.ts`. Counting rows instead inflates the number by whatever factor the agent happens to be tool-heavy that week, which produces the same agent looking several times busier after a prompt change that touched nothing a user would notice.

Cost and task count therefore answer different questions and should not be expected to move together: cost scales with tokens, task count with completed work.

## Why it matters

Most "why is the agent expensive" investigations stop at "the chat is using the big model". The shadow lanes are where the surprise lives:

- A high-cardinality `entity_ids` array nukes prompt cache and triples per-turn cost.
- A noisy memory extraction policy runs an embedding plus a model call after every turn.
- An eager eval auto-run on save can multiply spend silently.

Splitting these into lanes makes each one budgetable and visible.

## How to use it

### See spend by agent

`/orgs/{org}/projects/{project}/env/{env}/agent-monitoring` -> Agents tab. Each row shows 7-day cost. Drill into per-version split.

### See spend by lane

`GET /agent/v1/monitoring/cost?agent={agentId}&groupBy=lane` returns per-lane totals. Useful for "is the cost in the chat turn or in extraction?".

### Per-skill cost

The skills cost page (PIFSP-13) shows per-skill spend, useful when comparing platos-rag, code-runner, and image-generation usage.

### Export to warehouse

`GET /agent/v1/monitoring/cost?format=csv&from=...&to=...` streams a CSV with per-row cost data. Pipe into your warehouse for finer slicing.

### Reconcile

The reconcile schedule runs nightly. The reconcile cost page on monitoring shows drift between live-tracked spend and reconciled provider data; large drift means a missed cost row, usually from a cancelled turn or a stream that aborted before the post-call write.

## Common pitfalls

- Cached tokens are cheaper but still counted. A cache-friendly turn at $0.005 vs an uncached one at $0.025 is still $0.005, not $0. Watch the cache-hit-rate column.
- Reconcile drift is normal at the cents level (provider rounding). Drift in the dollars is a real problem; investigate via [Traces](/docs/traces).
- Per-skill costs depend on the skill's tools writing cost rows in turn. A custom skill that calls the model directly (bypassing `CostService`) will have its spend attributed to the lane it called from, not to the skill name. Always go through `CostService`.
- Eval judge cost can dwarf model cost on a 50-input run with three criteria. Cap with budget caps; preview cost via the eval's preview endpoint.

## Related

- [Monitoring](/docs/monitoring): the per-agent and per-user rollup.
- [Budgets](/docs/budgets): the cap that fires off cost rollups.
- [Models](/docs/models): the catalogue that holds prices.
