---
slug: schedule-recurring-task
title: Schedule a recurring task
description: Use schedule_bgo to run a Platos task on a cron expression.
category: recipes
order: 60
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How do I schedule a daily summary task?"
  - "What cron syntax does Platos accept?"
  - "How do I see the next run time?"
  - "How do I disable a schedule without deleting it?"
related:
  - spawn-bgo
source_files_referenced:
  - apps/agent/src/agent-runtime/agent.service.ts
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.new/route.tsx
---

# Schedule a recurring task

Run a Platos task on a cron expression. Useful for daily summaries, periodic data syncs, or scheduled customer follow-ups.

## The goal

A schedule that fires at a fixed cadence and produces a [run](/docs/runs) (typically a BGO) on each fire.

## Steps

1. **Pick the task.**

   You need an existing trigger.dev task to schedule against. For agent-driven recurrence, use `agent-tool-block.task.ts` with a fixed prompt.

2. **Create the schedule.**

   Sidebar -> Schedules -> "New schedule". Set:
   - Task: pick the task slug.
   - Cron: standard cron expression (e.g. `0 9 * * *` = 9am daily UTC).
   - Timezone: UTC default; pick your local zone.
   - Inputs: payload passed to the task on each fire.

3. **Save.**

   The schedule starts firing immediately. The next run time is shown on the schedule row.

## Verify

- The Schedules page shows the schedule with a green "active" badge.
- After the next fire, the Runs page lists a new run with the schedule's id.
- The output message lands wherever the BGO was configured to post.

## From an agent

For one-off scheduling from an agent's tool call, use `schedule_bgo` instead of creating a Schedule row:

```text
schedule_bgo({
  prompt: "Send the weekly digest",
  runAt: "2025-05-11T09:00Z"
})
```

This wraps `wait.forToken` and respects the agent's scope.

## Disable without deleting

Schedules page -> row toggle. The schedule stays defined but does not fire.

## Next steps

- [Spawn a long-running task](/guides/spawn-bgo) for one-off BGOs.
- [Recover a stuck run](/guides/recover-stuck-run) if a fire produces a hung run.
