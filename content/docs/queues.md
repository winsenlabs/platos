---
slug: queues
title: Queues
description: trigger.dev queues that gate task concurrency. Each Platos environment has at least one queue per task type.
category: engine
order: 30
trigger_dev_primitive: true
trigger_dev_link: "https://trigger.dev/docs/v3/queues"
questions:
  - "What is a queue and why does Platos need them?"
  - "How do I set a per-environment concurrency limit?"
  - "How do I see how full a queue is?"
  - "How do I drain a queue safely?"
  - "What is the difference between a queue and a master queue?"
related:
  - runs
  - deployments
source_files_referenced:
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.queues/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.concurrency/route.tsx
---

# Queues

A queue is the engine-layer scheduler's primitive for ordering and concurrency-limiting [runs](/docs/runs). Each task gets a default queue; you can attach custom queues with explicit concurrency caps.

Platos uses trigger.dev as the durable execution engine. Queues are a trigger.dev concept that Platos surfaces in the dashboard for visibility. The semantics (concurrency limits, master queue routing, per-queue priority) are unchanged from upstream.

## In Platos

The Queues page at `/orgs/{org}/projects/{project}/env/{env}/queues` lists each queue with its current depth, dequeue rate, and concurrency cap. The Concurrency page at `/concurrency` shows the per-environment cap (the upper bound across every queue).

The most common Platos use of queues is bounding BGO concurrency. A heavy code-runner workload can be capped to N concurrent runs without throttling chat turns: assign the BGO task to its own queue with `concurrencyLimit: N`, leave chat-side tasks on the default queue.

A "stuck" run is usually a queue with `dequeueRate: 0` (worker pool is zero, see [Self-hosting](/docs/self-hosting)) or a queue paused via the dashboard. The status badge surfaces both.

## Reference

The full reference for queues lives in the trigger.dev docs:

**[trigger.dev/docs/v3/queues](https://trigger.dev/docs/v3/queues)**

## Related

- [Runs](/docs/runs): every run waits in a queue before execution.
- [Deployments](/docs/deployments): the deployed task version dictates which queue a run lands in.
