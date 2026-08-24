---
slug: evals-ab
title: Agent Version comparison
description: Compare current and canary Agent Versions on the same evaluation inputs.
category: platform
order: 19
questions:
  - "How do I compare two Agent Versions?"
related:
  - evals
  - agent-versions
  - costs
---

# Agent Version comparison

Select two immutable Agent Versions, one golden-set revision, and the same criteria for both sides. Platos evaluates every input with both versions and presents per-input deltas plus aggregate quality, cost, latency, and policy outcomes.

Keep model, prompt, tools, memory configuration, and routing differences visible in the version diff. If you want to isolate one change, clone the version and change only that field.

A comparison consumes real provider capacity. Estimate the number of model and judge invocations before starting a large set, then apply an Environment budget cap.
