---
slug: recover-stuck-run
title: Recover a stuck run
description: Diagnose and recover a run that's stuck DEQUEUED or running too long.
category: troubleshooting
order: 30
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "Why is my run stuck in DEQUEUED?"
  - "How do I cancel a stuck run safely?"
  - "How do I clear a backed-up queue?"
  - "What does the engine repair-queues admin endpoint do?"
related:
  - trace-a-turn
source_files_referenced:
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs._index/route.tsx
  - apps/webapp/app/routes/admin.api.v1.environments.$environmentId.engine.repair-queues.ts
---

# Recover a stuck run

A run sits in `DEQUEUED` or `EXECUTING` past its expected window. Diagnose, then recover.

## The goal

The run completes (or is cleanly cancelled), the queue depth comes back to normal, and you understand which fault caused the stick.

## Steps

1. **Check the run page.**

   `/runs/{runId}`. Note the current status, the time it dequeued, the deployment it targeted, and the queue.

2. **Check the queue.**

   `/queues`. Find the queue this run is in. Look at:
   - **Concurrency**: at cap means newer runs wait.
   - **Dequeue rate**: zero means workers are not picking up runs.

3. **If dequeue rate is 0:**

   Workers are not pulling. Possible causes:
   - Worker pool sized to 0 (Kubernetes deployment scaled down).
   - Engine paused at the queue level (admin action).
   - All workers are blocked on a single long task.

   Recover: scale workers up; resume the queue; cancel the long-running blocker.

4. **If dequeue rate is healthy but the run is stuck running:**

   The task itself is hung. Likely causes:
   - Tool call awaiting an entity backend that is offline. Check entity status.
   - Waitpoint without a resume. Check `/waitpoints/tokens` for the run.

   Recover: resume the waitpoint manually with the right body, or cancel the run.

5. **Cancel the run.**

   Run page -> "Cancel". The runtime drops the engine task; downstream messages emit a synthetic "cancelled" entry.

6. **Repair queues (admin only).**

   When the queue's internal state has drifted (rare, usually after a partial outage), an admin can call:

   ```bash
   curl -X POST https://platos.example.com/admin/api/v1/environments/{envId}/engine/repair-queues \
     -H "Authorization: Bearer $ADMIN_PAT"
   ```

   This walks the queue and reconciles state. Use sparingly.

## Verify

- Queue depth returns to normal.
- The cancelled or completed run shows the expected terminal status.
- New runs flow through without delay.

## Common findings

- Self-host with the worker pool scaled to 0 is the most common "stuck" cause.
- An entity backend deployed but unreachable (DNS, firewall) hangs every tool call until the per-call timeout.
- A waitpoint without a downstream resumer (e.g. an approval that nobody can resolve).

## Next steps

- [Trace the turn](/guides/trace-a-turn) for forensic detail.
- See [Self-hosting](/docs/self-hosting) for worker pool sizing guidance.
