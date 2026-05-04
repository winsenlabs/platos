---
slug: schedules
title: Schedules
description: Cron-style and one-shot scheduled trigger.dev tasks. Used by Platos for cost reconcile, approvals expiry, and memory extraction.
category: engine
order: 20
trigger_dev_primitive: true
trigger_dev_link: "https://trigger.dev/docs/v3/tasks-scheduled"
questions:
  - "How do I schedule a recurring task?"
  - "How do I run a task once at a specific time?"
  - "What scheduled tasks does Platos ship by default?"
  - "How do I see which schedules are active?"
  - "How do I disable a schedule without deleting it?"
related:
  - runs
  - platos-tasks
source_files_referenced:
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.$scheduleParam/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.new/route.tsx
---

# Schedules

A schedule is a cron-style or one-shot trigger that fires a task. Each fire creates a [run](/docs/runs).

Platos uses trigger.dev as the durable execution engine. Schedules are a trigger.dev concept that Platos surfaces in the dashboard for visibility. The cron syntax, the timezone handling, and the firing semantics are unchanged from upstream.

## In Platos

The Schedules page at `/orgs/{org}/projects/{project}/env/{env}/schedules` lists every schedule attached to a task in this environment. Click "New schedule" to attach a cron or a future timestamp. Disable without deleting via the row toggle.

Platos ships two default scheduled tasks:

- **Cost reconcile** (PPR-24): periodically reconciles ClickHouse cost rows against provider billing API where the provider exposes one. Surfaces drift on the [Costs](/docs/costs) view.
- **Approvals expiry sweep** (PPR-67): cancels [approvals](/docs/approvals-and-hitl) past their SLA and emits the corresponding tool result.

For one-shot scheduling from an agent's tool call, prefer `schedule_bgo` over creating a Schedule row by hand; the meta-tool wraps `wait.forToken` and respects the agent's scope and budget.

## Reference

The full reference for scheduled tasks lives in the trigger.dev docs:

**[trigger.dev/docs/v3/tasks-scheduled](https://trigger.dev/docs/v3/tasks-scheduled)**

## Related

- [Runs](/docs/runs): each schedule fire produces a run.
- [Platos tasks](/docs/platos-tasks): `schedule_bgo` is the agent-level surface for one-shot scheduling.
