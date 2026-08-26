---
slug: models
title: Models
description: Pick a model per agent, compare two models head to head, and see which providers must be linked.
category: platform
order: 140
questions:
  - "How is the model picker scoped to my linked providers?"
  - "How do I compare two models on the same prompt?"
  - "Can I add a new model to the catalog?"
  - "How do I switch a live agent to a new model?"
  - "Where do model prices come from?"
  - "What happens when a model gets retired by its provider?"
related:
  - providers
  - agents
  - costs
---

# Models

A model in Platos is one row in the LLM model catalogue: a provider plus a model id plus pricing plus capability flags. The dashboard surfaces only the models whose providers you have linked, so the picker is always actionable. Cost rolls up per model on the [Costs](/docs/costs) view; the current public contract does not create a first-class pairwise model-comparison resource.

## What it is

The catalogue is a Postgres table seeded at boot. Each row carries:

- `provider`: `anthropic`, `openai`, `google`, etc.
- `modelId`: the wire-level id, e.g. `claude-opus-4-7`.
- `displayName`, `description`.
- `inputCostPerMillion` and `outputCostPerMillion` (USD).
- Capability flags: `vision`, `tools`, `streaming`, `cacheable`, `structuredOutput`.
- `retiredAt`: nullable; non-null hides the model from new agent pickers.

Admins can add or update models from `/admin/llm-models`. The catalogue is global; environments do not maintain their own copy.

The picker filter is in `loadActiveProviders(scope)`: it lists every model whose provider has a linked key in the current environment. Models without a linked provider are hidden everywhere except the admin view.

## Why it matters

The flip-side of BYOK is that a self-hosted Platos has no idea which providers a given customer can spend against. Showing every model in every picker drives bad config: a user picks `gpt-4o`, the agent boots, the runtime fails on the first turn because the OpenAI key was never linked. Filtering at the picker turns an runtime error into "this model is not available; link the OpenAI key in Providers".

To assess a model change, create a candidate Agent Version and run a representative golden set. Keep any cross-version statistical comparison in an operator-owned analysis pipeline.

## How to use it

### Pick a model on an agent

In the agent's general tab, the Model dropdown shows every model whose provider is linked. The dropdown groups by provider and badges the cheapest cache option. Saving writes a new agent version.

### Add a model to the catalogue

`/admin/llm-models` lets an admin create a new row. Fill in provider, model id, pricing, and capabilities. New rows appear in pickers on the next page load.

### Pin a per-route model

For agents that need different models per request label, configure `modelRoutes` on the agent (`{ label, model, providerKeyId, isDefault }[]`). The runtime picks the route whose label matches the request, falls back to default if no match.

## Common pitfalls

- A model `retiredAt` non-null still works for existing agents (the agent string still resolves). Pickers hide it, so cloning to a new agent has to manually point at a successor.
- Pricing changes are global. If a provider drops their per-million by 30%, the cost view recomputes spend going forward; historical cost rows stay at the price they were charged at.
- Capability flags are advisory. The runtime trusts them when picking a vision-capable model for image inputs; an incorrect flag means image inputs silently fail. Audit flags when you add a model.
- The model picker is filtered, but the agent's stored `model` string is not. Editing an agent that points at a now-unavailable model still works in the dashboard; the runtime errors at turn time. Watch the model name on the agent header.

## Related

- [Providers](/docs/providers): linking a provider key is what unlocks its models.
- [Agents](/docs/agents): the agent's `model` field, plus `modelRoutes` for per-request routing.
- [Costs](/docs/costs): per-model spend rollup.
