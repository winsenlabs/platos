---
slug: domain-vocabulary
title: Domain vocabulary
description: Canonical Platos nouns for agent work, background work, configuration, and observability.
category: platform
order: 1
questions:
  - "What do Turn, Step, Tool Call, Job, and Agent Version mean?"
  - "Which words should integrations use for Platos resources?"
related:
  - agents
  - turns
  - jobs
  - agent-versions
---

# Domain vocabulary

Platos uses one public noun for each concept. API clients, SDKs, dashboard labels, and documentation use the same names.

## Core resources

| Noun | Meaning | Public collection |
| --- | --- | --- |
| **Agent** | A configured AI worker that owns prompts, tools, models, memory policy, and budgets. | `/agents` |
| **Agent Version** | An immutable snapshot of an Agent's executable configuration. | `/agent-versions` |
| **Thread** | A durable conversation containing ordered Turns. | `/threads` |
| **Turn** | One accepted input and its completed Agent response. This is the billable unit. | `/turns` |
| **Step** | One model invocation within a Turn. | `/steps` |
| **Tool Call** | One invocation of a Tool within a Step. | `/tool-calls` |
| **Job** | Platos-owned asynchronous background work. | `/jobs` |
| **Entity** | A connected external system that supplies Tools. | `/entities` |
| **Skill** | Reusable, versioned instructions an Agent can enable. | `/skills` |
| **Memory** | Knowledge retained beyond the current prompt or Turn. | `/memories` |
| **Artifact** | A durable file or structured output produced by an Agent. | `/artifacts` |

## Ownership hierarchy

An **Organization** is the tenant and security root. A **Project** groups related resources and access. An **Environment** isolates configuration, credentials, data, connected Entities, traffic, and policy inside one Project.

An Environment is not a release stage. Promote Agent configuration by selecting an Agent Version and, when needed, configuring a canary rollout.

## Runtime tools and meta-tools

A **runtime tool** is a normal callable capability supplied by Platos, such as `remember`, `recall`, or `spawn_job`.

A **meta-tool** is only a router. Platos reserves that term for `find_tools` and `execute_tools`.

## External durable execution

An optional external vendor adapter can provide durable execution. Vendor identifiers and terminology stay at that adapter boundary. Platos records user work as Turns and background work as Jobs regardless of which execution provider performs the work.
