---
slug: connected-entities
title: Connected entities
description: External backends that connect to Platos over WebSocket and expose their tools to agents without exposing their data.
category: platform
order: 70
trigger_dev_primitive: false
trigger_dev_link: ""
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
source_files_referenced:
  - apps/agent/src/tool-gateway/tool-sync-ws.service.ts
  - apps/agent/src/connections/connections.gateway.ts
  - apps/agent/src/agent-runtime/agent.controller.ts
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities._index/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.$entityId/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.$entityId.wire-test/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.new/route.tsx
---

# Connected entities

A connected entity is an external backend (your service, a SaaS adapter, a microservice) that holds a long-lived WebSocket to Platos and exposes its tools to agents. The entity owns its data and its auth. Platos sees only tool names, schemas, and call results, never the underlying business data.

## What it is

A `PlatosConnectedEntity` row plus a live WebSocket. The row stores:

- `slug` and `name`: identifier for the entity within the project scope.
- `serviceSecret`: encrypted, used to authenticate the entity when it connects. This is the only secret Platos stores in its own database; everything else lives in trigger.dev's environment-variables table.
- `entityType`: a discriminator (e.g. `slack`, `calendar`, `custom`).
- `status`: `online` or `offline`, updated by the gateway on connect/disconnect.

The entity opens a Socket.IO connection at `/connections` with its `serviceSecret` on the upgrade. `tool-sync-ws.service.ts` owns the lifecycle: the early-message buffer is attached before the async auth completes, and once the secret verifies, the buffered frames are replayed in order. This is the load-bearing race-fix at lines 130-135 and 281-284 of that file. Do not violate it.

After auth, the entity pushes its tool catalogue. The registry mirrors the catalogue per scope, the agent matrix picks it up, and tool calls dispatch back to the entity over the same socket.

## Why it matters

The model where Platos owns the data and the entity is "just a webhook" loses every time a customer asks about compliance, GDPR, or data residency. The entity-owned model means:

- Business data never crosses Platos's storage boundary. The entity reads from its own database, returns the result, and Platos forwards it to the agent.
- Auth is the entity's. Platos rides on a session token that may carry an opaque user-token claim; the entity verifies that claim with its own auth stack.
- Reconnection is the entity's responsibility. The Platos client SDKs (`@platools/ts`, `@platools/py`) handle backoff and replay locally.

That ownership split is what makes Platos self-hostable as a runtime without becoming a customer's data plane.

## How to use it

### Register an entity

From the dashboard, navigate to `/orgs/{org}/projects/{project}/env/{env}/agent-entities/new`. Provide a slug and name; the dashboard mints a fresh `serviceSecret`, shows it once on the initial-secret page (loaded via Redis GETDEL so it cannot be replayed), and writes the row.

```bash
curl -X POST https://platos.example.com/agent/v1/entities \
  -H "Authorization: Bearer $PAT" \
  -H "X-Platos-Organization-Id: $ORG" \
  -H "X-Platos-Project-Id: $PROJECT" \
  -H "X-Platos-Environment-Id: $ENV" \
  -d '{"slug":"my-entity","name":"My entity","entityType":"custom"}'
```

### Connect from your backend

Use `@platools/ts` (Node) or `@platools/py` (Python):

```ts
import { connect } from "@platools/sdk";

const conn = connect({
  url: "wss://platos.example.com/connections",
  serviceSecret: process.env.PLATOS_SERVICE_SECRET,
});

conn.tool("send_email", { to: { type: "string" }, body: { type: "string" } }, async (args, ctx) => {
  // ctx carries forwarded user-token from Platos.
  await mailer.send(args);
  return { ok: true };
});
```

### HMAC nonce signing

Each tool call from Platos to the entity is signed `{ts}.{nonce}.{body}` with the `serviceSecret`. The entity SDK keeps a per-entity LRU of 100k recent nonces and rejects replays. The signature window is short (60 seconds by default). Both SDKs implement this transparently; if you write your own client, mirror the scheme.

### Wire test

The entity detail page has a Wire Test panel that round-trips a no-op call through the gateway. Use it to verify auth, the tool catalogue, and HMAC nonce flow before pointing an agent at the entity.

### Rotate the secret

Click "Regenerate secret" on the entity detail page. The old secret is revoked immediately; the new secret is shown once via Redis GETDEL. Update your entity backend's env var, restart, and the connection re-handshakes.

## Common pitfalls

- The gateway is single-process per replica. Multi-replica deployments scale horizontally; an entity connects to one replica, and tool calls fan out via the registry. See the K-track scaling docs.
- `X-Forwarded-For` presence forces session-token mode; entities that present a service secret over HTTP from a public IP are rejected. The WebSocket path is the only place service secrets are accepted.
- Long offline windows do not lose tool catalogue rows. The registry retains them with `status: offline` so cold-start agents do not panic. Calls fail with `ENTITY_OFFLINE` until reconnection.
- The legacy `/agent-orgs` URL path was renamed to `/agent-entities`. The 307 shim is being retired (drift D-001). Update bookmarks and external links.

## Related

- [Tools](/docs/tools): the registry that mirrors entity-pushed tools.
- [Auth modes](/docs/auth-modes): the three auth modes; entity backends always use Mode 3 (service secret on WS upgrade).
- [MCP gateway](/docs/mcp-gateway): how external MCP clients reach the same tool catalogue.
- [Encryption and secrets](/docs/encryption-and-secrets): where the `serviceSecret` is encrypted at rest and the rotation policy.
