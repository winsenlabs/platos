---
slug: environments
title: Environments
description: Per-project dev/staging/prod environments with their own scoped env vars, providers, and queues.
category: dx
order: 100
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How do I add a new environment to a project?"
  - "How are env vars scoped per environment?"
  - "Are agents copied across environments or is each env standalone?"
  - "How do I link a provider key to one environment but not another?"
  - "How do I switch envs in the UI?"
related:
  - scope-and-multi-tenancy
  - providers
  - encryption-and-secrets
source_files_referenced:
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables.new/route.tsx
---

# Environments

An environment is the third axis of the [scope tuple](/docs/scope-and-multi-tenancy). Each project has at least `dev`; most have `dev` plus `staging` plus `prod`. Each carries its own provider keys, env vars, queues, and agents. Data does not cross environments.

## What it is

A `PlatosEnvironment` row keyed on `(projectId, slug)`. Owns:

- Display name and slug.
- A bag of environment variables (provider keys, skill secrets, custom values).
- The set of `PlatosAgent` rows that belong to it.
- The trigger.dev environment binding (queues, deployments) that runs underneath.

Every other scoped row also carries `environmentId`. Switching environments in the dashboard re-scopes every page; the URL embeds `/env/{slug}/`.

The environment-variables page at `/orgs/{org}/projects/{project}/env/{env}/environment-variables` is the canonical place to add and rotate values. The values are stored in trigger.dev's encrypted env-var table; the dashboard is a thin UI over that.

## Why it matters

Without environments, every change ships straight to prod. A misconfigured prompt, a flipped feature flag, a wrong provider key: all of these break customers immediately. Environments give you a sandbox to develop against, a staging surface to run evals, and a prod surface that is opaque to dev tinkering.

The per-environment env vars are the lever. A `dev` environment can use a low-cost test model and a sandbox provider key; the same agent slug in `prod` uses production keys without any agent-config change. Promotion is "deploy the same agent config; the env vars take care of the rest".

## How to use it

### Create an environment

Project settings -> Environments -> "New environment". Pick a slug (`staging`, `prod`, anything URL-safe). Save. The environment starts empty.

### Add env vars

Inside the environment, navigate to "Environment variables". Add key-value pairs. Provider keys are added through the [Providers](/docs/providers) tab, but they live in the same store.

### Promote an agent

Agents do not auto-copy across environments. To promote:

```ts
const dev = await platos.agents.get({ scope: { env: "dev" }, agentId });
await platos.agents.create({ scope: { env: "prod" }, ...stripIds(dev) });
```

Or use the dashboard's "Clone to environment" action on the agent detail page. The cloned agent gets the same prompt, tools, and config; provider keys re-resolve against the destination environment's bindings.

### Switch in the UI

Top-left environment picker. The page reloads at the same path under the new env slug.

## Common pitfalls

- A provider key in `dev` does not auto-link to `prod`. Linking is per-environment by design; promote your prod key separately.
- Memory does not cross environments. Two agents with the same slug in `dev` and `prod` have completely separate memory pools. This is intentional; mixing dev test data and prod customer data is the worst kind of accident.
- The `PLATOS_TEST_MODE=true` env var enables test-only endpoints. Never set it in `prod`. The EOBD-22 audit caught a path that bypassed auth when test mode leaked; the fix is in, but the env var is dangerous.
- Renaming an environment changes its slug; the URL path changes; old bookmarks 404. Add an environment, migrate, then drop the old one if you need a rename.

## Related

- [Scope tuple and multi-tenancy](/docs/scope-and-multi-tenancy): the third tuple axis.
- [Providers](/docs/providers): provider keys are environment-scoped.
- [Encryption and secrets](/docs/encryption-and-secrets): env vars are encrypted at rest.
