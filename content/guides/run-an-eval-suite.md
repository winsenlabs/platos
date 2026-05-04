---
slug: run-an-eval-suite
title: Run an A/B eval suite
description: Build a golden set, define criteria, and compare two agent versions head to head.
category: recipes
order: 20
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How do I build a golden set?"
  - "How do I define an eval criterion?"
  - "How do I run an A/B comparison between two versions?"
  - "How do I see per-criterion deltas?"
related:
  - version-and-rollback
source_files_referenced:
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-evals._index/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.eval-criteria._index/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.evals-ab/route.tsx
---

# Run an A/B eval suite

Build a fixed input set, score it under both versions, read the delta.

## The goal

A reproducible numeric comparison between two agent versions on a golden set, broken down by criterion.

## Steps

1. **Build a golden set.**

   `/agent-evals` -> "New golden set". Add inputs (paste, CSV import, or "include rated messages" to seed from real thumbs-ups). Aim for 30-100 inputs to start.

2. **Define criteria.**

   `/eval-criteria` -> "New criterion". For each:
   - LLM-judge: "On 1-5, how concise is the reply?" Pick the judge model.
   - Keyword match: "must contain the user's name".
   - Cost / latency thresholds.

   Save. Each criterion is reusable across runs.

3. **Run A/B.**

   On the agent, A/B Evals tab -> "New run". Pick versions (current + canary), the golden set, the criteria. Click Run.

   The runtime fans the inputs across both versions in parallel. Progress streams live.

4. **Read the result.**

   - **Summary**: overall winner per criterion, total delta.
   - **Per-input**: rows sorted by absolute delta. Click to see both responses side-by-side.
   - **Cost**: per-version spend on the run.

   A win on the criteria you care about, no regression on the others, no large cost delta -> promote.

## Verify

- The run produces deterministic-ish results when re-run (small judge variance).
- Per-input rows match the agent's behaviour when chatted manually.
- The eval cost matches the per-call expectation: `inputs * (versions * (model_calls + judge_calls))`.

## Tips

- Lower agent + judge temperature for tighter comparisons.
- For pure prompt comparison, clone the agent twice with retrieval and tools off.

## Next steps

- [Version, canary, and roll back](/guides/version-and-rollback) once the eval clears.
- [Debug a sudden cost spike](/guides/debug-cost-spike) if the eval reveals an expensive criterion.
