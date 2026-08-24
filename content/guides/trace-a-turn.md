---
slug: trace-a-turn
title: Trace a Turn
description: Follow a Turn through Steps, Tool Calls, cost, and correlated Jobs.
category: troubleshooting
order: 4
questions:
  - "How do I trace a Turn?"
  - "How do I find the slow Step or Tool Call?"
related:
  - turns
  - traces
  - observability
---

# Trace a Turn

1. Open the Thread and select the Turn identifier.
2. Open the trace view. The root span represents the Turn.
3. Expand child Step spans to compare model latency and token usage.
4. Expand Tool Call spans to inspect status, retry count, latency, and redacted arguments or results.
5. Follow any linked Job identifier separately; a Job is asynchronous and does not become a child Turn.
6. Compare trace data with the persisted Turn and Step records before closing an incident.

A missing analytical projection does not mean the Turn is missing. Postgres remains authoritative; check observability outbox health when a committed Turn has no trace projection.
