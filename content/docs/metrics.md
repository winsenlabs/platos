---
slug: metrics
title: Metrics endpoint
description: The agent process's source-defined Prometheus text exposition endpoint and bounded built-in metric set.
category: observability
order: 40
questions:
  - "Where does the agent expose metrics?"
  - "Which metric names exist?"
  - "Is the endpoint authenticated?"
related:
  - traces
  - monitoring
  - costs
---

# Metrics endpoint

The Agent service exposes Prometheus text format at `GET /metrics`. The route is intentionally unauthenticated in the application because the Compose profile binds port 3100 to loopback. If you expose the Agent service through a reverse proxy, protect `/metrics` with a network ACL or proxy authentication.

## Built-in metrics

`MetricsService` currently registers:

- `platos_turns_total{status}`
- `platos_tokens_total{direction,model,kind,provider}`
- `platos_memory_extraction_runs_total{status}`
- `platos_tool_calls_total{status}`
- `platos_turn_duration_seconds{status}`
- `platos_eval_score{suite}`
- `platos_ws_connections_active`
- `platos_approvals_pending`
- `platos_budget_utilization_ratio{cap_id,scope_type,period}`
- default Node.js process metrics under the `platos_process_` prefix

```http
GET /metrics
```

The endpoint returns the current `prom-client` registry snapshot with content type `text/plain; version=0.0.4`.

## Contract boundary

Platos does not expose a dashboard query editor, custom metrics panel builder, per-skill metrics registration package, or a `metrics:read` PAT scope in the current public contract. Configure scraping and queries in your operator-owned observability stack.

Keep labels bounded. Tenant and end-user identifiers are intentionally absent from the process metric labels; use scoped monitoring records or traces for tenant-level analysis.
