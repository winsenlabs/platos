---
slug: evals-ab
title: A/B evals
description: Compare two agent versions head to head on the same set of inputs.
category: platform
order: 170
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How do I run an A/B eval between two agent versions?"
  - "How is the winner picked?"
  - "Can I A/B test two different models?"
  - "Where do I see the per-criterion deltas?"
  - "Can I gate a canary promotion on an A/B eval?"
related:
  - evals
  - agent-versions
source_files_referenced:
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.evals-ab/route.tsx
---

# A/B evals

A/B evals compare two agent versions on the same input set. Same golden set, same criteria, two versions, side-by-side delta. Use them to make prompt or model changes you trust before flipping the canary.

## What it is

A/B eval is a thin wrapper around two `PlatosEval` runs that share a golden set and a criteria list. The dashboard pivots the results so each row is `(input, scoreA, scoreB, delta)`. An aggregate banner shows the winner per criterion and an overall verdict.

## Why it matters

Single-version evals tell you "version 7 scored 0.74 on conciseness". A/B evals tell you "version 7 scores 0.74 vs version 6's 0.71, and 12 of 50 inputs swung negative". The second framing is what you want when shipping a change; the first is what you want when tracking trend.

## How to use it

### Set up the comparison

`/orgs/{org}/projects/{project}/env/{env}/agents/{agentId}/evals-ab` -> "New A/B run". Pick:

- Version A and Version B (any two committed versions).
- Golden set.
- Criteria.

Click "Run". The runtime fans both versions in parallel against the same inputs.

### Read the result

The result page shows three views:

- **Summary**: per-criterion winner plus overall delta.
- **Per-input**: each row shows both responses side-by-side with their scores, sorted by absolute delta. Clicking a row opens both responses in full.
- **Cost**: per-version spend on the run.

### A/B two models

Create two clones of the agent that differ only in `model`. Run the A/B eval between them. Same prompt, same tools, different model. The delta tells you whether the new model wins on your golden set.

### Gate canary promotion

Tie auto-eval (see [Evals](/docs/evals)) to canary promotion: configure the agent's canary tab so a `canary_promote` requires the A/B eval result against the current default golden set to clear a configurable threshold (e.g. delta >= 0). The promote button stays disabled until the eval passes.

## Common pitfalls

- Both versions burn real spend. A 50-input run on a vision-capable judge model costs 100 LLM calls plus 100 judge calls. Use cost-cap criteria to bound the run.
- Determinism is not guaranteed. The same version run twice can produce slightly different scores, especially with LLM judges. For tight comparisons, set the agent's temperature lower and the judge's even lower.
- A/B evals run against the agent's full pipeline (memory, retrieval, tools). For pure prompt comparison, disable retrieval and tools on a clone first.

## Related

- [Evals](/docs/evals): the criteria and golden set primitives that A/B builds on.
- [Agent versions](/docs/agent-versions): the version snapshots an A/B compares.
