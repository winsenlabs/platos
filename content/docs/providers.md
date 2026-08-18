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

Platos runs on dashboard-managed BYOK credentials. There is no managed inference, platform spend, or rebill. Credentials are encrypted in the Platos-native store, owned by one Environment, and linked to provider metadata by reference.

## What it is

Three layers:

1. **Provider manifests** under `apps/agent/src/providers/manifests/`. Each manifest declares the provider's `slug`, the env vars it needs (`OPENAI_API_KEY`, `OPENAI_API_BASE`, etc.), the auth shape, the model class, and any default model list.
2. **Environment Credentials** hold encrypted secret revisions. The raw value is accepted only by dashboard create/rotate operations and is never returned afterward.
3. **Provider-key rows** hold a same-Environment Credential FK plus safe label/default metadata. Each agent can pin one reference or use the Environment default.

At runtime, scoped resolution loads the authenticated Environment credential and unwraps it only at the provider constructor. It never falls back to `process.env[providerName]`. Missing dashboard credentials remain missing even when the agent container has a matching deployment variable.

The model picker (`loadActiveProviders(scope)`) filters the model catalog by which providers have a linked key in the current environment. Hide a provider, hide its models.

## Why it matters

A managed-inference platform locks you into someone else's pricing curve and rate limits. BYOK lets you negotiate your own rates, run on a private deployment (Azure OpenAI, Bedrock, on-prem), and rotate keys when the provider asks. The cost is some onboarding friction; Platos minimises that with a one-page checklist and the model picker that hides what you have not linked yet.

Multi-key support lets teams keep separate credentials per region, cost center, or workload. Each link remains Environment-local; a development reference cannot resolve a production credential.

## How to use it

### Add and link a credential

1. Open the dashboard Providers page for the target Environment and choose **Add key** under the provider.
2. Enter a label, the manifest's bare reference name (such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `VOYAGE_API_KEY`), and the raw value. Saving creates the encrypted Environment credential and its provider link together; the response contains safe metadata only.
3. Enable/link the provider and select the new reference as default when required. Provider/MCP configuration accepts references, never plaintext.
4. Run the provider health check and confirm the model picker shows the linked provider.

Embedding uses the same dashboard-only path. Set the non-secret `PLATOS_EMBEDDING_PROVIDER` deployment setting, then link `VOYAGE_API_KEY` or `OPENAI_API_KEY` in every Environment that needs memory/RAG.

### Multiple keys per provider

Use **Add key** again with distinct names/labels. The names remain references; they are not process environment fallbacks.

### Pin per agent

The agent's general tab has a "Provider key" field. Pick a specific named variant or "scope default" (the first variant linked for the provider). New agents inherit the scope default.

### Rotate

Rotate the credential value in the dashboard. The store atomically creates a new secret revision under the active credential root and retires the previous revision. A turn that already acquired old material may finish; subsequent reads receive the replacement. Provider links and agent pins do not change.

### Health

Health resolves only the linked Environment credential and returns status metadata. It never falls back to deployment provider variables or returns the value.

## Common pitfalls

- A deployment `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` does not bootstrap scoped resolution. Create and link the credential in the dashboard.
- Credentials are Environment-scoped. Create separate development and production credentials; names do not cross scope.
- Wrong reference name. `OPENAI_KEY` does not match a credential named `OPENAI_API_KEY`.
- Do not paste plaintext into provider or MCP reference fields. They persist identifiers only.
- Root-key rotation and provider-secret rotation are separate; see [Encryption and secrets](/docs/encryption-and-secrets).

## Related

- [Models](/docs/models): the catalog the picker reads from.
- [Encryption and secrets](/docs/encryption-and-secrets): where the keys are encrypted and the rotation guarantees.
- [Environments](/docs/environments): the scope dimension that owns key bindings.
