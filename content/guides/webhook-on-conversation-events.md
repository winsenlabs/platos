---
slug: webhook-on-conversation-events
title: Subscribe to conversation events
description: Receive a signed POST every time a conversation starts, ends, or hits a safety event.
category: integrations
order: 60
questions:
  - "How do I subscribe to conversation events?"
  - "How do I verify the webhook signature?"
  - "Which payload shapes does each event type use?"
  - "How are retries handled when my endpoint is down?"
related:
  - embed-public-agent
---

# Subscribe to conversation events

Get a signed POST every time a conversation starts, a message is rated, an approval is requested, or a safety event fires.

## The goal

A webhook endpoint on your server that receives Platos events and processes them durably. After this, your CRM, alerting, or analytics pipeline reflects Platos activity in near-real-time.

## Steps

1. **Stand up an endpoint.**

   Any HTTP server can receive. Example with Express:

   ```ts
   import express from "express";
   import { createHmac, timingSafeEqual } from "node:crypto";

   const app = express();
   app.use(express.text({ type: "*/*" })); // raw body for signature verification

   app.post("/webhooks/platos", (req, res) => {
     const sig = req.headers["x-platos-signature"] as string;
     const ts = req.headers["x-platos-timestamp"] as string;
     const nonce = req.headers["x-platos-nonce"] as string;
     const body = req.body as string;

     const mac = createHmac("sha256", process.env.WEBHOOK_SECRET!)
       .update(`${ts}.${nonce}.${body}`)
       .digest("hex");

     if (!timingSafeEqual(Buffer.from(sig), Buffer.from(mac))) {
       return res.status(401).end();
     }
     if (Math.abs(Date.now() / 1000 - Number(ts)) > 60) {
       return res.status(401).end();
     }

     const event = JSON.parse(body);
     // Switch on event.event:
     // "conversation.created", "message.rated", "approval.requested", "safety.event", ...
     handleEvent(event);
     res.status(200).end();
   });

   app.listen(8080);
   ```

2. **Subscribe in Platos.**

   Settings -> Webhooks -> "New webhook". URL, topics (`conversation.created`, `message.created`, `safety.event`), save. Copy the secret; it is shown once.

3. **Test delivery.**

   The webhook detail page has a "Send test" button that posts a synthetic event. Confirm your endpoint accepts it and returns 200.

## Verify

- Real activity in Platos starts deliveries; the delivery log shows status 200.
- A simulated outage on your endpoint produces 3 retries (1s, 5s, 30s) before dead-letter; visible on the delivery log.
- Replays through the "Redeliver" button work.

## Idempotency

Each delivery carries a unique `event_id` (UUID). Deduplicate on it; deliveries can repeat under retry.

## Next steps

- [Embed a public agent](/guides/embed-public-agent) often pairs with `conversation.created` for lead capture.
- [Approve a tool call](/guides/approve-tool-call) shows how `approval.requested` events power your approval UI.
