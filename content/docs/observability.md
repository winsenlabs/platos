---
slug: observability
title: Observability model
description: How Turns, Steps, Tool Calls, Jobs, costs, traces, metrics, and audit records fit together.
category: observability
order: 1
questions:
  - "What is the Platos observability model?"
  - "Where do cost and latency belong?"
  - "How do I correlate a Turn with Steps and Tool Calls?"
related:
  - monitoring
  - traces
  - metrics
  - costs
  - audit-log
---

# Observability model

Platos observability follows the domain hierarchy instead of inventing a second execution vocabulary.

## Correlation hierarchy

A Thread contains ordered Turns. Each Turn contains Steps, and each Step contains Tool Calls. Jobs are separate asynchronous work records. Use these durable identifiers as trace attributes and log correlation keys.

| Record | Primary signals |
| --- | --- |
| Turn | status, total cost, end-to-end latency, selected Agent Version |
| Step | model, token usage, immutable price snapshot, retry count, latency |
| Tool Call | tool identity, status, retry count, latency, safe error category |
| Job | status, schedule metadata, retry count, start and completion times |

## Transactional truth and analytical projection

Postgres is the source of truth. When a Turn is finalized, the same transaction creates an observability outbox record if an analytical sink is configured. A worker projects that record into ClickHouse. This prevents an unavailable analytical sink from changing the committed Turn result.

## Traces and metrics

OpenTelemetry spans use the same Turn, Step, Tool Call, Thread, Agent, Agent Version, Environment, Project, and Organization identifiers. Metrics aggregate those records for health, latency, token use, cache behavior, cost, approvals, and policy outcomes.

## Audit records

Audit records answer who changed configuration or approved a sensitive action. Tool Call audit records capture safe execution metadata and redacted inputs or outputs according to policy. Audit data is not a substitute for the execution hierarchy.

## Privacy

Observability data follows the same tenancy and erasure boundaries as transactional records. Subject identifiers must remain scoped, sensitive values must be redacted before export, and a hard-erasure receipt must verify the configured analytical sink rather than assuming deletion succeeded.
