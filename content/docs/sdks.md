---
slug: sdks
title: SDKs (TypeScript and Python)
description: First-party client libraries for Platos, including the consumer @platosdev/client and the entity-side platools SDKs.
category: dx
order: 30
questions:
  - "Which SDK do I install for which use case?"
  - "What is the difference between @platosdev/client and @platosdev/platools-sdk?"
  - "How do I use the Python platools SDK?"
  - "How do I stream a turn with the SDK?"
  - "Where are SDK packages published?"
  - "How do I extend the SDK with a custom tool?"
related:
  - openapi-and-rest
  - mcp-gateway
  - connected-entities
---

# SDKs (TypeScript and Python)

Platos ships first-party SDK packages on **npm** and **PyPI**. They split along the trust boundary: `@platosdev/client` and `platos-client` are for code that talks to Platos as a consumer (your app, your dashboard); `@platosdev/platools-sdk` and `platools` are for entity backends that talk to Platos over the WebSocket.

## What it is

| Package | Registry | Side | Purpose |
|---|---|---|---|
| `@platosdev/client` | npm | Consumer (your app) | TypeScript / JS client for the Platos REST + WS surface. |
| `platos-client` | PyPI | Consumer (your app) | Python equivalent — same shape, same wire protocol. |
| `@platosdev/react-widget` | npm | Consumer (React UI) | Drop-in React FAB chat widget. Built on `@platosdev/client`. See [React widget](/docs/react-widget). |
| `@platosdev/embed` | npm | Consumer (HTML) | `<platos-agent>` web component for non-React HTML pages. Iframe-isolated. |
| `@platosdev/token-mint` | npm | Backend (Node) | Helper for minting Platos session tokens with the right HS256 + claim shape. |
| `@platosdev/platools-sdk` | npm | Entity backend (Node) | TypeScript SDK for connecting an entity, declaring tools, and serving tool calls over WebSocket. |
| `platools` | PyPI | Entity backend (Python) | Python SDK with the same surface as the Node version. |

`@platosdev/client` covers `agents.*`, `threads.*`, `messages.*`, `approvals.*`, `budgets.*`, `monitoring.*`, and `tools.*`. Thread attachments are selected through `threads.send(..., { attachmentIds })`; the client does not expose a first-party `attachments.*` namespace.

The platools packages cover entity registration: declare tools, handle the WebSocket lifecycle (auth, reconnect, replay), sign HMAC nonces, and dispatch tool calls. The Python and Node implementations are kept feature-equivalent.

## Why it matters

A first-party SDK takes the gnarly bits (signing, reconnection, scope-header threading) off the integrator's plate. Both sides of the trust boundary need one; otherwise you ship a Postman collection plus an aspirational README and watch every customer reinvent the wheel.

The split is also what lets `@platosdev/client` be safe to ship to the browser. It does not know about service secrets, only about session tokens minted by the consumer's backend. Bundle it into your React app; never bundle the platools packages.

## How to use it

### Install

```bash
npm install @platosdev/client
npm install @platosdev/platools-sdk          # Node entity backend
pip install platools                # Python entity backend
```

### Consumer SDK: list agents

```ts
import { PlatosClient } from "@platosdev/client";

const platos = new PlatosClient({
  baseUrl: "https://platos.example.com",
  sessionToken,
});

const agents = await platos.agents.list();
```

### Consumer SDK: stream a turn

```ts
const stream = platos.threads.send(threadId, "Hi");

for await (const event of stream) {
  if (event.type === "token") process.stdout.write(event.text);
  if (event.type === "artifact_committed") console.log("artifact", event.artifactId);
}
```

### Consumer SDK: rate a message (thumbs up/down)

Collect end-user feedback on assistant replies. A thumbs-down also feeds the
memory-quality loop (the memories extracted from that message are quarantined
from future retrieval); ratings roll up into the per-version satisfaction views
on the Evals and Monitoring dashboards.

Rate against the **server** message id, surfaced on the `message_persisted`
stream event (not the provisional id you may assign client-side):

```ts
let serverMessageId: string | undefined;
for await (const event of platos.threads.send(threadId, "Hi", { agentId })) {
  if (event.type === "token") process.stdout.write(event.text);
  if (event.type === "message_persisted") serverMessageId = event.messageId;
}

// thumbs up (optionally with a comment); "down" maps to -1
await platos.messages.rate(serverMessageId!, "up");
await platos.messages.rate(serverMessageId!, "down", { comment: "missed the ask" });

// remove the vote, or read current vote + anonymized aggregate counts
await platos.messages.unrate(serverMessageId!);
const { userRating, aggregate } = await platos.messages.getForMessage(serverMessageId!);
// aggregate → { ups: number, downs: number }
```

The `@platosdev/react-widget` wires this for you: `usePlatosChat` returns a
`rate(messageId, "up" | "down")` callback and `<PlatosFab>` renders the thumbs
on each assistant bubble — see the [React widget](/docs/react-widget) doc.

### Entity SDK (Node)

```ts
import { Platools } from "@platosdev/platools-sdk";
import { z } from "zod";

const platools = new Platools({
  url: process.env.PLATOS_URL,
  secret: process.env.PLATOS_SERVICE_SECRET,
});

platools.tool(
  {
    name: "send_email",
    input: z.object({ to: z.string().email(), body: z.string() }),
    output: z.object({ ok: z.boolean() }),
    auth: "user",
  },
  async (args, ctx) => {
    // ctx.userToken is X-Platos-User-Token, opaque to us, verified by our auth.
    await mailer.send(args);
    return { ok: true };
  },
);

await platools.connect();
```

### Entity SDK (Python)

```python
from platools import Platools

async def main():
    platools = Platools(url=PLATOS_URL, secret=PLATOS_SERVICE_SECRET)

    @platools.tool(name="send_email", auth="user")
    async def send_email(to: str, body: str, ctx=None) -> dict[str, bool]:
        await mailer.send({"to": to, "body": body})
        return {"ok": True}

    await platools.connect()
```

### Extend with a custom tool

Both entity SDKs let you register N tools. They are pushed at handshake; calls dispatch to your registered handler. No build step; the tool catalogue is dynamic.

## Common pitfalls

- `@platosdev/client` ships under MIT and uses fetch streams for SSE; in Node 18+, no polyfill needed. In older Node, install `node-fetch`.
- `@platosdev/platools-sdk` (Node) and `platools` (Python) enforce HMAC nonces with an LRU. Replays of the same nonce within the window fail. If you wrap the SDK behind another layer that retries, ensure the wrapper does not duplicate-sign.
- The Python SDK pins to Python 3.10+ for the structural pattern matching it uses internally.
- Browser usage of `@platosdev/client` requires session tokens minted by your backend; do not ship a PAT to the browser.

## Related

- [OpenAPI and REST](/docs/openapi-and-rest): the underlying surface every SDK wraps.
- [MCP gateway](/docs/mcp-gateway): the alternate path (MCP) that bypasses the SDK for tool-using clients.
- [Connected entities](/docs/connected-entities): the entity registration flow the entity SDKs implement.
