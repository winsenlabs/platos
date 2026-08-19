---
title: "MCP Gateway"
description: "Connect Claude Desktop, Cursor, Continue.dev, or any MCP client to Platos. Give customer agents access to Linear, Slack, GitHub, and any MCP server."
sidebarTitle: "MCP"
---

# Platos MCP Gateway

Platos exposes two MCP surfaces:

1. **Platform MCP** — "everything a human can do." An MCP endpoint at
   `/mcp/platform` that lets Claude Desktop (or any MCP client) drive
   Platos + the trigger.dev engine: list agents, create agents, trigger
   runs, edit memories, resolve approvals, read traces, check budgets.
2. **Agent MCP** — a per-scope registry of third-party MCP servers
   (Linear, Slack, GitHub, filesystem, anything). Customer agents
   federate those tools into their turn without the agent author
   wiring any HTTP themselves.

Both pass through a 4-tier **permission gateway** that lets you
lock down destructive operations to `require_approval` or `block`.

## Platform MCP — Claude Desktop setup

<Steps>
<Step title="Mint a token in the dashboard">
Open **Settings → MCP tokens** in the current scope. Click **Mint token**.
- **Name** — any label ("Alice's Desktop").
- **Permissions** — comma-separated patterns. Use `*` for full access, or tighten: `agents.*, threads.*, monitoring.*, trigger.runs.list, trigger.runs.get`.
- **TTL** — default 90 days. `0` mints a non-expiring token (admin-only, avoid unless necessary).

After minting, Platos shows the raw token **once** plus a pre-built Claude Desktop config snippet. Copy it now — the raw value is never shown again.
</Step>

<Step title="Paste into Claude Desktop config">
Open Claude Desktop → Settings → Developer → Edit Config, then paste the snippet:

```json
{
  "mcpServers": {
    "platos": {
      "url": "https://platos.example.com/mcp/platform",
      "transport": "sse",
      "headers": {
        "Authorization": "Bearer plt_mcp_abc123..."
      }
    }
  }
}
```

Restart Claude Desktop. The Platos server should appear in the tool list.
</Step>

<Step title="Verify">
Ask Claude: "Use the `platos.whoami` tool." You should see a response confirming the scope your token is pinned to.

Then try the real-world query: "List the agents in my Platos project." Claude will call `agents.list` and render the results.
</Step>
</Steps>

<Note>
Tokens are **pinned to one `(org, project, env)` tuple**. They cannot switch scope. To use Claude Desktop against a different environment, mint a second token.
</Note>

### Local stdio transport (Claude Code / Cursor)

Build the agent, then point the client at the stdio entrypoint. The token is
accepted only through `PLATOS_MCP_STDIO_TOKEN`; do not put it in `args`, where it
would be visible in the process list.

```json
{
  "mcpServers": {
    "platos": {
      "command": "node",
      "args": ["/absolute/path/to/platos/apps/agent/dist/mcp-platform/stdio-main.js"],
      "env": {
        "PLATOS_MCP_STDIO_TOKEN": "plt_mcp_replace_with_once-revealed_token"
      }
    }
  }
}
```

Claude Code and Cursor both accept this command-style MCP configuration. Keep
the client config owner-readable only. Stdio verifies the bearer through the
same database-backed token/OAuth verifier as HTTP+SSE, preserves the complete
`(organizationId, projectId, environmentId, userId)` authority, and dispatches
through the exact same `McpRouter` and 206-tool catalog. Application logs are
routed to stderr; stdout is reserved for JSON-RPC frames.

For an interactive approval, retry the stdio `tools/call` with
`params._meta.platosApprovalId` set to the returned
`error.data.retryMeta.platosApprovalId`. HTTP clients may use the equivalent
`X-Platos-Approval-Id` header. The transport strips `_meta` before tool-schema
validation and execution.

## Scope + auth model

Every request to `/mcp/platform` includes `Authorization: Bearer <token>`.
The agent:
1. sha256-hashes the token and looks up the `PlatosMCPToken` row,
2. checks `expiresAt` + `revokedAt`,
3. extracts the pinned `(organizationId, projectId, environmentId)` tuple,
4. checks the token's permission allowlist against the requested tool name,
5. resolves the 4-tier permission gateway,
6. dispatches to the existing service handler.

If any step fails, returns a structured JSON-RPC error — no silent fallbacks.

## Permission gateway

Every MCP tool call passes through a **4-tier resolver**:

| Tier | Lives on | Who sets | Purpose |
|---|---|---|---|
| 1 | platform env | maintainer | Hardcoded minimums (e.g. `gdpr.*` always require_approval) |
| 2 | `PlatosOrgMcpPolicy` row | org admin | Scope-wide defaults |
| 3 | `PlatosAgent.mcpPermissions` JSON | agent author | Per-agent overrides |
| 4 | Browser session | end user | "Don't let this agent send email" |

