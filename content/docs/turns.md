---
slug: turns
title: Turns, Steps, and Tool Calls
description: The canonical execution hierarchy for one user input and the Agent response.
category: platform
order: 8
questions:
  - "What is a Turn in Platos?"
  - "How do Steps and Tool Calls relate to a Turn?"
  - "What does Platos bill as one unit of work?"
related:
  - conversations-and-threads
  - traces
  - costs
  - domain-vocabulary
---

# Turns, Steps, and Tool Calls

A **Turn** is one accepted input and its completed Agent response. It belongs to a Thread and records the exact Agent Version selected for that work.

## Execution hierarchy

```text
Thread
└── Turn
    ├── Step
    │   └── Tool Call
    └── Step
```

A Turn may need several Steps. Each Step is one model invocation. A Step may contain zero or more Tool Calls, and each Tool Call stores validated arguments, result, status, retry count, timing, and error metadata.

## Status and revisions

Turns, Steps, and Tool Calls use `PENDING`, `ACTIVE`, `SUCCEEDED`, `FAILED`, or `CANCELLED`. Waiting is represented by the status of the owning record instead of a separate public resource.

Editing an earlier message creates a revised Turn linked through `parentTurnId`. The original record remains available for audit and comparison.

## Billing and cost

The Turn is the billable work-count unit. Model and cache usage are recorded on Steps, while Tool Call timing and outcome remain attached to each capability invocation. A Turn with three model invocations and four Tool Calls still counts as one completed Turn.

## API direction

Canonical resource collections are `/turns`, `/steps`, and `/tool-calls`. Thread message and stream endpoints may create those records as one operation; clients should treat the returned Turn identifier as the durable execution identity.
