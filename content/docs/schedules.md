---
slug: schedules
title: Job schedules
description: Start Jobs once or on a recurring cron expression.
category: platform
order: 11
questions:
  - "How do I schedule a recurring Job?"
  - "How do I schedule one future Job occurrence?"
related:
  - jobs
  - observability
  - budgets
---

# Job schedules

A schedule is metadata on a Job. It can identify one future instant or a recurring five-field cron expression with an IANA time zone.

Schedule evaluation is an execution-provider detail. The public record remains the Environment-owned Job, and every occurrence updates Job execution history and observability using the Job identity.

Use UTC for machine-to-machine schedules unless a business rule requires local time. For local schedules, verify daylight-saving behavior before enabling them.

Disable a schedule to pause future occurrences without deleting the Job or its history. Delete the Job only when its definition is no longer needed.
