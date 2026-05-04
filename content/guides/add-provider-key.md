---
slug: add-provider-key
title: Add a provider key (BYOK)
description: Link your OpenAI, Anthropic, or other provider key to a Platos environment via environment variables.
category: getting-started
order: 30
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "Where do I add my OpenAI API key?"
  - "How do I scope a key to one environment?"
  - "How does Platos verify the key works?"
  - "How do I rotate a key without breaking running agents?"
  - "Why is the model picker empty even though I have a key?"
related:
  - quickstart
  - create-first-agent
source_files_referenced:
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-providers._index/route.tsx
  - apps/agent/src/providers/providers.controller.ts
  - .env.example
---

# Add a provider key (BYOK)

Platos runs on your provider keys. Keys are stored as environment variables on the agent process; the dashboard's Providers page shows you which providers are wired and runs health checks against them. This guide adds your first key.

## The goal

A linked Anthropic or OpenAI key in your `dev` environment. After this, the Providers page shows the provider as healthy and the model picker fills in with the provider's models.

## Mental model

A "provider" is a slot Platos knows about (Anthropic, OpenAI, Google, Vertex, and a handful of OpenAI-compatible ones). Each slot declares which environment variable holds the key. Self-hosted: you set the env var in your `.env` file. Managed deployments: you set it in the dashboard's Environment Variables page (which writes to the same secret store).

There is no separate dialog to "paste a key into the Providers page." The Providers page is a read-and-link surface, not a create-a-secret surface. The actual secret lives in env vars.

## Steps (self-host)

1. **Get the key.**

   From your provider's dashboard:

   - Anthropic: `https://console.anthropic.com/keys`
   - OpenAI: `https://platform.openai.com/api-keys`
   - Google: Vertex AI service account or AI Studio API key.

   Make sure billing is set up. Platos uses the key directly for inference.

2. **Add the env var.**

   Edit your `.env` file at the repo root. Add the variable for the provider you have:

   ```bash
   ANTHROPIC_API_KEY=sk-ant-...
   # or
   OPENAI_API_KEY=sk-...
   # or
   GOOGLE_GENERATIVE_AI_API_KEY=...
   ```

   The exact variable name per provider lives in `.env.example`. The Providers page also shows the expected variable name for each provider so you do not have to remember.

3. **Restart the stack.**

   ```bash
   docker compose -f docker-compose.platos.yml up -d
   ```

   This propagates the new env into the running webapp + agent containers. Existing turns keep going; new turns pick up the key on first inference call.

4. **Verify on the Providers page.**

   Sidebar to Providers (`/orgs/{org}/projects/{project}/env/dev/agent-providers`). The provider card flips to a green health badge within a few seconds. The badge runs a cheap "list models" call against the key.

## Steps (managed deployment)

If you are running on managed Platos (no `.env` file), use the dashboard Environment Variables page:

1. Sidebar to Environment Variables.
2. New variable. Name: `ANTHROPIC_API_KEY` (or whichever provider). Value: your key. Scope it to the environments where you want the provider available.
3. Save. The agent process picks up the change on the next request; no manual restart needed.

## Verify

- The provider card on Providers shows green status.
- The agent creation wizard's model picker now lists this provider's models.
- A test chat turn streams without `PROVIDER_NOT_LINKED` errors.

## Rotate without downtime

To rotate a key, edit the env var (in `.env` or in the dashboard) with the new value and either restart the stack (self-host) or save (managed). New turns use the new key on first inference call. Turns already in flight finish on the credentials they started with. No agent-config edits required.

## Multiple keys for the same provider

For multi-key support (e.g. one Anthropic key per region or per cost center), Platos accepts numbered variants: `ANTHROPIC_API_KEY`, `ANTHROPIC_API_KEY_2`, `ANTHROPIC_API_KEY_3`. The Providers page lists all variants linked to a provider; agents can pin to a specific variant or use scope default.

## Common pitfalls

- **Model picker is empty.** No env var is linked. Check the Providers page for a red status, set the env var, restart.
- **Health check fails with 401.** The key is invalid or revoked. Replace the value in `.env` and restart.
- **Health check fails with 429 or quota error.** The key is valid but the provider account has hit a rate limit or billing issue. Fix on the provider's dashboard.
- **Wrong variable name.** Check `.env.example` for the exact name. `OPENAI_KEY` is wrong; it has to be `OPENAI_API_KEY`.

## Next steps

- [Create your first agent](/guides/create-first-agent) using the new provider's model.
- For separate `prod` keys, set a differently-scoped env var in the `prod` environment. Keys do not auto-cross environments.
- [Self-host with docker compose](/guides/install-self-host) covers the broader env-var lifecycle.
