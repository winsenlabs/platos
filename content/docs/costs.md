---
slug: costs
title: Cost accounting
description: Turn and Step costs with immutable model-price provenance.
category: observability
order: 4
questions:
  - "How does Platos calculate cost?"
  - "What is the billable work-count unit?"
related:
  - turns
  - observability
  - budgets
  - models
---

# Cost accounting

A completed **Turn** is the billable work-count unit. A Turn may contain several Steps and Tool Calls, but it still represents one accepted input and completed Agent response.

Each Step stores input, output, cache-read, and cache-write token counts plus the exact rates and provenance used to calculate cost. Historical cost therefore stays reproducible when catalogue prices change later.

## Price sources

Platos starts with LiteLLM's public price catalogue and applies verified operator overrides where provider pricing differs. Every rate records its source and observation time. Cache writes and cache reads are separate rates; a cache write may cost more than ordinary input.

## Attribution

Aggregate cost by Organization, Project, Environment, Agent, Agent Version, Thread, Turn, model, and workload lane. Keep evaluation, memory extraction, compaction, and user-facing inference visible as separate lanes.

```http
GET /api/v1/agent/monitoring/cost?agent={agentId}&groupBy=lane
```

Use budgets to cap total Environment or Agent spend. Investigate missing or duplicated Step records before reconciling against provider invoices.
