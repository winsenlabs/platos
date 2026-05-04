---
slug: webhooks
title: Webhooks
description: Outbound HTTP webhooks for conversation lifecycle events, run state transitions, and safety hits.
category: dx
order: 70
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How do I subscribe to conversation events?"
  - "Which event types fire a webhook?"
  - "How are webhook payloads signed?"
  - "How are retries handled?"
  - "How do I see delivery history?"
  - "What is the recommended timeout for my webhook handler?"
related:
  - openapi-and-rest
  - safety-and-pii
  - audit-log
source_files_referenced:
  - apps/webapp/app/routes/api.v3.webhooks.ts
---

# Webhooks

Platos pushes lifecycle events to your URL via signed HTTP webhooks. Conversation created, message rated, approval pending, budget exceeded, safety event raised. Each event has a stable shape, an HMAC signature, an idempotency key, and a delivery history page.

## What it is

A `PlatosWebhook` row keyed on `(scope, url, secret)` with a list of subscribed topics. Topics include:

- `conversation.created`, `conversation.archived`, `conversation.deleted`.
- `message.rated`, `message.created`.
- `approval.requested`, `approval.resolved`, `approval.expired`.
- `budget.soft_warn`, `budget.exceeded`.
- `safety.event`.
- `agent.created`, `agent.version.created`, `agent.canary.promoted`.
- `bgo.completed`, `bgo.failed`.

Each delivery is signed with HMAC-SHA256 over `{ts}.{nonce}.{body}` using the webhook secret. The receiver verifies; the LRU nonce check prevents replay. Retries: 3 attempts with exponential backoff (1s, 5s, 30s), then dead-letter to the delivery log.

The delivery history page shows last 100 deliveries per webhook with status, response, and a "redeliver" action.

## Why it matters

Polling for state changes is wasteful. Webhooks let your downstream systems react to Platos in real time without holding open SSE streams. Hooking `safety.event` to your Slack channel is a five-minute setup; hooking `budget.exceeded` to your incident system is the difference between learning at 9am tomorrow vs at midnight tonight.

The signing scheme is identical to the entity HMAC nonce scheme (PPR-71). Reuse the verification code from `@platools/sdk` if you have an entity backend already.

## How to use it

### Subscribe

`/orgs/{org}/projects/{project}/env/{env}/settings/webhooks` -> "New webhook". Paste your URL, pick topics, copy the secret. The secret is shown once; save it.

### Verify a delivery

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(req: Request, secret: string) {
  const sig = req.headers.get("x-platos-signature");
  const ts = req.headers.get("x-platos-timestamp");
  const nonce = req.headers.get("x-platos-nonce");
  const body = await req.text();

  const mac = createHmac("sha256", secret).update(`${ts}.${nonce}.${body}`).digest("hex");
  if (!timingSafeEqual(Buffer.from(sig!), Buffer.from(mac))) throw new Error("bad sig");
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60) throw new Error("stale");
}
```

### Recommended handler

Respond 2xx within 5 seconds. Beyond 5 seconds Platos times out and retries. If your handler does heavy work, ack quickly and process async.

### Redeliver

A failed delivery on the history page has a "Redeliver" button. Same payload, fresh nonce, original event id. Use it after fixing your handler.

### Filter by topic

A webhook can subscribe to many topics; the body's `event` field tells you which one. Always switch on `event`; payload shapes differ.

## Common pitfalls

- Idempotency: deliveries can repeat. Each body carries `event_id` (UUID); deduplicate on it.
- The 60-second freshness window is strict; clients with skewed clocks will reject valid deliveries. Sync with NTP.
- Order is best-effort. Two events for the same conversation can arrive out of order under high concurrency. Use the `ts` field to reconcile.
- A flaky handler that fails three times lands in the dead-letter log. The log has a redeliver action, but high-volume topics filling the dead letter will need manual cleanup or a dedicated processing job.

## Related

- [OpenAPI and REST](/docs/openapi-and-rest): the inbound surface; webhooks are the outbound complement.
- [Safety and PII](/docs/safety-and-pii): the source of `safety.event`.
- [Audit log](/docs/audit-log): stores delivery attempts alongside admin actions.
