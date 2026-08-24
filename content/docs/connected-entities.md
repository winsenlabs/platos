---
slug: connected-entities
title: Connected entities
description: External backends that connect to Platos over WebSocket and expose their tools to agents without exposing their data.
category: platform
order: 70
questions:
  - "What is a connected entity?"
  - "How does an entity authenticate with Platos?"
  - "What is the service secret and where does it live?"
  - "How do tool calls reach the entity backend?"
  - "What is HMAC nonce signing and why does each request need a fresh nonce?"
  - "How do I rotate an entity's service secret?"
  - "What is the wire test on the entity detail page?"
  - "Why does the entity backend never see Platos's database?"
related:
  - tools
  - auth-modes
  - mcp-gateway
  - encryption-and-secrets
---

# Connected entities

A connected entity is an external backend (your service, a SaaS adapter, a microservice) that holds a long-lived WebSocket to Platos and exposes its tools to agents. The entity owns its data and its auth. Platos sees only tool names, schemas, and call results, never the underlying business data.

## What it is

An `Entity` record plus a live connection. The safe Entity row exposes:

- `entityId` and `displayName`: the external identifier and label within a Project.
- `connectionKind`: `wire` for an inbound platools connection or `mcp` for an outbound MCP client.
- `connectionStatus`: `connected` or `disconnected`, updated by connection or discovery state.
- `mcpUrls`, `allowedOrigins`, and connection metadata appropriate to the selected kind.

For a wire Entity, Platos stores the service secret as an encrypted Environment credential and reveals the raw value only when it is created or rotated. Secret material is not a field on the safe Entity response.

The entity opens a raw WebSocket connection through the platools `/tools/sync` transport. The SDK normalizes that base URL to `/tools/sync/ws/sdk`, sends the service secret as a bearer credential, and identifies the Entity with the `entity` query parameter. `tool-sync-ws.service.ts` attaches an early-message buffer before asynchronous authentication and replays those frames after the secret verifies.

After auth, the entity pushes its tool catalogue. The registry mirrors the catalogue per scope, the agent matrix picks it up, and tool calls dispatch back to the entity over the same socket.

## Why it matters

The model where Platos owns the data and the entity is "just a webhook" loses every time a customer asks about compliance, GDPR, or data residency. The entity-owned model means:

- Business data never crosses Platos's storage boundary. The entity reads from its own database, returns the result, and Platos forwards it to the agent.
- Auth is the entity's. Platos rides on a session token that may carry an opaque user-token claim; the entity verifies that claim with its own auth stack.
- Reconnection is the entity's responsibility. The Platos client SDKs (`@platosdev/platools-sdk` for Node, `platools` for Python) handle backoff and replay locally.

That ownership split is what makes Platos self-hostable as an runtime without becoming a customer's data plane.

## How to use it

### Register an entity

From the dashboard, navigate to `/orgs/{org}/projects/{project}/env/{env}/agent-entities/new`. Provide a slug and name; the dashboard mints a fresh `serviceSecret`, shows it once on the initial-secret page (loaded via Redis GETDEL so it cannot be replayed), and writes the row.

```bash
curl -X POST https://platos.example.com/api/v1/agent/entities \
  -H "Authorization: Bearer $PAT" \
  -H "X-Platos-Organization-Id: $ORG" \
  -H "X-Platos-Project-Id: $PROJECT" \
  -H "X-Platos-Environment-Id: $ENV" \
  -d '{"slug":"my-entity","name":"My entity","entityType":"custom"}'
```

### Connect from your backend

Use `@platosdev/platools-sdk` (Node) or `platools` (Python):

```ts
import { Platools } from "@platosdev/platools-sdk";
import { z } from "zod";

const platools = new Platools({
  url: "wss://platos.example.com/tools/sync?entity=my-entity",
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
    // ctx carries the mapped per-call context from Platos.
    await mailer.send(args);
    return { ok: true };
  },
);

await platools.connect();
```

### HMAC nonce signing

Each tool call from Platos to the entity is signed `{ts}.{nonce}.{body}` with the `serviceSecret`. The entity SDK keeps a per-entity LRU of 100k recent nonces and rejects replays. The signature window is short (60 seconds by default). Both SDKs implement this transparently; if you write your own client, mirror the scheme.

### Wire test

The entity detail page has a Wire Test panel that round-trips a no-op call through the gateway. Use it to verify auth, the tool catalogue, and HMAC nonce flow before pointing an agent at the entity.

### Rotate the secret

Click "Regenerate secret" on the entity detail page. The old secret is revoked immediately; the new secret is shown once via Redis GETDEL. Update your entity backend's env var, restart, and the connection re-handshakes.

## Common pitfalls

- The gateway is single-process per replica. Multi-replica installations scale horizontally; an entity connects to one replica, and tool calls fan out via the registry. See the K-track scaling docs.
- `X-Forwarded-For` presence forces session-token mode; entities that present a service secret over HTTP from a public IP are rejected. The WebSocket path is the only place service secrets are accepted.
- Long offline windows do not lose tool catalogue rows. The registry retains them with `status: offline` so cold-start agents do not panic. Calls fail with `ENTITY_OFFLINE` until reconnection.
- The legacy `/agent-orgs` URL path was renamed to `/agent-entities`. The 307 shim is being retired (drift D-001). Update bookmarks and external links.

## Related

- [Tools](/docs/tools): the registry that mirrors entity-pushed tools.
- [Auth modes](/docs/auth-modes): the three auth modes; entity backends always use Mode 3 (service secret on WS upgrade).
- [MCP gateway](/docs/mcp-gateway): how external MCP clients reach the same tool catalogue.
- [Encryption and secrets](/docs/encryption-and-secrets): where the `serviceSecret` is encrypted at rest and the rotation policy.
