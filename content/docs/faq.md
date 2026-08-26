---
slug: faq
title: Frequently asked questions
description: Concise answers about Platos ownership, hosting, execution, and integrations.
category: dx
order: 99
questions:
  - "What is Platos?"
  - "Is Platos hosted?"
  - "How does durable background work execute?"
related:
  - domain-vocabulary
  - self-hosting
  - play-platos-dev
---

# Frequently asked questions

## What is Platos?

Platos is an open-source, self-hosted Agent platform with Threads, Turns, Tools, Skills, Memory, Jobs, Agent Versions, evaluations, observability, and multi-tenant isolation.

## Is there a hosted public demo?

No. `play.platos.dev` is a clean-slate installation target, not a public playground or signup surface. Follow the self-hosting guide for an installation you control.

## How does background work execute?

Platos records asynchronous work as Jobs. An external durable-runtime vendor adapter can execute that work, but its resource model does not become the Platos public API.

## How do I change Agent behavior safely?

Every executable configuration change creates an immutable Agent Version. Compare or canary the candidate, then promote the binding. Environment names do not define this lifecycle.

## Where is the API contract?

Use the generated OpenAPI document exposed by your Agent service and the platform MCP catalogue. See [OpenAPI and REST](/docs/openapi-and-rest).
