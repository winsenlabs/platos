---
slug: traces
title: Traces
description: OpenTelemetry-style trace view of a single turn, with prompt + tool spans + cost samples.
category: observability
order: 20
questions:
  - "How do I view the trace for a specific turn?"
  - "Where are spans stored?"
  - "How long is trace data retained?"
  - "How do I add a custom span from inside a skill?"
  - "Where are timeline events shown vs span attributes?"
  - "How is trace cost different from billed cost?"
related:
  - monitoring
  - costs
  - metrics
---

# Traces

A trace is the structured span timeline of a single turn. Prompt assembly, model call, each tool call, each memory write, each retrieval round-trip is its own span with start, end, attributes, and timeline events. Open the trace view on a thread and you see the whole turn unfold in one waterfall.

## What it is

Two stores, gated on `PLATOS_OTEL_CLICKHOUSE_URL`:

- **Primary**: ClickHouse `platos_spans_v1` table (PPR-15). Long retention, fast aggregate queries.
- **Fallback**: Redis sorted-set, keyed on `traceId`. Short retention; used when ClickHouse is not configured or unavailable.

`TraceService` orchestrates: it reads from ClickHouse first, falls back to Redis. `SpansService` writes; every span is dual-written to both stores during the rollover window.

Each span carries:

- `traceId`, `spanId`, `parentSpanId`.
- `name` (e.g. `prompt.assemble`, `model.call`, `tool.execute`, `memory.recall`).
- `startNs`, `endNs`.
- `attributes`: free-form key-value (model id, tool name, token counts, retrieval result count).
- `events`: timeline points within the span (cache hit, retry, abort, finish reason).

The ClickHouse row also has dedicated identity columns: `organization_id`, `project_id`, `environment_id`, `agent_id`, `thread_id`, `user_id` (the SHA256-hashed `lead-<hash>`), plus `user_display_name` and `user_email` (plaintext, only populated when the session token's `userMeta` claim was signed in by the entity — see [Auth modes](/docs/auth-modes)). Splitting plaintext PII off the indexed id column means a deletion request can null the PII columns without touching the canonical id, which keeps cost rollups and trace lookups intact.

The trace view at `/agents/{agentId}/trace/{threadId}` renders the timeline waterfall with hover-detail per span.

## Why it matters

Aggregate metrics tell you something is slow. A trace tells you why. A turn that takes 12 seconds: was it 8 seconds in the model call, 2 seconds in retrieval, 1 second in tool dispatch, 1 second in memory write? The trace says.

Tracing is also the only way to see prompt-cache behaviour. Each `prompt.assemble` span carries `cacheLayer1Hit: true | false` and the same for layer 2. A regression in cache hit rate shows up immediately on the trace before it shows up on the cost dashboard.

## How to use it

### View a turn's trace

Open the chat panel, click the trace icon next to a message. Or navigate directly to `/agents/{agentId}/trace/{threadId}` and scroll to the turn.

### Filter spans

The trace view has filters: by span name, by minimum duration, by attribute. Useful for "show me every tool call over 1 second on this thread".

### Add a custom span

Inside a skill or a sub-agent, use the trace context:

```ts
import { trace } from "@platos/agent/trace";

await trace.span("my.custom.op", { foo: "bar" }, async () => {
  await doWork();
});
```

The span auto-attaches to the current parent span and shows up in the trace view alongside built-in spans.

### Timeline events

Inside a span, emit timeline events for points-in-time without their own span:

```ts
trace.event("retry-retry", { retry: 2 });
```

Renders as a vertical pip on the span row. See the span-timeline-events skill for the full event catalogue.

### Trace cost

Each `model.call` span carries `costCents`. Sum across the turn for the per-turn spend. This is the source of [Costs](/docs/costs) data; small drift is expected (the cost rollup batches; trace is per-span).

## Common pitfalls

- ClickHouse retention defaults to 30 days. Long-tail forensic traces fall off after that. For longer retention, raise `PLATOS_OTEL_CH_TTL_DAYS` or use the export endpoint to archive.
- The Redis fallback caps at 1000 spans per trace. Very long-running Jobs can exceed and lose tail spans on Redis-only deploys.
- Spans without a parent (orphan turns) render under a synthetic root. If many turns show up as orphans, your custom code is starting spans without inheriting the request context.
- Trace cost can drift from billed cost when a turn is cancelled mid-stream. The cancel emits a synthetic `cost-finalize` event; the trace shows the partial; the cost row shows the actual charge.

## Related

- [Monitoring](/docs/monitoring): the per-agent and per-user roll-ups.
- [Costs](/docs/costs): the per-lane spend that traces feed.
- [Metrics](/docs/metrics): the Prometheus-shaped exports of trace-derived metrics.
