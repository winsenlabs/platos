---
slug: metrics
title: Metrics
description: Prometheus-style metrics endpoint and the custom dashboards that consume them.
category: observability
order: 40
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How do I scrape Platos metrics with Prometheus?"
  - "Which metrics are exposed by default?"
  - "How do I build a custom dashboard?"
  - "What is utilization and how is it computed?"
  - "How do I add a new metric from a skill?"
related:
  - traces
  - monitoring
  - costs
source_files_referenced:
  - apps/agent/src/monitoring/metrics.service.ts
  - apps/agent/src/monitoring/metrics.controller.ts
  - apps/agent/src/monitoring/utilization.service.ts
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboards.$dashboardKey/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboards.custom.$dashboardId/route.tsx
---

# Metrics

Platos exposes a Prometheus-compatible metrics endpoint at `/metrics` (gated on auth). The agent service ships a default set of process, runtime, and business metrics; you can add custom metrics from skills and sub-agents through the same `MetricsService`.

## What it is

`MetricsService` registers metrics with the standard Prometheus client. Default metrics:

- `platos_turns_total{agent, status}`: per-agent turn counter.
- `platos_turn_latency_ms{agent, p50/p95/p99}`: latency histograms.
- `platos_cost_cents_total{agent, lane}`: per-lane cost counter.
- `platos_tool_calls_total{agent, tool, status}`: tool call counter.
- `platos_memory_writes_total{agent, kind}`: per-kind memory writes.
- `platos_approvals_pending`: gauge of currently-pending approvals.
- `platos_safety_events_total{category, policy}`: per-category safety counter.
- `platos_rate_limit_hits_total{bucket}`: per-bucket rate limit hits.

Plus the standard process metrics (`process_resident_memory_bytes`, `nodejs_eventloop_lag_seconds`, etc.).

`UtilizationService` computes per-agent utilization (turns / max-concurrent) over rolling windows; surfaces it as a metric and on the dashboard.

The dashboards UI at `/dashboards/{dashboardKey}` and `/dashboards/custom/{id}` lets operators build custom panels over the same metric set without standing up Grafana.

## Why it matters

Logs are ad-hoc; metrics are queryable. Setting an SLO on `histogram_quantile(0.95, platos_turn_latency_ms)` is something you can alert on; setting one on a regex match in a log line is brittle. The default metric set covers 80% of agent operability concerns; the custom dashboards cover the rest without leaving the dashboard.

The Prometheus surface also makes Platos a first-class participant in your existing observability stack. Scrape it from your Prometheus, alert from your Alertmanager, render in your Grafana.

## How to use it

### Scrape

```yaml
scrape_configs:
  - job_name: platos
    bearer_token: $PROMETHEUS_BEARER
    static_configs:
      - targets: ["platos.example.com"]
    metrics_path: /metrics
```

The `PROMETHEUS_BEARER` is a PAT minted with the `metrics:read` scope.

### Build a custom dashboard

`/dashboards/custom/new`. Drag panels (counter, gauge, histogram, top-N table); each panel is a PromQL query with optional dashboard variables. Save; the dashboard is shareable within the project.

### Add a metric from a skill

```ts
import { metrics } from "@platos/agent/metrics";

const counter = metrics.counter("my_skill_calls_total", { labels: ["mode"] });
counter.inc({ mode: "fast" });
```

Skill-emitted metrics inherit the standard label set (agent, scope) plus your custom labels. They show up under the same `/metrics` endpoint.

### Utilization

`platos_utilization` is a gauge between 0 and 1. A sustained value near 1 means the agent is at concurrency cap; combine with [Queues](/docs/queues) depth to know whether to scale up the agent service.

## Common pitfalls

- Cardinality matters. A label on `userId` blows up your metrics store. Keep labels low-cardinality (agent, lane, status); use [Traces](/docs/traces) for per-user attribution.
- The default scrape interval is 15s; counter increments aggregate cleanly, but a fast histogram at 5s creates jitter in PromQL `rate()`. Tune scrape interval if you see spurious spikes.
- The metrics endpoint is auth-gated even on internal-only deploys. A misconfigured Prometheus without bearer fails silently with 401; check the scrape target health.
- Custom dashboards are stored in Postgres. A heavy dashboard with 30 panels sharing a complex PromQL can slow page load; split into multiple dashboards.

## Related

- [Traces](/docs/traces): per-turn span timeline (cardinality-friendly attribution).
- [Monitoring](/docs/monitoring): the lower-cardinality monitoring rollups.
- [Costs](/docs/costs): cost metrics derived from the same source.
