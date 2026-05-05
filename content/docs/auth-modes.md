---
slug: auth-modes
title: Auth modes and session tokens
description: Three auth modes (direct headers, session-token JWT, service secret on WS) plus user-token passthrough.
category: dx
order: 20
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "What are the three auth modes Platos supports?"
  - "When does Platos issue a session token?"
  - "How is a session token different from a PAT?"
  - "What is X-Platos-User-Token and when is it used?"
  - "How does an entity backend authenticate on the WebSocket upgrade?"
  - "Why are external requests forced into Mode 2?"
related:
  - scope-and-multi-tenancy
  - mcp-tokens-and-pat
  - public-agents-and-embed
source_files_referenced:
  - apps/agent/src/auth/auth.service.ts
  - apps/agent/src/auth/auth.service.test.ts
  - apps/agent/src/auth/session-token.controller.ts
  - apps/agent/src/auth/public-guest-token.controller.ts
---

# Auth modes and session tokens

Platos accepts three auth modes. Each one resolves a scope tuple, attaches a user identity if relevant, and gates the request through the scope guard. Mode is picked by the request shape, not by a header; external callers cannot bypass the rules.

## What it is

Three modes, ordered from "trusted" to "external":

- **Mode 1 (direct headers)**: `X-Platos-Organization-Id`, `X-Platos-Project-Id`, `X-Platos-Environment-Id` on every request. Used inside the trusted boundary (webapp -> agent service). Refused if the request carries `X-Forwarded-For`; that header signals an external proxy and forces Mode 2.
- **Mode 2 (session token JWT)**: a JWT signed by the entity's `serviceSecret`, carrying scope and an optional opaque `user_token` claim. External callers (entity backends acting on a user's behalf) use this. Verified by `AuthService.verifySessionToken`.
- **Mode 3 (service secret on WS upgrade)**: an entity backend's long-lived WebSocket presents the service secret. Scope is the entity row; user identity is per-call (carried in the session token forwarded over the socket).

Plus one bridge: `X-Platos-User-Token`. When Mode 2 carries a `user_token` claim, Platos forwards it to entity tools as `X-Platos-User-Token`. The entity verifies the token with its own auth stack. Platos never inspects the token; it is opaque.

The webapp also issues platform-issued session tokens (PPR-7 iter2). When a logged-in dashboard user kicks off an agent action, the webapp mints a JWT signed with `PLATOS_SESSION_SECRET` and the agent verifies it. This is the same Mode 2 path, just with a different signing key (the platform key vs. the entity key).

## Why it matters

A single header-based mode collapses three different trust boundaries into one. The split lets you run Platos with mixed callers (internal, external, entity-side) without weakening the model:

- Internal calls are header-based because they share a deployment trust boundary; they are not subject to forgery.
- External calls are JWT-based because the JWT signature proves the entity authorised the call.
- Entity calls are service-secret based because the WebSocket is long-lived and the secret is a one-time bootstrap.

User-token passthrough is the trick that lets Platos host a multi-user agent without ever holding the user's auth credentials. The agent runs, the entity sees a token its own auth stack recognises; Platos is the dispatcher, not the authoriser.

## How to use it

### Mode 1: internal call

```bash
curl https://platos.example.com/agent/v1/agents \
  -H "X-Platos-Organization-Id: $ORG" \
  -H "X-Platos-Project-Id: $PROJECT" \
  -H "X-Platos-Environment-Id: $ENV" \
  -H "Authorization: Bearer $INTERNAL_TOKEN"
```

This works only on the internal network. Adding `X-Forwarded-For` flips the request to Mode 2 and the agent service rejects it for missing a JWT.

### Mode 2: external call from an entity

```ts
import { sign } from "jsonwebtoken";

const sessionToken = sign(
  {
    org: scope.organizationId,
    project: scope.projectId,
    env: scope.environmentId,
    user_token: opaqueUserAuth,
    // Optional. When supplied, ScopeGuard lifts these into
    // scope.sessionContext.user.{name,email} so they're available to
    // prompt placeholders ({{user.name}}, {{user.email}}) and dynamic
    // blocks, and they land in the trace's user_display_name /
    // user_email columns. Plaintext PII — only sign in what the
    // entity already knows about its visitor.
    userMeta: { name: visitor.name, email: visitor.email },
  },
  serviceSecret,
  { expiresIn: "5m" },
);

await fetch("https://platos.example.com/agent/v1/threads/...", {
  headers: { Authorization: `Bearer ${sessionToken}` },
});
```

### Mode 3: entity backend WebSocket

Use `@platools/sdk`. The SDK reads `PLATOS_SERVICE_SECRET` from env and wires the upgrade. See [Connected entities](/docs/connected-entities).

### Mint a session token from the webapp

The webapp helper `mintPlatosSessionToken({ scope, userToken? })` signs with `PLATOS_SESSION_SECRET`. Used by Remix loaders to bridge from a dashboard session to an agent service request.

### Visitor identity (`userMeta`)

The optional `userMeta: { name?, email? }` claim is the canonical place to attach a visitor's display name and email. ScopeGuard lifts the claim into `scope.sessionContext.user.{name, email}`, which means:

- `{{user.name}}` and `{{user.email}}` placeholders resolve in system prompts and dynamic blocks (cache-friendly when used in dynamic blocks; cache-busting when substituted into the system prompt directly).
- ClickHouse spans carry the same values in dedicated `user_display_name` and `user_email` columns alongside the always-present hashed `user_id` (`lead-<sha256-of-email>`). The hashed id stays the canonical identity; `userMeta` is plaintext PII that lives in separate columns so a deletion request can null them without touching the indexed id.
- The agent's memory system can recall the visitor by name without you having to wire it in by hand.

Sign nothing into `userMeta` your entity didn't already collect lawfully. See [Encryption and secrets](/docs/encryption-and-secrets) and [Legal and policies](/docs/legal-and-policies) for how this lands at rest.

## Common pitfalls

- The `X-Forwarded-For` -> Mode 2 forcing is silent. A test request from outside the trust boundary fails with "missing JWT" even though headers were present; do not chase a Mode 1 bug from an external caller.
- Session tokens are short-lived (5 minutes default). Long-running streams should refresh proactively; the streaming endpoint accepts a token-refresh ping.
- `X-Platos-User-Token` is opaque to Platos. If the entity's verification fails, the entity tool returns its own error; Platos just forwards.
- Mode 3's service secret is presented on the WebSocket upgrade. Once upgraded, the socket is trusted for its lifetime. Rotate the secret to invalidate; the socket re-handshakes on the next reconnect.

## Related

- [Scope tuple and multi-tenancy](/docs/scope-and-multi-tenancy): the tuple every mode resolves.
- [MCP tokens and PATs](/docs/mcp-tokens-and-pat): the long-lived bearer tokens for MCP and admin access.
- [Public agents and embed](/docs/public-agents-and-embed): the public-guest-token controller, used for unauthenticated traffic.
