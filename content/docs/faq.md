---
slug: faq
title: FAQ
description: Common questions about Platos — what it is, how it compares, where to deploy, how to use it.
category: dx
order: 1
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "What is Platos?"
  - "How is Platos different from Trigger.dev?"
  - "How is Platos different from LangChain or AutoGPT?"
  - "Is Platos free?"
  - "Can I use my own LLM provider?"
  - "Does Platos support OpenAI / Anthropic / Google?"
  - "Where do I run Platos in production?"
  - "Can I self-host Platos?"
  - "Does Platos store my conversations?"
  - "Are conversations encrypted?"
related:
  - play-platos-dev
  - self-hosting
  - architecture
  - providers
---

## What is Platos?

Platos is an open-source agent runtime — Apache 2.0, self-hostable in one `docker compose up`. Streaming chat, tool-calling, memory, skills, durable background tasks, observability, and a multi-tenant scope model in one runtime. Build internal agents, customer-facing chatbots, or research workflows on infrastructure you own.

## How is Platos different from Trigger.dev?

Platos is **built on top of** [trigger.dev](https://trigger.dev) — the durable run engine underneath every long-running tool call, scheduled job, or batch operation in Platos is trigger.dev's run engine. Where trigger.dev is a job runner, Platos is a complete agent stack: chat runtime, prompt caching, memory, MCP gateway, skills, evals, all wired together.

If you only need durable background jobs (no LLM, no agent loop), trigger.dev is the right tool. If you're building agents, Platos gives you trigger.dev's durability **plus** everything else.

## How is Platos different from LangChain / AutoGPT / etc?

LangChain and AutoGPT are libraries — you assemble the pieces yourself: a tool layer, a memory store, an evals harness, a session/thread model, a multi-tenant scope, deployment/scaling. Platos is a runtime — those pieces are already assembled and battle-tested. You configure agents in the dashboard or via SDK and ship.

## Is Platos free?

Yes. Apache 2.0, no vendor seat license, no telemetry-based billing. You pay for your own infra and your own LLM API costs. Winsen Labs takes a small number of paid consulting engagements per year; that funds Platos development.

## Can I use my own LLM provider?

Yes — BYOK ("bring your own keys") is the default. Anthropic, OpenAI, Google, Vertex AI, OpenRouter. Keys are encrypted at rest in your database and never leave it. See [providers](/docs/providers).

## Where do I run Platos in production?

Self-host. Same compose file the public playground (`play.platos.dev`) runs on. See [self-hosting](/docs/self-hosting). The playground is a public demo — **not for production**, see [play-platos-dev](/docs/play-platos-dev).

## Does Platos store my conversations? Are they encrypted?

Conversations are stored in Postgres. Message contents are encrypted at rest with AES-256 envelopes (`PLATOS_MESSAGE_ENCRYPTION_KEY`). Provider API keys are encrypted with `ENCRYPTION_KEY`. Service secrets for connected entities are encrypted in the same column. See [encryption-and-secrets](/docs/encryption-and-secrets).

## More questions?

- Open a [GitHub Discussion](https://github.com/winsenlabs/platos/discussions)
- Join the [Discord](https://discord.gg/7zxegt73zr)
- Email [hello@winsenlabs.com](mailto:hello@winsenlabs.com)
