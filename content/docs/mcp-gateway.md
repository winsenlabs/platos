---
slug: mcp-gateway
title: MCP gateway
description: Universal MCP endpoint that federates entity tools, start meta-tools, Platos skills, and the control plane.
category: dx
order: 40
questions:
  - "What is the Platos MCP gateway?"
  - "Which four tool families does it federate?"
  - "How do per-entity MCP endpoints work?"
  - "What identity modes does the gateway support (anonymous, OIDC, bearer-PAT)?"
  - "How is per-tool ACL enforced?"
  - "How do I brand my entity's MCP endpoint?"
  - "How does the permission gateway resolve a user's effective tool list?"
related:
  - mcp-tokens-and-pat
  - tools
  - connected-entities
  - auth-modes
---

# MCP gateway

The MCP gateway is the universal Model Context Protocol surface in front of Platos. One endpoint federates four tool families: entity-pushed tools, Platos meta-tools, Platos skills, and the Platos control plane. Any MCP client (Claude Desktop, OpenAI's agents, your own) gets one tool catalogue keyed off the caller's identity, scope, and ACLs.

## What it is

A single MCP endpoint at `/mcp` plus per-entity endpoints at `/mcp/entity/{slug}`. The gateway:

- **Federates**: enumerates tools from all four families on each `tools/list` MCP call. The same federation that the agent runtime uses internally is exposed externally with consistent semantics.
- **Authenticates**: three identity modes (PIFSP-22): anonymous (limited public tools), OIDC federation (delegated user identity), bearer PAT (long-lived programmatic access).
- **Authorises**: `PermissionGatewayService` resolves the caller's effective tool list. Cross-scope cuts, per-tool ACLs, per-entity opt-ins all enforced here.
- **Brands**: per-entity endpoints carry the entity's name, description, and logo (PIFSP-24); a customer pointing Claude Desktop at `/mcp/entities/acme` sees "Acme Tools" in the connector picker.

`MCPRouter` is the request dispatcher. `MCPPlatformController` exposes the project-level endpoint; `MCPEntityController` exposes the per-entity endpoint. `MCPToolACLService` enforces the per-tool opt-in (PIFSP-25).

The four tool families:

1. **Entity tools** mirrored from connected entities. The gateway reuses the registry; no double-registration.
2. **start meta-tools** (`spawn_job`, `list_bgos`, `schedule_bgo`, `agent_batch`).
3. **Platos skills** (`platos-rag`, `platos-code-runner`, etc.).
4. **Control plane** (`agents.create`, `threads.list`, etc.). The Platos-as-a-product surface, useful for ops automation.

## Why it matters

Without the gateway, an MCP client wanting to use a Platos-backed tool has to know which entity owns it, hold the entity's auth, and connect to four different surfaces. The gateway collapses that into one URL and one auth flow. The 4-tier permission model lets you expose the same tools to different audiences with different cuts: a public-facing MCP exposes the safe subset, an admin-facing MCP exposes everything.

The per-entity endpoints + branding are how an entity's tools can be consumed as if they were the entity's own MCP server. From a user's perspective, "Acme MCP" is in their MCP catalogue; the fact that it federates through Platos is an implementation detail.

## How to use it

### Connect an MCP client

Point your MCP client at:

```
https://platos.example.com/mcp
```

Authenticate with a PAT (`Authorization: Bearer plt_ent_...`). The client lists tools; you call them.

### Per-entity endpoint

```
https://platos.example.com/mcp/entity/acme
```

Tools list scopes to the entity's pushed tools plus any Platos skills the entity has opted in.

### Identity modes

- **Anonymous**: no auth header. Only tools admitted by the anonymous ACL are exposed. The canonical `environmentId` query parameter is always required; the gateway resolves the entity slug inside that environment and never performs a global slug preselection.
- **OIDC**: OAuth authorization pins one canonical environment and carries it through the auth code, access token, refresh token, and delegated OIDC session.
- **Bearer PAT**: `Authorization: Bearer plt_ent_...`. The PAT is minted for the dashboard's current environment and always reuses that exact environment.

### Per-tool ACL

In the entity's MCP config tab, toggle individual tools on/off for the gateway. Defaults are conservative (off for new tools); enable explicitly when you want them public.

### Brand the endpoint

Per-entity endpoints expose `serverInfo` (name, description, logo, support URL) on the MCP handshake. Configure on the entity's detail page.

### Effective tools view

`GET /api/v1/agent/entities/{entityId}/mcp/config` returns the Environment-scoped MCP connection configuration. Use the Tool matrix and audit views to verify what a particular identity could invoke.

## Common pitfalls

- The gateway is the cross-scope cut. A bug in `permission-gateway.service.ts` can leak tools across orgs. Audit the test bar; the cross-scope IDOR probes cover this path.
- Anonymous mode is opt-in per tool. A naively published tool with `public: true` is callable by any unauthenticated client. Treat `public: true` as a deliberate decision, not a default.
- Never depend on project creation order to select an environment. Supply `?environmentId=<canonical-id>` for anonymous and entity OAuth discovery/authorization. Bearer routes validate the token first, load its authoritative entity and environment, then compare the requested slug.
- External tool arguments cannot set Platos transport authority. The gateway recursively removes reserved `_context`, `__platos`, `_platos`, `platos_context`, `platosContext`, and `__platosContext` envelopes before MCP or wire dispatch, then adds server-derived context only when the entity enables it.
- OIDC federation requires `OIDC_ISSUER`, `OIDC_AUDIENCE`, and `OIDC_JWKS_URL` env vars. Misconfigured OIDC silently rejects valid tokens.
- The Settings -> Integrations route exists in two scopes (project and org) with similar names (drift D-006). The org-scoped page is for OAuth-style integrations like Slack; the project-scoped page is for MCP and webhook config. Cross-link from this doc to disambiguate.

## Related

- [MCP tokens and PATs](/docs/mcp-tokens-and-pat): the bearer tokens this gateway accepts.
- [Tools](/docs/tools): the registry the gateway federates.
- [Connected entities](/docs/connected-entities): the per-entity tool source.
- [Auth modes](/docs/auth-modes): the same three modes apply, with PAT as the long-lived bearer.
