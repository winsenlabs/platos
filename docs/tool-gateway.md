# Tool Gateway

Platos treats tools as first-class, multi-tenant, externally-registered services. This doc covers the full model: how to register a tool server, the WebSocket sync protocol, the four-table data model, BM25 discovery, the HMAC-signed invocation protocol, the three execution modes, and per-agent permissions.

## Why an external gateway?

Most agent frameworks ship tools as in-process functions. That's fine for 10 tools in one repo. It fails at scale:

- **Multi-tenancy.** Org A's "Jira" tool needs to POST to their instance, not yours.
- **Language diversity.** Tool authors want Python, Go, Rust — not JS-only.
- **Deployment independence.** Tool servers ship on their own cadence without redeploying Platos.
- **Health isolation.** A flaky Salesforce tool shouldn't take the agent down.

The gateway solves this: **Platos knows the tool definition (shared) and per-(entity, environment) mapping (where to call). Tool servers push their registrations over WebSocket and receive signed invocations back over HTTP.**

## Data model

Four Prisma models, sourced from `internal-packages/database/prisma/schema.prisma`:

```prisma
/// An external backend that registers tools with Platos via the platools WS
/// protocol. Lives at PROJECT level; one project can register many entities.
/// The serviceSecret is the HMAC signing key + WS upgrade auth credential.
model PlatosConnectedEntity {
  id                  String   @id @default(cuid())
  organizationId      String
  projectId           String
  entityId            String   // human-readable slug e.g. "fandesk-main"
  displayName         String
  mcpUrls             String[]
  serviceSecret       String   // AES-256-GCM encrypted at rest
  customParams        Json?    // auto-injected into every tool call for this entity
  connectionStatus    String   @default("disconnected")  // connected | disconnected
  lastConnectedAt     DateTime?
  toolMappings        PlatosEntityToolMapping[]

  @@unique([organizationId, projectId, entityId])
}

/// Central, globally-shared tool registry — one row per unique tool name.
/// BM25 tokens are computed here, once, and reused across every entity that
/// registers the same tool name.
model PlatosToolDefinition {
  id            String   @id @default(cuid())
  name          String   @unique
  description   String   @db.Text
  paramSchema   Json     // full JSON Schema
  category      String?  // "calendar" | "email" | "tasks" | ...
  schemaHash    String   // SHA-256 of paramSchema — detects schema drift
  bm25Tokens    String[]
  entityMappings PlatosEntityToolMapping[]
}

/// The "tool matrix": one row per (tool × entity × environment). Same entity
/// can expose the same tool with a different callbackUrl in dev vs prod —
/// which is why environmentId is on the mapping, not the entity.
model PlatosEntityToolMapping {
  id            String   @id @default(cuid())
  toolId        String   // FK → PlatosToolDefinition
  entityId      String   // FK → PlatosConnectedEntity.id
  environmentId String   // FK → RuntimeEnvironment
  enabled       Boolean  @default(true)
  callbackUrl   String

  @@unique([toolId, entityId, environmentId])
  @@index([entityId, environmentId, enabled])
}

/// Per (tool × entity × environment) health. Updated on every tool call.
model PlatosToolHealth {
  toolId        String
  entityId      String
  environmentId String
  lastCalledAt  DateTime?
  lastStatus    String?  // "success" | "failed" | "timeout"
  failCount     Int      @default(0)   // consecutive failures
  totalCalls    Int      @default(0)
  totalFailures Int      @default(0)
  p95LatencyMs  Int?
  avgLatencyMs  Int?

  @@unique([toolId, entityId, environmentId])
}
```

