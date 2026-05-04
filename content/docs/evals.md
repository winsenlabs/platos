---
slug: evals
title: Evals
description: Define eval criteria once, run them against golden sets, and see ratings roll up per agent.
category: platform
order: 160
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "What is an eval criterion?"
  - "How do I build a golden set?"
  - "How do I rate a single message as good/bad?"
  - "What is the LLM-judge eval and how is its cost tracked?"
  - "How do criteria compose into a suite?"
  - "Can I run evals automatically on every new agent version?"
related:
  - evals-ab
  - agents
  - metrics
source_files_referenced:
  - apps/agent/src/evals/eval.service.ts
  - apps/agent/src/evals/criterion.service.ts
  - apps/agent/src/evals/golden-set.service.ts
  - apps/agent/src/evals/rating.service.ts
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-evals._index/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.eval-criteria._index/route.tsx
  - docs/themes/THEME_J.md
---

# Evals

An eval is how you turn "I think the agent got better" into a number. Platos's eval framework has three primitives: criteria (what to measure), golden sets (what to measure on), and runs (the act of running both against an agent version). Ratings on real conversation messages feed the same loop, so you do not need a synthetic golden set to start.

## What it is

Three tables tied together:

- `PlatosEvalCriterion`: a named scoring rule with a type (`llm_judge`, `keyword_match`, `regex`, `cost_under`, `latency_under`), a config blob, and a target score range. LLM-judge criteria carry a model id and a judge prompt; the cost of running the judge is tracked separately on the [Costs](/docs/costs) page.
- `PlatosGoldenSet`: a set of inputs (user messages) and optional expected outputs. Sets can be hand-built or scraped from real conversations.
- `PlatosEval`: a run instance. Holds `(agentVersionId, goldenSetId, criteriaIds[])` and the per-input scores. `EvalService` orchestrates running every input through the agent version and scoring it against each criterion.

`RatingService` is the per-message complement. A user (or admin) thumbs-up/down a real message, optional reason, and the rating cascades into the message row, the memory row(s) it pulled from, and the per-agent satisfaction rollup.

## Why it matters

Prompt regressions are silent. A change that made the agent cheaper to run may have also made it less accurate at one specific task; ratings on real messages catch the obvious cases, but rare-but-important regressions need a fixed input set.

The framework is intentionally simple: criteria are first-class so you can compose them, golden sets are just lists so you can grow them, runs are immutable so you can compare versions historically. No DSL, no test harness, just three tables.

## How to use it

### Build a criterion

`/orgs/{org}/projects/{project}/env/{env}/eval-criteria` -> "New criterion". Pick the type:

- `llm_judge`: write a judge prompt like "On a scale of 1-5, how concise is this reply?". Pick the judge model.
- `keyword_match`: declare required and forbidden keywords.
- `regex`: declare a pattern that the reply must match.
- `cost_under` / `latency_under`: numeric thresholds.

### Build a golden set

`/agent-evals` shows existing sets. Create a new one and add inputs. You can paste inputs by hand, import from CSV, or check "include rated messages" to seed the set from thumbs-up messages on the agent.

### Run an eval

From the agent's evals tab, pick a version, a golden set, and the criteria to run. Click "Run". The runtime queues a turn per input, evaluates each criterion, and writes per-input scores plus an aggregate. Streaming progress is shown live; results land at `/agent-evals/{evalId}`.

### Rate live messages

Every message in the chat panel has a thumbs-up/thumbs-down. Rating writes to `PlatosMessageRating`, which feeds:

- The agent satisfaction chart at `/agent-monitoring`.
- The memory feedback loop (good ratings boost memory ranking; bad ratings dock).
- A pre-built golden set "Rated up" / "Rated down" you can run regressions against.

### Auto-run on version save

Set `featureFlags.autoEvalOnSave = true` on the agent. Each new version triggers a full run against the configured default golden set with the default criteria. Good for catching prompt regressions before they ship to canary.

## Common pitfalls

- LLM-judge cost is real spend. A 50-input golden set with three judge criteria is 150 judge calls per eval. Track on the [Costs](/docs/costs) view; budget caps apply.
- Golden sets are not versioned. Editing a set after a run does not invalidate the run results; the score history remains, but later runs use the new set. Snapshot a set if you need a stable benchmark.
- Auto-evals run async. A failed eval does not block agent save; check the eval results before promoting a canary.
- Cross-version comparisons require both versions to evaluate against the same set with the same criteria. Use [A/B evals](/docs/evals-ab) for first-class deltas.

## Related

- [A/B evals](/docs/evals-ab): structured comparison of two versions on the same set.
- [Agents](/docs/agents): the agent record gates auto-eval via `featureFlags`.
- [Metrics](/docs/metrics): the satisfaction rollup is exposed as a metric.
