---
slug: evals
title: Evaluations
description: Compare Agent Versions with criteria, golden inputs, ratings, cost, and latency.
category: platform
order: 18
questions:
  - "How do I evaluate an Agent Version?"
  - "What are criteria and golden sets?"
related:
  - evals-ab
  - agent-versions
  - costs
---

# Evaluations

An evaluation measures an Agent Version against explicit criteria and a fixed set of inputs. Evaluation records are not Turns, although each tested input may produce a Turn so normal cost and trace accounting remains complete.

## Building blocks

- **Criterion**: a deterministic check, rubric, LLM judge, cost cap, latency cap, or tool-use expectation.
- **Golden set**: versioned test inputs and optional expected outputs.
- **Evaluation**: the immutable association of an Agent Version, golden-set revision, criteria, per-input results, aggregate scores, and timestamps.

Use real message ratings to seed golden inputs, then remove or redact sensitive data before sharing the set.

## Comparing versions

Evaluate the current and canary Agent Versions against the same golden-set revision and criteria. Compare quality, cost, latency, and policy outcomes. Promote only after the required thresholds pass.

Model output is probabilistic. Repeat important comparisons and report score distributions rather than treating a single evaluation as certainty.
