---
slug: play-platos-dev
title: play.platos.dev — public playground (NOT production)
description: What play.platos.dev is, what it isn't, and where to deploy your real agents.
category: dx
order: 5
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "Is play.platos.dev for production?"
  - "Can I run my real agents on play.platos.dev?"
  - "What's the difference between play.platos.dev and self-hosting?"
  - "Is play.platos.dev managed?"
  - "Where do I deploy a Platos agent?"
related:
  - self-hosting
  - quickstart
  - architecture
---

`play.platos.dev` is a **public playground** — a single shared Platos instance run by Winsen Labs so you can kick the tires without setting up infrastructure. **It is not for production.**

## What play.platos.dev is

- A shared Platos runtime with the latest open-source build
- A free way to experiment with agents, tools, prompts, and the dashboard before committing to your own deployment
- The instance the "Talk to Platos" widget on `platos.dev` is wired to
- The fastest route to seeing the runtime end-to-end

## What play.platos.dev is NOT

- **Not a managed cloud product.** No SLA, no uptime guarantees, no support.
- **Not isolated.** Your data lives next to other people's data on the same Postgres / Redis / ClickHouse / MinIO. Standard multi-tenant scope checks apply, but nothing stops Winsen Labs from wiping the instance for an upgrade.
- **Not durable.** The instance gets reset periodically. Threads, agents, and memory may disappear.
- **Not your data.** Anything you ship to play.platos.dev is visible to the operators of that instance and may be deleted at any time. **Do not paste real customer data, secrets, or PII.**
- **Not rate-friendly for real workloads.** Aggressive per-user and per-org rate limits keep the playground available for everyone.

## Where to actually deploy

Self-host. The same compose stack that runs `play.platos.dev` runs on your own VPS in one command:

```bash
git clone https://github.com/winsenlabs/platos.git
cd platos
cp .env.example .env                       # set ANTHROPIC_API_KEY etc.
docker compose -f docker-compose.platos.yml up -d
```

You own the data, the infra, the cost curve, and the upgrade cadence. Full guide: [self-hosting](/docs/self-hosting).

If you want a managed Platos instance with a contract, talk to us via [hello@winsenlabs.com](mailto:hello@winsenlabs.com).

## Quick triage: which one am I on?

If the URL bar shows `play.platos.dev`, you're on the playground. If it shows `localhost:3030`, your own domain, or anything you control — you're self-hosted.

The dashboard is identical on both surfaces; the only difference is who owns the database underneath.
