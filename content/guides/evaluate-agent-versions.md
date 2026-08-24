---
slug: evaluate-agent-versions
title: Evaluate Agent Versions
description: Compare current and canary Agent Versions on a fixed golden set.
category: recipes
order: 7
questions:
  - "How do I compare two Agent Versions?"
related:
  - evals
  - evals-ab
  - version-and-rollback
---

# Evaluate Agent Versions

1. Create or select a golden-set revision with representative, redacted inputs.
2. Choose criteria for quality, cost, latency, and required Tool Calls.
3. Select the current and canary Agent Versions.
4. Start the comparison and wait for every input to settle.
5. Inspect per-input deltas before trusting the aggregate score.
6. Promote only when required criteria pass; otherwise create a corrected Agent Version.

Repeat high-impact comparisons because model output is probabilistic. Keep the golden-set revision and criterion versions fixed when comparing results over time.
