---
slug: run-golden-set
title: Run a golden set
description: Execute one saved golden set and inspect the resulting evaluation rows.
category: recipes
order: 7
questions:
  - "How do I execute a golden set?"
related:
  - evals
  - evaluation-runs
  - version-and-rollback
---

# Run a golden set

1. Create evaluation criteria for the Agent.
2. Create a golden set containing representative, redacted Thread inputs.
3. Keep the golden-set inputs and criterion revisions stable for repeatability.
4. Run the saved set:

```http
POST /api/v1/agent/golden-sets/{goldenSetId}/run
Content-Type: application/json

{}
```

The route returns after every Thread-and-criterion pair has been judged. Inspect the returned report and the persisted rows from `GET /api/v1/agent/evals`.

A golden-set run is not a first-class pairwise model-comparison resource. To assess a new Agent Version, run representative Threads against that version, filter evaluation rows by `agentVersionId`, and keep any cross-version statistical comparison in your own analysis pipeline.