- **`PlatosToolDefinition` is global.** `fandesk.list_bookings` means the same thing everywhere — same schema, same tokens. The central registry dedupes BM25 work across tenants.
- **`PlatosEntityToolMapping` is per `(entity, environment)`.** The same entity can wire different `callbackUrl`s for `dev` vs `prod`. Two different entities can expose the same tool name with independent URLs. Each mapping can toggle `enabled` without affecting any other.
- **`PlatosToolHealth` is per `(tool, entity, environment)`.** A 503 on one entity's `prod` endpoint isn't a global outage — `dev` of the same entity and every other entity remain healthy. Agents asking `find_tools` filter out rows where `failCount` has crossed the down threshold.
- **The HMAC signing key is NOT stored on the mapping.** It lives on `PlatosConnectedEntity.serviceSecret` (encrypted). One secret per entity, rotatable via the Regenerate flow in the UI — see [entity-connect.md](./entity-connect.md#servicesecret-lifecycle).

The "tool matrix" is three-dimensional: **M tools × N entities × E environments** = an M × N × E truth table of mappings + health. Within a single `(project, environment)` scope, the flattened view an agent sees is M × N — "what tools are wired up, by whom, to where."

## Registering tools: the platools SDK

Tool authors use the **platools** SDK — available in Python and TypeScript. It handles the WebSocket handshake, pings, reconnection, schema marshaling, and HMAC verification on inbound invocations.

### TypeScript

```ts
import { PlatosToolServer } from "@platos/platools";

const server = new PlatosToolServer({
  gatewayUrl: "wss://platos.example.com/tools/sync",
  organizationId: "org_acme123",
  hmacSecret: process.env.PLATOS_TOOL_HMAC!,
});

server.register({
  name: "github.list_prs",
  namespace: "github",
  description: "List open pull requests in a repository.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string" },
      state: { type: "string", enum: ["open", "closed", "all"], default: "open" },
    },
    required: ["repo"],
  },
  handler: async ({ repo, state }) => {
    const res = await octokit.pulls.list({ owner: repo.split("/")[0], repo: repo.split("/")[1], state });
    return res.data.map(pr => ({ id: pr.number, title: pr.title, url: pr.html_url }));
  },
});

await server.connect();
```

### Python

```python
from platools import PlatosToolServer

server = PlatosToolServer(
    gateway_url="wss://platos.example.com/tools/sync",
    organization_id="org_acme123",
    hmac_secret=os.environ["PLATOS_TOOL_HMAC"],
)

@server.tool(
    name="github.list_prs",
    namespace="github",
    description="List open pull requests in a repository.",
    input_schema={
        "type": "object",
        "properties": {
            "repo": {"type": "string"},
            "state": {"type": "string", "enum": ["open", "closed", "all"], "default": "open"},
        },
        "required": ["repo"],
    },
)
async def list_prs(repo: str, state: str = "open"):
    return [
        {"id": pr.number, "title": pr.title, "url": pr.html_url}
        for pr in github.pulls.list(repo=repo, state=state)
    ]

server.run()
```

One tool server can host many tools. Platos doesn't care.

## WebSocket sync protocol

Endpoint: `wss://<host>/tools/sync/{org_id}`. Auth: `Authorization: Bearer <platos_api_token>` during HTTP upgrade.

### Messages (JSON over text frames)

| Direction | Type | Payload | Purpose |
|---|---|---|---|
| Client → Server | `register_tools` | `{ tools: [PlatosToolDefinition...] }` | Full registration. Replaces any prior registration from this entity for this `(project, environment)`. |
| Server → Client | `tools_registered` | `{ accepted: [...], rejected: [{name, reason}] }` | Ack. Rejected reasons: schema validation, name conflict across namespaces. |
| Client → Server | `ping` | `{ ts }` | Liveness. Every 25s. |
| Server → Client | `pong` | `{ ts }` | |
| Server → Client | `health_alert` | `{ toolName, status, reason }` | Server noticed degraded status (timeouts, 5xx rate). Informational; client may log. |
| Client → Server | `health_report` | `{ toolName, p95Ms, errorRate }` | Self-reported stats. Server persists to `PlatosToolHealth`. |
| Server → Client | `reconnect` | `{ reason }` | Server is shutting down this socket; reconnect with backoff. |

### Reconnect semantics

On disconnect, the SDK reconnects with exponential backoff (1s → 30s max). On reconnect, it re-sends `register_tools`. The server replaces the prior registration atomically — there's no gap where "old tools" are still callable but the server is dead.

A dead server's `PlatosToolHealth.lastStatus` flips to `failed` within 2 missed pings (~55s) and `failCount` starts climbing. Agents asking `find_tools` get the tool filtered out until it comes back.

## BM25 `find_tools`

In `execute-tool` mode, the agent sees only two tools: `find_tools(query)` and `execute_tool(name, args)`. `find_tools` returns the top-K most relevant tool definitions by name, namespace, and description.

Implementation:

- A BM25 index is built per `(project, environment)` scope from all `PlatosEntityToolMapping.enabled = true` rows.
- Index lives in Redis at `platos:tools:bm25:{projectId}:{environmentId}`, TTL 1 hour.
- Refreshed on any register/unregister or every 60 min.
- Query time: ~1ms for 10,000 tools.

```ts
// Example agent turn
find_tools("create a jira ticket for a failed deploy")
// returns:
// [
//   { name: "jira.create_issue", score: 12.4, description: "..." },
//   { name: "pagerduty.create_incident", score: 8.1, description: "..." },
//   ...
// ]
execute_tool("jira.create_issue", { project: "OPS", summary: "...", severity: "High" })
```

Top-K defaults to 8. Override per-agent with `findToolsK`.

## HMAC-signed execution

When the agent invokes a tool, Platos POSTs to the mapping's `callbackUrl` with these headers:

```
POST /platos/github/list_prs HTTP/1.1
Content-Type: application/json
X-Platos-Timestamp: 2026-04-19T12:00:00.000Z
X-Platos-Nonce: <32 hex chars>            # PPR-71: per-request replay nonce
X-Platos-Signature: <hex>                 # HMAC-SHA256 signature (see below)
X-Platos-User-Token: <opaque>             # optional — forwarded from session token

{ "input": { "repo": "acme/api", "state": "open" }, "__platos": { ... envelope ... } }
```

### Signature algorithm (current implementation — PPR-71)

```
signingString = "{timestamp}.{nonce}.{body}"
signature     = HMAC-SHA256(entity.serviceSecret, signingString)
header        = hex(signature)
```

`nonce` is a per-request random 16-byte value rendered as 32 hex chars. It MUST be unique across all requests signed with the same `serviceSecret` inside the skew window — Platos generates it with `crypto.randomBytes(16)` in `tool-executor.service.ts::sign()`.

Implemented in `apps/agent/src/tool-gateway/tool-executor.service.ts` at the `sign()` helper. The signing key is the entity's `serviceSecret` (the 32-byte hex string minted at entity registration, stored encrypted at rest). Platos ALSO embeds `nonce` + `signature` inside the `__platos` WebSocket envelope on the primary transport — the HTTP `X-Platos-*` headers are the fallback path.

### Verification (server-side)

1. Parse `X-Platos-Timestamp`. Reject if `abs(now - ts) > PLATOS_TOOL_HMAC_MAX_SKEW_SECONDS` (default 300s).
2. Recompute `HMAC-SHA256(serviceSecret, "{ts}.{nonce}.{body}")` and constant-time compare with `X-Platos-Signature`.
3. Test-and-insert `nonce` into a per-entity seen-nonces LRU (≈ 100k entries, FIFO eviction). If the nonce was already present within the skew window, the request is a replay — return 401.
4. On mismatch, return 401. Platos logs and retries per tool-level retry policy.

The platools SDK does all this for you. The TS SDK ships `verifyRequest()` in `@platosdev/platools-sdk/security/replay-guard` and the Python SDK ships `platools.security.verify_request` — both share the same per-entity nonce LRU shape.

### One-release back-compat (legacy `{ts}.{body}` fallback)

For one release the SDK also accepts the legacy signing string `"{ts}.{body}"` when `X-Platos-Nonce` is absent. This lets operators roll the agent and SDK independently. The SDK emits exactly one warning per process the first time it sees a legacy request, and replay protection is degraded for that single call. Remove the fallback after the next platools release.

This closes the replay-protection gap flagged in the PPR-23 follow-up note: previously a captured request could be replayed anywhere inside the 300-second skew window. With the nonce + LRU, the second copy of the same request is rejected.

### Response

```json
{ "output": [ { "id": 42, "title": "...", "url": "..." } ] }
```

Or on error:

```json
{ "error": { "code": "NOT_FOUND", "message": "Repository not found" } }
```

4xx responses (with JSON `error` body) are reported back to the LLM verbatim as a tool_result with `is_error=true`. 5xx starts Platos's retry policy (3 retries, exponential backoff) before surfacing as `is_error`.

## Three execution modes (recap)

Configure per-agent via `toolMode`:

### `direct`

Tool schemas are serialized into the main LLM request. Best for &lt;50 tools, tight control, low latency.

```
LLM call  →  [system, tool_schemas, messages]
           ←  tool_use or text
```

### `sub-agent`

Main LLM sees one tool: `run_subagent(query)`. A sub-agent (Haiku by default) gets all schemas and the query, executes tools, returns text. Best for 50-1000+ tools.

```
Main LLM  →  run_subagent("find open PRs")
Sub LLM   →  [system, 1000_schemas, "find open PRs"]
          ←  tool_use github.list_prs ...
          ←  "Found 3 open PRs: ..."
Main LLM  ←  "Found 3 open PRs: ..."
```

### `execute-tool`

Main LLM sees two meta-tools: `find_tools(query)` → BM25 search, `execute_tool(name, args)` → direct call. Best for open-ended registries where the LLM should "browse" tools.

```
Main LLM  →  find_tools("ticket creation")
          ←  [ jira.create_issue, linear.create_issue, ... ]
          →  execute_tool("jira.create_issue", { ... })
          ←  { ticket_id: ... }
```

## Per-agent tool permissions

On each agent, `enabledTools` is an array of `ToolDefinition.id` that the agent may call. A tool being enabled org-wide doesn't mean every agent can use it — agent-level opt-in is required.

`perToolPerms` is a map with per-tool overrides:

```json
{
  "tool_github_create_pr": { "requiresApproval": true, "destructive": true },
  "tool_slack_send_message": { "requiresApproval": false, "destructive": false }
}
```

- `requiresApproval: true` — every invocation starts `request_approval` automatically. User sees the tool call in the UI with **Approve** / **Deny** buttons before it fires.
- `destructive: true` — flagged in the UI, logged specially for audit, and (optionally) requires a second approval.

Combine with the agent's `autoApproveTools` list to whitelist trusted tools while leaving approval required globally.

## Health, alerts, rate limits

- Health rows (`PlatosToolHealth`) are updated on every tool call per `(tool, entity, environment)`. No separate polling probe — health is observed from real traffic.
- When `failCount >= 3` consecutive failures, the tool is flipped to `failed`. `find_tools` filters it out until a successful call resets the counter.
- Rate limits are enforced per `(entity, tool)` at the gateway: default 60/min, configurable per mapping. 429s don't count against `failCount`.

## Debugging

Every tool invocation is a span in the Turn trace. Open **Turns → [turn_id] → tool_use(...)** to see:

- Full request payload (body, headers, signature)
- Response (payload, latency, retries)
- Error chain if it failed

Plus the WebSocket connection log at `platos:tools:gateway:{entityId}:{environmentId}` shows every register/unregister/ping event.

## Local dev

For local testing without a public HTTPS endpoint, point `gatewayUrl` at `ws://localhost:3100/tools/sync/{org_id}` and use ngrok/cloudflared for `callbackUrl` if you want the Platos agent to invoke a tool server running elsewhere. Or just colocate the tool server in Docker Compose — it can resolve `http://agent:3100` for inbound events if you want bidirectional flow.

## Further reading

- Three modes in practice: [writing-agents.md](./writing-agents.md) (Example 3 uses sub-agent mode)
- HMAC secret rotation: [self-hosting.md](./self-hosting.md)
- platools SDK source: `packages/platools-ts/` and `packages/platools-py/`
