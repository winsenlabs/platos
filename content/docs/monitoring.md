---
slug: monitoring
title: Monitoring
description: Per-agent and per-user monitoring dashboards with cost, request volume, and ratings.
category: observability
order: 10
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "Where do I see usage per user across all agents?"
  - "How is the 7-day cost calculated?"
  - "Can I sort users by cost vs request volume?"
  - "How do I drill from a user into their conversations?"
  - "What does the monitoring index page show vs the users tab?"
  - "Why do some users show no cost?"
related:
  - costs
  - traces
  - metrics
source_files_referenced:
  - apps/agent/src/monitoring/monitoring.module.ts
  - apps/agent/src/agent-runtime/agent.controller.ts
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-monitoring._index/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-monitoring.users._index/route.tsx
---

# Monitoring

The monitoring surface rolls up per-agent and per-user activity into one operator view: who is talking to which agent, how much they cost, how their ratings trend. Three tabs: index (project summary), users (per-user breakdown), agents (per-agent breakdown).

## What it is

Three views over the same underlying ClickHouse rollup tables:

- **Index** at `/agent-monitoring`: project-wide totals, top agents by cost, top users by request count, satisfaction trend.
- **Users** at `/agent-monitoring/users`: every user with their `requestCount`, `cost7dCents`, `rating7d`, `lastSeenAt`. Sortable, paged, drill-into-detail.
- **Agents** at `/agent-monitoring/agents`: every agent with the same shape, plus per-version usage and the canary split.

The user detail page (PIFSP-19) shows a single user's activity across every agent, with conversation drill-through, per-agent rating history, and a manual summary action that calls a cheap LLM to write a per-user briefing.

`agent.controller.ts` exposes the `monitoring/users`, `monitoring/agents`, and `monitoring/users/:userId` endpoints. The cost rollup is read from ClickHouse for fast pivots; the row counts are Postgres-derived.

## Why it matters

Per-thread cost is interesting; per-user cost across every thread is actionable. "User X has been chatting with Wally and Vega today and racked up $40" is the kind of observation that catches a quietly-leaking integration before it becomes the month-end invoice surprise.

The user-detail page also doubles as the GDPR-investigation surface: every memory, every thread, every safety event for one user, in one view.

## How to use it

### Spot top spenders

Index page top-right tile shows top 5 users by 7-day cost. Click through to user detail. The per-user page lists every thread they participated in; click a thread to land on the conversation.

### Sort users by request volume

Switch sort on the Users tab to `requestCount`. Useful for support workflows: "user Y hit the chat 200 times today, what are they trying to do?".

### Drill from user to thread

Click a user, scroll the threads list, click a thread. Lands on the chat panel with that thread loaded; toggle Postman mode to inspect the pipeline.

### Manual summary

User detail page has a "Generate summary" button. Calls `POST /monitoring/users/:userId/summary` which runs a cheap-model summarisation over the user's messages and stores the result. Useful for pre-shift briefings; cost lands in the auto-name lane on [Costs](/docs/costs).

## Common pitfalls

- The shared `cost7dCents` field is declared on three interfaces in the users route file (drift D-004). A future rename has to update all three; the field is consistent today, but the lack of a shared type is a maintenance trap. Keep the dashboards in sync if you touch one interface.
- Some users show zero cost because they only ever sent free turns (e.g. cached prompt prefixes with no model call). Cost is real spend, not message count.
- The 7-day window is rolling on UTC midnight. A new user from yesterday shows up after their first request lands in the rollup; expect a 5-10 minute lag.
- ClickHouse rollups depend on the cost-reconcile schedule (PPR-24). If the schedule is paused, monitoring numbers will lag. Check the [Schedules](/docs/schedules) tab.

## Related

- [Costs](/docs/costs): the deeper per-lane spend rollup.
- [Traces](/docs/traces): the per-turn span timeline behind monitoring entries.
- [Metrics](/docs/metrics): the Prometheus-shaped exports for external dashboards.
