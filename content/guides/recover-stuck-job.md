---
slug: recover-stuck-job
title: Recover a stalled Job
description: Diagnose status, runtime health, credentials, and retry policy without exposing vendor internals.
category: troubleshooting
order: 6
questions:
  - "Why is a Job still pending?"
  - "How do I recover a stalled Job?"
related:
  - jobs
  - observability
  - credential-inventory
---

# Recover a stalled Job

A Job that remains `PENDING` or `ACTIVE` usually points to unavailable execution capacity, invalid credentials, an unreachable dependency, or a handler that exceeded its timeout.

## 1. Confirm ownership and status

Open the Job in the correct Organization, Project, and Environment. Record its Job identifier, current status, last start time, retry count, and originating Turn when present.

## 2. Check runtime health

Verify the Platos worker process is healthy and can reach Postgres, Redis, the object store, and any handler dependency. If an external durable-runtime integration is configured, check that vendor connection separately.

## 3. Inspect the trace

Use the Job identifier to find correlated spans and safe errors. Distinguish a pending Job from an active handler with no recent heartbeat.

## 4. Repair the cause

Restore the missing credential or dependency, correct the handler, or increase the timeout only when the expected work genuinely needs more time. Avoid repeated manual retries while the root cause remains.

## 5. Retry safely

Use the Job retry action after confirming the handler is idempotent. The new retry metadata remains attached to the same public Job history.
