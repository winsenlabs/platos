---
slug: models
title: Models
description: Choose provider-backed models for an agent and understand where availability and pricing come from.
category: platform
order: 140
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How is the model picker scoped to my linked providers?"
  - "Where does the model list come from?"
  - "How do I switch a live agent to a new model?"
  - "Where do model prices come from?"
  - "What happens when a model is no longer available?"
related:
  - providers
  - agents
  - costs
source_files_referenced:
  - apps/agent/src/providers/model-catalog.service.ts
  - apps/agent/src/providers/provider-registry.service.ts
  - apps/agent/src/monitoring/cost.service.ts
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.new/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId._index/route.tsx
---

# Models

A model in Platos is a provider-qualified identifier such as `anthropic:claude-sonnet-4-6`. Model selection belongs to each agent and its model routes; there is no global database-backed model-pricing admin catalogue.

## Model availability

The agent service builds the available list from two sources:

- Curated model identifiers in each provider manifest.
- Live provider model endpoints when the provider supports discovery.

Live discovery uses the credential linked to the current environment. Results are cached briefly, and failures fall back to the curated manifest instead of breaking the picker. Providers without a ready environment credential do not expose spendable models for that environment.

## Choose or change a model

Choose the default model while creating an agent, or edit an existing agent's model routes. A route may also select a different model for a request label and define a default fallback.

The stored model remains a provider-qualified string. If its provider is no longer ready, the agent editor identifies the orphaned selection and asks you to choose an available model before relying on it for new turns.

## Pricing

Model availability and model pricing are separate concerns. The agent runtime prices usage through its LiteLLM-derived price cache, verified overlays, and conservative fallback rates. It records the exact priced cost with runtime usage; the webapp does not seed or administer model prices in Postgres.

## Common pitfalls

- A model returned by a provider may still require account-specific access. A provider API error falls back to curated metadata but does not make an unavailable model callable.
- Rotating or replacing a provider credential invalidates that provider's model-list cache so the next lookup reflects the new account.
- The stored model string is not automatically rewritten when a provider retires a model. Update the agent or its model routes to a supported replacement.
- Pricing metadata does not control availability. Provider readiness controls the picker; the runtime cost service controls spend attribution.

## Related

- [Providers](/docs/providers): link an environment credential to make its provider ready.
- [Agents](/docs/agents): configure the default model and model routes.
- [Costs](/docs/costs): inspect model usage and spend attribution.
