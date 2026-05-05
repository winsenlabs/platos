---
slug: providers
title: Providers and BYOK
description: Bring your own provider keys (OpenAI, Anthropic, etc.) and link them per environment with a checklist.
category: platform
order: 150
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How do I add my OpenAI key to Platos?"
  - "Where are provider keys stored and encrypted?"
  - "Can I have multiple keys for the same provider?"
  - "How do I link a provider key to a specific environment?"
  - "What happens to agents using a provider key when I rotate it?"
  - "Why doesn't my agent see the provider's models in the picker?"
related:
  - models
  - encryption-and-secrets
  - environments
source_files_referenced:
  - apps/agent/src/providers/provider-registry.service.ts
  - apps/agent/src/providers/providers.controller.ts
  - apps/agent/src/providers/scoped-env.service.ts
  - apps/agent/src/providers/manifests
  - apps/agent/src/auth/provider-health.service.ts
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-providers._index/route.tsx
---

# Providers and BYOK

Platos runs on your provider keys. There is no managed inference, no platform spend, no rebill. You bring an OpenAI key, an Anthropic key, an embedding key; Platos links them per environment and routes turns through them. Keys are encrypted at rest, scoped to the environment, and rotatable without touching agent configs.

## What it is

Two layers:

1. **Provider manifests** under `apps/agent/src/providers/manifests/`. Each manifest declares the provider's `slug`, the env vars it needs (`OPENAI_API_KEY`, `OPENAI_API_BASE`, etc.), the auth shape, the model class, and any default model list.
2. **`PlatosProviderKey` rows** keyed on `(scope, providerSlug, name)`. PIFSP-14 lets you have N keys per provider in the same environment; each agent can pin a specific key via `providerKeyId` or fall back to the scope default.

`ScopedEnvService` reads the linked keys at runtime and assembles the env bag the LLM client uses. `ProviderRegistryService` enumerates available providers; `ProviderHealthService` runs cheap health pings (model list / hello call) and surfaces status on the providers page.

The model picker (`loadActiveProviders(scope)`) filters the model catalog by which providers have a linked key in the current environment. Hide a provider, hide its models.

## Why it matters

A managed-inference platform locks you into someone else's pricing curve and rate limits. BYOK lets you negotiate your own rates, run on a private deployment (Azure OpenAI, Bedrock, on-prem), and rotate keys when the provider asks. The cost is some onboarding friction; Platos minimises that with a one-page checklist and the model picker that hides what you have not linked yet.

The multi-key support (PIFSP-14) is for teams that need separate keys per project, per region, or per team. A single Anthropic provider can hold three keys: prod-us, prod-eu, dev. Each agent pins the key it should spend against; rotation hits one key without invalidating the rest.

## How to use it

### Add a key

Provider keys live in environment variables. The Providers page shows you which providers have a key wired and runs health checks against them; it is a read-and-link surface, not a create-a-secret form.

For self-hosted Platos, edit your `.env` file and set the variable for the provider you want:

```bash
# LLM providers — at least one needed to run a turn
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_GENERATIVE_AI_API_KEY=...

# Embedding provider — REQUIRED for memory + RAG
PLATOS_EMBEDDING_PROVIDER=voyage   # or `openai`
VOYAGE_API_KEY=pa-...              # required when provider=voyage
```

**The embedding key is its own track** — without one of `VOYAGE_API_KEY` or `OPENAI_API_KEY` (with `PLATOS_EMBEDDING_PROVIDER=openai`), the hourly memory-extraction cron and every `remember` call throw at write time. Multi-turn agents will look stateless. The agent emits a loud boot-time warning when neither is set; see [Memory § Setup](/docs/memory#setup).

The exact variable name per provider lives in `.env.example`; the Providers page also shows the expected name for each provider. Restart the stack so the new env propagates:

```bash
docker compose -f docker-compose.platos.yml up -d
```

For managed deployments, use the dashboard Environment Variables page (Sidebar to Environment Variables) instead of editing a file. The agent picks up changes on the next request, no restart needed. Either path stores the secret in trigger.dev's `Environment Variables` table; the `PlatosProviderKey` row carries metadata only (label, last-used, status), not the secret.

### Multiple keys per provider

Set numbered variants for additional keys: `ANTHROPIC_API_KEY_2`, `ANTHROPIC_API_KEY_3`, and so on. The Providers page lists every variant. Useful for splitting cost centers, separating regions, or rate-limit isolation.

### Pin per agent

The agent's general tab has a "Provider key" field. Pick a specific named variant or "scope default" (the first variant linked for the provider). New agents inherit the scope default.

### Rotate

Edit the env var with the new value. Self-host: restart the stack. Managed: save on the Environment Variables page. Turns in flight finish on the old credential; new turns use the new one. No agent-config edits required.

### Health

The health badge per provider runs a cheap "list models" call every 5 minutes. Red badges mean the key is invalid or revoked; investigate before agents break.

## Common pitfalls

- The model picker is empty when no provider has a linked env var. The most common "I cannot pick a model" cause is "the env var is not set in this scope yet".
- Provider env vars are scoped to `(organizationId, projectId, environmentId)`. A var in `dev` does not auto-apply to `prod`. Set per environment.
- Wrong variable name. `OPENAI_KEY` is wrong; it has to be `OPENAI_API_KEY`. Check `.env.example` or the Providers page hint for each provider's expected name.
- The encryption tail relies on `ENCRYPTION_KEY` being a 32-byte ASCII string. A wrong-length key breaks both reads and writes; see [Encryption and secrets](/docs/encryption-and-secrets) for the trap.
- A pinned `providerKeyId` that no longer exists falls back to scope default. The agent does not error; it spends against a different key. If you want hard pinning, configure budget caps so the wrong key blows the cap loud.

## Related

- [Models](/docs/models): the catalog the picker reads from.
- [Encryption and secrets](/docs/encryption-and-secrets): where the keys are encrypted and the rotation guarantees.
- [Environments](/docs/environments): the scope dimension that owns key bindings.
