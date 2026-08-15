---
slug: quickstart
title: "Quickstart: your first agent in 10 minutes"
description: Run docker compose, link a provider key, create an agent, send a chat turn.
category: getting-started
order: 10
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How do I get Platos running locally?"
  - "What is the fastest path from zero to a chatting agent?"
  - "Which provider key do I need to start?"
  - "How do I send my first message to an agent?"
related:
  - install-self-host
  - add-provider-key
  - create-first-agent
source_files_referenced:
  - docker-compose.platos.yml
  - .env.example
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.new/route.tsx
---

# Quickstart: your first agent in 10 minutes

This guide takes you from a fresh checkout to chatting with your first agent. Five steps, ten minutes.

## The goal

A running Platos instance, a linked provider key, an agent named "Hello", and a successful chat turn. After this, you have everything you need to explore the rest of the docs.

## Steps

1. **Clone and configure.**

   ```bash
   git clone https://github.com/platos-labs/platos.git
   cd platos
   cp .env.example .env
   ```

   Generate two keys:

   ```bash
   echo "ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env
   echo "PLATOS_MESSAGE_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env
   ```

2. **Start the stack.**

   ```bash
   docker compose -f docker-compose.platos.yml up -d --build
   ```

   First boot pulls images and runs migrations; allow 5 minutes.

3. **Sign in.**

   Open `http://localhost:3030`. In dev mode the magic-link flow auto-completes (no real email is sent). Use any email you like; the convention is `local@platos.dev`. You land on a default project with a single environment `dev`.

4. **Add a provider key.**

   Provider keys live in environment variables, not in a separate dialog. Open your `.env` file and add the variable for whichever provider you have:

   ```bash
   echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env
   # or
   echo "OPENAI_API_KEY=sk-..." >> .env
   ```

   Restart the stack so the new env propagates into the running containers:

   ```bash
   docker compose -f docker-compose.platos.yml up -d
   ```

   The Providers page in the sidebar shows the provider as linked and runs a health check on the key. Within a few seconds the model picker fills in.

5. **Create the agent.**

   Sidebar -> Agents -> "New agent".

   - Name: `Hello`.
   - Model: pick any model from your provider.
   - System prompt: `You are a friendly assistant. Reply concisely.`

   Save. The agent detail page opens. Click "Chat", type "Hi", and watch tokens stream.

## Verify

- The chat panel streams tokens. The first token arrives in under a second.
- The agent's monitoring tab shows one turn and a non-zero cost.
- The `runs` tab in the sidebar lists no runs (a chat turn is not a BGO).

## Next steps

- [Add a provider key](/guides/add-provider-key) for a deeper walk through provider config.
- [Create your first agent](/guides/create-first-agent) for the wizard's full feature set.
- [Connect an entity (TypeScript)](/guides/connect-entity-platools-ts) to give your agent tools.
- [Self-host with docker compose](/guides/install-self-host) for production deployment.
- The reference entity backend lives at `references/entity-hello-world/` (drift D-010 noted: install with its own `package.json`, not from the workspace root).
