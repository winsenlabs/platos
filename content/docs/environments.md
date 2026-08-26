---
slug: environments
title: Environments
description: Project-scoped isolation for credentials, configuration, data, traffic, and policy.
category: governance
order: 3
questions:
  - "What does an Environment isolate?"
  - "Is an Environment a release stage?"
related:
  - tenancy
  - agent-versions
  - providers
---

# Environments

An Environment is a Project-scoped isolation boundary. It owns credentials, Agent bindings, Threads, Turns, Entities, Jobs, memory, observability data, traffic, and policy.

Names such as `development`, `staging`, and `production` are operator conventions only. Platos does not encode a promotion ladder between Environments.

Promote Agent behavior by selecting an immutable Agent Version in the target Environment binding. A canary binding can route a stable percentage of Threads to a candidate version.

Credentials never fall back across Environments. Persisted ancestry determines authority, and cross-Environment names or identifiers fail without revealing whether the resource exists elsewhere.
