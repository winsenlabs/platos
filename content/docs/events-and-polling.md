---
slug: events-and-polling
title: Events, streaming, and polling
description: Consume current Platos state through Turn streams and generated REST resources without relying on an outbound webhook API.
category: dx
order: 70
questions:
  - "Does Platos publish outbound webhooks?"
  - "How do I stream a Turn?"
  - "How do I inspect a Job after dispatch?"
related:
  - streaming
  - openapi-and-rest
  - jobs
  - observability
---

# Events, streaming, and polling

The current public contract does not include a general outbound webhook registration, signing, retry, delivery-history, or redelivery API. Do not build integrations around undocumented webhook topics or dashboard pages.

Use the generated contracts that exist today:

- Stream one active Turn with `POST /api/v1/agent/threads/{threadId}/stream` or `@platosdev/client`'s `threads.send()` iterator.
- Read canonical Job definitions with `GET /api/v1/agent/jobs` and `GET /api/v1/agent/jobs/{id}`.
- Dispatch an active Job with `POST /api/v1/agent/jobs/{id}/dispatch`.
- Read evaluation rows through `GET /api/v1/agent/evals`.
- Read operational summaries through the `/api/v1/agent/monitoring/*` resources.

```ts
import { PlatosClient } from "@platosdev/client";

const client = new PlatosClient({
  baseUrl: "https://platos.example.com",
  sessionToken,
});

for await (const event of client.threads.send(threadId, "Prepare the report")) {
  if (event.type === "token") process.stdout.write(event.text);
  if (event.type === "done") break;
}
```

A Turn stream is scoped to the request that opened it; it is not a durable event bus. A successful Job dispatch response means the durable adapter accepted the request, not that background work completed. Persist the returned identifiers and reconcile them through the runtime or adapter observability available in your installation.

If an integration requires push delivery, place an operator-owned adapter beside Platos. Have it consume only documented REST or stream resources, define its own signing and retry contract, and keep that adapter outside the Platos public API vocabulary.
