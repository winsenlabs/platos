---
slug: runs
title: Runs
description: Execution records of trigger.dev tasks. The engine-layer primitive behind every BGO and tool block.
category: engine
order: 10
trigger_dev_primitive: true
trigger_dev_link: "https://trigger.dev/docs/v3/runs"
questions:
  - "What is a run and how does it relate to a Platos BGO?"
  - "How do I find the run that backed a specific tool call?"
  - "How do I cancel a running run?"
  - "Why is my run stuck in DEQUEUED?"
  - "How do I replay a failed run?"
  - "Where do run logs go?"
related:
  - platos-tasks
  - schedules
  - queues
  - deployments
  - traces
source_files_referenced:
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs._index/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.stream/route.tsx
---

# Runs

A run is one execution attempt of a trigger.dev task. Every BGO an agent spawns, every scheduled task, every batch item produces at least one run.

Platos uses trigger.dev as the durable execution engine. Run is a trigger.dev concept that Platos surfaces in the dashboard for visibility. The semantics (queueing, retries, attempts, cancellation, machine selection, log capture) are unchanged from upstream.

## In Platos

The `Runs` page at `/orgs/{org}/projects/{project}/env/{env}/runs` lists every run for the active environment. Filter by status, task identifier, or time window. Click a run to see its log stream, span timeline, and result.

When you click into a [Platos task (BGO)](/docs/platos-tasks), the BGO detail surface links to the underlying run. That is the single click between "the agent dispatched this BGO" and "here is the engine-level execution record". Span events from the run feed [Traces](/docs/traces) so the BGO timeline composes with the originating turn.

For "stuck" runs, see the [Recover a stuck run](/guides/recover-stuck-run) recipe; the most common cause is a worker pool sized to zero or a queue paused at the engine layer.

## Reference

The full reference for runs lives in the trigger.dev docs:

**[trigger.dev/docs/v3/runs](https://trigger.dev/docs/v3/runs)**

## Related

- [Platos tasks](/docs/platos-tasks): the Platos surface that spawns runs.
- [Schedules](/docs/schedules): scheduled triggers create runs.
- [Queues](/docs/queues): the queue a run waits in before execution.
- [Deployments](/docs/deployments): a run executes against a specific deployment of a task.
- [Traces](/docs/traces): turn timelines compose run spans.
