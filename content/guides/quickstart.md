---
slug: quickstart
title: Quickstart: your first agent in 10 minutes
description: Start the local Compose stack, create an Environment credential, link a provider, and send a Turn.
category: getting-started
order: 10
questions:
  - "How do I start Platos locally?"
  - "How do I link a provider credential?"
  - "How do I send my first Turn?"
related:
  - install-self-host
  - add-provider-key
  - create-first-agent
---

# Quickstart: your first agent in 10 minutes

This local-only path starts Platos, links one dashboard-managed provider credential, and creates an Agent. Do not expose the example configuration to the internet.

## 1. Clone and configure

```bash
git clone https://github.com/winsenlabs/platos.git
cd platos
cp .env.example .env
```

Before starting Compose, populate every variable listed under [Required Compose variables](/docs/self-hosting#required-compose-variables). The example file contains development sentinels and does not provide usable values for every required secret, including `PLATOS_COMPONENT_AUTH_SECRET` and `MANAGED_WORKER_SECRET`. Generate independent values even for a loopback-only evaluation; use [Self-host with Docker Compose](/guides/install-self-host) before exposing Platos.

## 2. Start the stack

```bash
docker compose -f docker-compose.platos.yml up -d --build
```

Wait for `postgres`, `redis`, `clickhouse`, `minio`, `webapp`, and `agent` to become healthy. The `migrations-init`, `clickhouse-migrate`, `clickhouse-ttl-apply`, and `minio-init` services should exit successfully after their one-shot work.

## 3. Sign in

Open `http://localhost:3030`. In the local development flow, use `local@platos.dev` or another test address and follow the magic link printed by the `webapp` service.

## 4. Create and link a provider credential

Open **Providers** in the target Environment. Choose **Add key** for Anthropic, OpenAI, or Google, keep the provider manifest's bare credential name, and paste the raw value into the credential form:

```text
ANTHROPIC_API_KEY
OPENAI_API_KEY
GOOGLE_GENERATIVE_AI_API_KEY
```

Select the new Environment credential as the provider's default and enable the provider. Platos encrypts the raw value and stores only its reference on the provider row.

Do not add a provider key to `.env` and expect it to link automatically. Scoped inference resolves dashboard-managed Environment credentials only; process environment variables are not a provider fallback.

## 5. Create the Agent

Open **Agents**, choose **New agent**, and set:

- Name: `Hello`.
- Model: any model exposed by the linked provider.
- System prompt: `You are a friendly assistant. Reply concisely.`

Save, open **Chat**, and send `Hi`.

## Verify

- The Providers page reports the linked credential as healthy.
- The model picker contains models for that provider.
- The chat streams a successful Turn.
- The owning Thread contains the Turn; ordinary chat does not create a Job.

## Next steps

- [Add a provider key](/guides/add-provider-key) for credential rotation and multi-key behavior.
- [Create your first agent](/guides/create-first-agent) for the complete Agent flow.
- [Connect an entity (TypeScript)](/guides/connect-entity-platools-ts) to expose runtime tools.
- [Self-host with Docker Compose](/guides/install-self-host) for production configuration.
