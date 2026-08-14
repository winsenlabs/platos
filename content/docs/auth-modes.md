---
slug: auth-modes
title: Authentication modes and credentials
description: The shipped Platos request-authentication modes, credential families, and trust boundaries.
category: dx
order: 20
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "Which authentication mode should a Platos client use?"
  - "How are dashboard session tokens verified?"
  - "Which credential authorizes hard erasure?"
  - "How is an entity bearer different from a control-plane token?"
  - "What is X-Platos-User-Token?"
related:
  - credential-inventory
  - scope-and-multi-tenancy
  - mcp-tokens-and-pat
  - public-agents-and-embed
source_files_referenced:
  - apps/agent/src/auth/scope.guard.ts
  - apps/agent/src/auth/auth.service.ts
  - apps/agent/src/mcp-platform/token.service.ts
  - apps/agent/src/mcp-platform/mcp-bearer-token.service.ts
  - apps/webapp/app/services/patService.server.ts
  - apps/webapp/app/services/controlPlaneCredential.server.ts
---

# Authentication modes and credentials

Platos ships several authentication modes because dashboard users, entity backends, MCP clients, API clients, and internal callbacks cross different trust boundaries. They intentionally do not share one universal bearer.

## Request authentication modes

### 1. Trusted internal scope headers

A webapp-to-agent request on the private deployment network can provide the complete scope tuple:

- `X-Platos-Organization-Id`
- `X-Platos-Project-Id`
- `X-Platos-Environment-Id`
- `X-Platos-User-Id`

This mode is a network-bound service path, not a public authentication mechanism. `ScopeGuard` refuses it when `X-Forwarded-For` is present, because that indicates the request crossed the public proxy. Do not publish the agent port directly; the compose configuration binds it to loopback.

### 2. Short-lived session JWT

External agent requests use a signed, expiring JWT that contains the organization, project, environment, and optional user context.

There are two issuers:

- An entity backend signs with that entity's `serviceSecret`. The default entity-session lifetime is five minutes.
- The Platos webapp signs dashboard bridge tokens with the deployment's single `SESSION_SECRET`. Operator sessions last at most seven days.

The agent verifies the issuer and signature and then resolves the scope carried by the token. `PLATOS_SESSION_SECRET` is retired; webapp and agent must receive the same `SESSION_SECRET` value.

The optional `user_token` claim is opaque to Platos. When present, Platos forwards it to the entity as `X-Platos-User-Token`; the entity validates it with its own identity system.

### 3. Connected-entity WebSocket bootstrap

A connected entity presents its own `serviceSecret` during the WebSocket upgrade. The secret is bound to the entity row and establishes the long-lived socket. Per-user calls still carry short-lived session context. Rotate the entity secret to invalidate future handshakes and reconnect active clients.

### 4. Long-lived bearer credentials

Long-lived credentials have non-overlapping prefixes and scopes:

| Credential        | Prefix     | Scope                                                  | Default expiry | Use                                   |
| ----------------- | ---------- | ------------------------------------------------------ | -------------- | ------------------------------------- |
| Control-plane MCP | `plt_mcp_` | Organization; `scope` or `admin` tier                  | 90 days        | Operator/control-plane MCP operations |
| Entity MCP bearer | `plt_ent_` | One connected entity and its scope tuple               | 90 days        | Inbound entity MCP gateway            |
| User API token    | `plt_pat_` | One user; access is still resolved through memberships | 90 days        | Platos API and CLI                    |

`pmt_` and Trigger's inherited `tr_pat_` are retired and are not compatibility aliases. Rejected prefixes are not looked up in the database.

Successful mint, use, and first revocation of these three families write redacted `PlatosCredentialAudit` evidence. Audit persistence is part of successful authentication: if a valid credential cannot record its use, verification fails closed. Raw tokens and token hashes are never copied into audit rows.

See [Credential inventory](/docs/credential-inventory) for revocation and rotation details.

## Privileged and internal operations

### Irreversible hard erasure

Hard erasure requires:

```http
Authorization: Bearer plt_mcp_...
```

The credential must have `admin` tier and its `organizationId` must equal the organization being erased. A `scope`-tier token, a token from another organization, `PLATOS_INTERNAL_AUTH_TOKEN`, and the retired `PLATOS_ADMIN_TOKEN` are all rejected.

### Dedicated internal callbacks

Scheduled and durable-execution callbacks authenticate with:

```http
X-Platos-Internal-Auth: <PLATOS_INTERNAL_AUTH_TOKEN>
```

This deployment secret is restricted to dedicated service callbacks such as compaction, durable turns, retention, reconciliation, and sweeps. Comparisons are length-checked and use `crypto.timingSafeEqual`. It must never be accepted as operator authorization for hard erasure.

`TRIGGER_INTERNAL_SECRET`, `PLATOS_DOCS_MCP_BRIDGE_SECRET`, and `MANAGED_WORKER_SECRET` remain separate because they protect different service boundaries. `MANAGED_WORKER_SECRET` and mode-C worker behavior are unchanged here and are owned by WIN-132.

## Examples

### Entity-signed request

```ts
import { sign } from "jsonwebtoken";

const token = sign(
  {
    org: organizationId,
    project: projectId,
    env: environmentId,
    user_token: opaqueEntityUserToken,
    userMeta: { name: visitor.name, email: visitor.email },
  },
  entityServiceSecret,
  { expiresIn: "5m" }
);

await fetch("https://platos.example.com/agent/v1/threads/thread_123", {
  headers: { Authorization: `Bearer ${token}` },
});
```

Only include user metadata the entity collected lawfully. `userMeta` is plaintext PII in the signed claims and observability fields.

### User API request

```bash
curl https://platos.example.com/api/v1/orgs \
  -H "Authorization: Bearer $PLATOS_PAT"
```

Generate a `plt_pat_` token from **Account → API Tokens**. The CLI accepts `--access-token "$PLATOS_PAT"` or its stored credential.

## Common mistakes

- Do not use `PLATOS_INTERNAL_AUTH_TOKEN` as a general admin bearer.
- Do not expose trusted direct-header mode through a public proxy.
- Do not use `plt_ent_` for control-plane tools or `plt_mcp_` as an entity identity.
- Do not retry a failed audited verification as if it had succeeded; audit-write failure intentionally denies access.
- Do not configure `PLATOS_SESSION_SECRET`; use one shared `SESSION_SECRET` on webapp, agent, and workers that mint or verify platform session JWTs.
