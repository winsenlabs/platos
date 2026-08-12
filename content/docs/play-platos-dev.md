---
slug: play-platos-dev
title: The hosted playground is retired
description: play.platos.dev is no longer a public demo. Platos is self-hosted — clone the repo and run it.
category: dx
order: 5
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "Is there a hosted Platos I can try?"
  - "What happened to play.platos.dev?"
  - "Where do I deploy a Platos agent?"
  - "How do I try Platos without signing up for anything?"
related:
  - self-hosting
  - quickstart
  - architecture
---

# The hosted playground is retired

`play.platos.dev` used to be a public demo instance. It is no longer open to the public, and there is no hosted Platos to sign up for.

This is not a gap waiting to be filled. Platos is a runtime you operate: it holds your provider keys, brokers your agents' tool calls, and stores your conversations. A shared demo instance is the one deployment shape where none of that can be true, so every meaningful thing you would want to evaluate — your models, your integrations, your data staying yours — is only observable on your own box.

## Try it by running it

```bash
git clone https://github.com/winsenlabs/platos.git
cd platos
docker compose -f docker-compose.platos.yml up -d
```

That brings up the full stack — webapp, agent runtime, Postgres, Redis, and object storage — on your machine. [Self-hosting](/docs/self-hosting) covers the environment variables, the provider keys, and what to change before anything faces the internet. [Quickstart](/docs/quickstart) takes you from a running stack to an agent answering a message.

You need one model provider key to get a useful agent. Everything else has a working default.

## What this means for the docs

Every page in this documentation describes a Platos you run yourself. Where a doc mentions a URL, it is describing *your* deployment, not a Winsen Labs–operated one. Nothing here assumes a hosted tier, a free plan, or a signup.

The `platos.dev` marketing site and these docs are the only public surfaces Winsen Labs operates — see [Legal and policies](/docs/legal-and-policies).