**Effective policy = MOST_RESTRICTIVE(tier1, tier2, tier3, tier4).**
Each tier can only **tighten**, never loosen. So tier 1's `gdpr.* =
require_approval` will upgrade tier 2's `auto_allow` — always.

Three states per tool:

- `auto_allow` — call proceeds silently.
- `require_approval` — agent opens a `PlatosAgentApproval` waitpoint, stream pauses, the operator approves/rejects in the dashboard.
- `block` — immediate `{type:"error", code:"tool_blocked", tier:N}`. No approval, no LLM retry.

### Hardcoded tier-1 minimums (never downgradable)

- `gdpr.*` — every GDPR action requires approval.
- `filesystem.delete_file`, `filesystem.write_file` — require approval.
- `trigger.envvars.upsert`, `trigger.envvars.delete` — require approval.
- `entities.register`, `entities.regenerate_secret` — require approval.
- `agents.delete`, `agents.rollback`, `agents.canary.promote`, `agents.visibility.set` — require approval.
- `memories.import_replace`, `messages.edit_and_rerun` — require approval.

## Platform MCP tool inventory (M0.1)

The M0.1 baseline is the existing 206 unique dotted tool names across 35
namespaces. Names remain stable; future compatibility names must be declared as
explicit aliases rather than silently renaming a tool. The canonical generated
manifest, complete JSON Schemas, REST mappings/classifications, and deterministic
parity report live at:

- `apps/agent/src/control-plane/operation-manifest.generated.json`
- `docs/control-plane-parity.generated.md`

Run `pnpm --filter platos-agent check:control-plane` in CI to reject source,
manifest, report, or generated OpenAPI drift.

## Agent MCP — connect third-party MCP servers to your agents

<Steps>
<Step title="Register the server (org-scope)">
POST to `/api/v1/agent/mcp/servers` with scope headers:

```bash
curl -X POST https://platos.example.com/api/v1/agent/mcp/servers \
  -H "X-Platos-Organization-Id: $ORG" \
  -H "X-Platos-Project-Id: $PROJECT" \
  -H "X-Platos-Environment-Id: $ENV" \
  -H "X-Platos-User-Id: $USER" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "linear",
    "displayName": "Linear",
    "transport": "remote-http",
    "url": "https://mcp.linear.app",
    "credsSecretKey": "MCP_LINEAR_TOKEN"
  }'
```

Create `MCP_LINEAR_TOKEN` in the dashboard for this Environment first. The
server row stores only that bare same-Environment credential name; it never
stores plaintext. Runtime resolution does not fall back to `process.env`.

Platos automatically calls `tools/list` to discover what tools the server exposes.
</Step>

<Step title="Bind a server to an agent">
Connecting a server at the org-scope doesn't grant any agent access to it. Each agent that should use it needs a binding:

```bash
curl -X PUT https://platos.example.com/api/v1/agent/mcp/agents/$AGENT_ID/bindings/$SERVER_ID \
  -H "X-Platos-*: ..." \
  -d '{ "allToolsEnabled": true }'
```

Or enable specific tools only:

```json
{ "allToolsEnabled": false, "enabledTools": ["linear.create_issue", "linear.list_issues"] }
```
</Step>

<Step title="Verify the tool matrix">
```bash
curl https://platos.example.com/api/v1/agent/mcp/agents/$AGENT_ID/tool-matrix \
  -H "X-Platos-*: ..."
```

Returns every enabled tool with its qualified name (`linear.create_issue`) + JSON Schema. This is what the LLM sees in the tool list during a turn.
</Step>
</Steps>

### Per-agent installs

You can also install a server **only for a specific agent** by passing `agentId` when registering:

```json
{
  "slug": "my-private-github",
  "agentId": "agt_abc123",
  "transport": "remote-http",
  "url": "...",
  ...
}
```

Per-agent installs skip the binding step — all their tools are enabled for that agent automatically.

## Supported transports

| Transport | MVP status | Notes |
|---|---|---|
| `remote-http` | ✅ ships | Any MCP server reachable over HTTPS |
| `remote-sse` | ✅ ships | MCP-over-SSE flavour |
| `stdio` | Stub (K.10 follow-up) | Dev-only; subprocess spawn |
| `hosted-linear` / `hosted-slack` / `hosted-github` / `hosted-gitlab` / `hosted-notion` | Scaffold (K.11) | Platos-shipped handlers |

## Troubleshooting

**"invalid or expired MCP token"** — the token was revoked, expired, or never existed. Mint a new one.

**"tool 'X' blocked by tier-N policy"** — permission gateway denied the call. Check the corresponding UI: org-admin policy (`/settings/mcp-policy`), agent editor → MCP permissions tab, or the session override if running from the browser embed.

**Tool disappears from the Claude Desktop list** — restart Claude Desktop. It caches `tools/list`; re-fetching happens at reconnect. Also verify the token's `permissions` array includes the tool name (or a covering pattern like `agents.*`).

**`tools/list` returns empty for a registered server** — check `lastDiscoveryAt` and `discoveryError` on the server row. POST `/servers/:id/resync` to force a rediscovery.

**Claude Desktop shows "SSE connection closed"** — check your reverse proxy. Caddy + NGINX default idle timeouts (30-60s) will kill an SSE stream. The agent already emits a `notifications/ping` every 30s; make sure the proxy passes those through.

## References

- Spec: `docs/themes/THEME_K.md` — full architecture + tool taxonomy.
- MCP protocol: [spec.modelcontextprotocol.io](https://spec.modelcontextprotocol.io/)
- Claude Desktop config location: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) / `%APPDATA%\Claude\claude_desktop_config.json` (Windows)
