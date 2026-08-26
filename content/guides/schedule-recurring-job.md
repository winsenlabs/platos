---
slug: schedule-recurring-job
title: Schedule a recurring Job
description: Attach a cron expression and time zone to Platos background work.
category: recipes
order: 9
questions:
  - "How do I schedule a recurring Job?"
  - "Which time zone does a Job schedule use?"
related:
  - jobs
  - observability
---

# Schedule a recurring Job

A scheduled Job keeps its input schema, handler, retry policy, and schedule metadata in one Environment-owned resource.

## 1. Create the Job

Choose a stable name and idempotent handler. Define the accepted input schema and a timeout appropriate for one occurrence.

## 2. Add the schedule

Set a five-field cron expression and an IANA time zone.

```json
{
  "cron": "0 9 * * 1",
  "timezone": "Europe/Amsterdam"
}
```

This starts the Job each Monday at 09:00 in Amsterdam time, including daylight-saving changes.

## 3. Verify the next occurrence

Confirm the UI shows the expected next timestamp. Test the handler manually with representative input before enabling the schedule.

## 4. Disable without deleting

Disable the schedule when pausing recurring work. The Job definition and prior history remain available for audit and can be enabled later.
