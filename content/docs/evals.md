---
slug: evals
title: Evaluations
description: Judge persisted Threads with criteria and run saved golden sets.
category: platform
order: 18
questions:
  - "How do I evaluate an Agent Version?"
  - "What are criteria and golden sets?"
related:
  - evaluation-runs
  - agent-versions
  - costs
---

# Evaluations

An evaluation judges a persisted Thread against an explicit criterion and records the Agent Version that produced the evaluated output. Evaluation records are not Turns, although tested inputs may produce Turns so normal cost and trace accounting remains complete.

## Building blocks

- **Criterion**: a deterministic check, rubric, LLM judge, cost cap, latency cap, or tool-use expectation.
- **Golden set**: versioned test inputs and optional expected outputs.
- **Evaluation**: the immutable association of one Thread, Agent Version, criterion, score, explanation, and timestamps.

Use real message ratings to seed golden inputs, then remove or redact sensitive data before sharing the set.

## Running a golden set

Run `POST /api/v1/agent/golden-sets/{goldenSetId}/run` to judge every saved Thread-and-criterion pair. Inspect persisted rows with `GET /api/v1/agent/evals` and filter by `agentVersionId` when reviewing one version.

The public contract does not create a first-class pairwise comparison resource. Keep any statistical comparison in an operator-owned analysis pipeline.
