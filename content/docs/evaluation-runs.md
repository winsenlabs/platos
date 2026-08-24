---
slug: evaluation-runs
title: Evaluation runs
description: Judge one persisted Thread against a versioned criterion and inspect the resulting evaluation record.
category: platform
order: 19
questions:
  - "How do I run an evaluation?"
  - "How do I filter evaluation records by Agent Version?"
related:
  - evals
  - agent-versions
  - costs
---

# Evaluation runs

Platos evaluates a persisted Thread against one evaluation criterion and stores the resulting score, explanation, Agent, Agent Version, Thread, and criterion ancestry.

Create and version criteria through `/api/v1/agent/eval-criteria`. Dispatch one judge evaluation with the exact persisted identifiers:

```http
POST /api/v1/agent/evals/dispatch
Content-Type: application/json

{
  "agentId": "agent_123",
  "threadId": "thread_123",
  "criterionId": "criterion_123"
}
```

Read results with `GET /api/v1/agent/evals` and filter by `agentId`, `agentVersionId`, `criterionId`, `threadId`, or `runId`. A criterion may select a judge model; the runtime rejects self-evaluation when the judge model equals the Agent's model.

The current public contract does not create a first-class pairwise model-comparison or A/B-comparison resource. If you compare filtered result sets outside Platos, keep the criterion revision, inputs, and sampling policy fixed and label the analysis as operator-owned.
