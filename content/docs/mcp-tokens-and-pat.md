---
slug: mcp-tokens-and-pat
title: MCP tokens and PATs
description: Personal Access Tokens (plt_ent_*) and OAuth 2.1 DCR flows for MCP clients.
category: dx
order: 50
questions:
  - "How do I create a Platos PAT?"
  - "What can a PAT do that a session token can't?"
  - "How does OAuth 2.1 dynamic client registration work?"
  - "How do I revoke a token?"
  - "What is the bearer-token format the MCP service expects?"
  - "Can I scope a PAT to a single agent?"
related:
  - mcp-gateway
  - auth-modes
---

# MCP tokens and PATs

Two long-lived bearer formats: PAT (`plt_ent_*`) for human and machine users, OAuth 2.1 DCR-issued tokens for MCP clients that prefer a delegated handshake. Both reach the same auth path inside Platos and resolve to the same scope tuple plus user.

## What it is

- **PAT** (Personal Access Token): a string starting `plt_ent_`, issued from an environment-scoped entity dashboard. Each PAT carries `(entityId, environmentId, mcpUserId, scopes[])`; the environment cannot change after mint.
- **OAuth 2.1 DCR token**: issued through dynamic client registration. The MCP client registers (no upfront credentials), gets a client id and secret, runs the auth code flow, and ends up with a bearer token tied to a user and scope. Equivalent power to a PAT, different lifecycle.

`TokenService` mints, lists, revokes; `MCPBearerTokenService` is the verifier on the MCP path. The verifier accepts both formats and normalises them into the same `AuthenticatedRequest` shape.

The settings page at `/settings/mcp-tokens` lists every PAT for the current user with last-used timestamp, scope, and a revoke action.

## Why it matters

Session tokens are short-lived by design (5 minutes). MCP clients run for days. PATs and OAuth tokens are how a long-running MCP client stays connected without fresh-minting every few minutes.

The two formats split by ergonomics:

- PAT: paste a string. Fastest path; right for personal use, scripts, CI.
- OAuth DCR: ergonomic for production MCP clients (Claude Desktop, IDE plugins) that already speak the OAuth handshake. No paste-the-string UX.

Both paths land at the same enforcement point and revalidate entity/project/environment ancestry on every HTTP or SSE message.

## How to use it

### Create a PAT

`/settings/integrations/mcp` -> "Mint a new token". Name, TTL, and a **visual permission picker**: toggle tool categories (with live tool counts) or pick a preset — read-only, operator, full, or admin (cross-scope) — and an executionning "this token sees N tools" preview shows the effective grant. The dashboard shows the token string once; lost tokens cannot be retrieved. Paste the generated config into your MCP client — it uses streamable HTTP (`type: "http"`), the transport modern clients speak.

### Use a PAT

```bash
curl https://platos.example.com/mcp \
  -H "Authorization: Bearer plt_ent_abc123..." \
  -X POST -d '{"method":"tools/list"}'
```

Same header for the consumer SDK and any MCP client.

### Scope a PAT to a single agent

Set `scopes: ["agent:agent_id_xyz:read"]`. The PAT can list and read that agent only. Useful for read-only dashboards.

### OAuth 2.1 DCR

Dynamic registration can request only the authorization server's advertised MCP scopes (`mcp:tools` for entity endpoints and `mcp:read mcp:write` for the platform endpoint). Caller-defined ACL or privileged labels are rejected. Authorization stores the exact effective scopes in a signed, opaque, one-time consent transaction; the consent page carries only that transaction and displays those server-effective scopes.

The MCP client hits `/.well-known/oauth-authorization-server` and discovers the registration endpoint. POST `/oauth/register` with the standard DCR body returns a `client_id` and `client_secret`. Then standard auth-code flow.

```http
GET /oauth/authorize?client_id=...&response_type=code&redirect_uri=...
POST /oauth/token  body: grant_type=authorization_code&code=...
```

The resulting bearer is what the client uses on `/mcp`.

### Revoke

`DELETE /api/v1/agent/access-key` revokes the active Environment access key immediately. The next MCP call returns 401.

## Common pitfalls

- PAT bearer tokens MUST start with `plt_ent_`. The recent fix (commit `adfe32e6b`) accepts both PAT and OAuth bearer; older installations may only accept the OAuth shape.
- PATs never default to production or the oldest environment. Mint from the intended environment page; switching dashboard environments creates a separately scoped token.
- A PAT's `scopes[]` is checked on every call. A token without `agents:write` cannot create an agent even if it has `agents:read`. Audit on `/settings/mcp-tokens` if a permission is failing unexpectedly.
- OAuth DCR registration is unauthenticated by default; rate limits apply (see [Rate limits](/docs/rate-limits)). Registration cannot add arbitrary scopes, and consent transactions expire and reject tamper or replay.
- Tokens are scoped at issue time; rotating a project's permissions does not retroactively update existing tokens. Reissue when permissions tighten. Revocation is checked again for every SSE `/messages` request.

## Related

- [MCP gateway](/docs/mcp-gateway): the surface these tokens authenticate against.
- [Auth modes](/docs/auth-modes): the three modes; bearer tokens fold into Mode 2.
