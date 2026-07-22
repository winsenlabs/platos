# Post-Connect-v3 execution plan — MCP consumption + subagent spawning + authz fixes

*2026-07-22. Connect v3 A–D is merged + live on test.platos. Three work streams
remain. Per decision: execute them on ONE branch (`platform-mcp-subagent-authz`),
logical commit per unit, no branch-per-phase fragmentation.*

## Order (as directed)

```
Connect v3 A–D ✅ (merged #61/#62/#63/#64)
        │
   ①  Native MCP consumption   ← right after D
        │
   ②  Subagent spawning
        │
   ③  Authz security fixes     ← "the secondary audit fixes", last
```

Method for all three: Opus builds → Fable adversarially verifies → fix → VPS
sequential build (local tsc OOMs) → deploy to test.platos → one commit per unit.
No new branches; everything lands on `platform-mcp-subagent-authz`.

⚠️ **Severity note:** stream ③ contains a *critical* cross-user conversation-read
finding. It is sequenced last per direction, but it is the highest-severity item
on this list — pull it forward on request.

---

## ① Native external-MCP consumption  (`apps/agent/src/mcp-agent/`)

Source spec: `winsen-1-walle/docs/01-platos-native-mcp-spec.md` (verified against
current source 2026-07-22; line numbers drifted ~+150). Goal: a Platos agent
consumes an external MCP server (Composio first) from the turn loop, with
per-end-user credentials. **Do NOT touch `mcp-platform/`** (Platos *serving* MCP).
~60% scaffolded (models, registry, executor gate/audit, REST, SSRF guards, tool
cache all exist). Four phases, one commit each:

1. **Transport + credentials (Gaps A+B).** Replace the hand-rolled JSON-RPC POST
   (`server-registry.service.ts:228` fetchToolsList `res.json()`@252;
   `mcp-tool-executor.service.ts:182` dispatch) with the official
   `@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport`
   (fallback `SSEClientTransport` for `remote-sse`) — handshake, `Mcp-Session-Id`,
   SSE parsing. Wrap the transport fetch with the existing
   `validatePublicUrl`/`fetchWithValidatedRedirects` SSRF guards. LRU pool of
   connected Clients keyed `(serverId, resolvedUrl, credentialHash)`, ~5 min idle
   evict. `McpCredentialService` resolving `credsSecretKey` via the **public**
   `ScopedEnvService.get(scope, name)` (returns decrypted plaintext; do NOT fork
   crypto; `credsSecretKey` = the bare VAR name). New `headersTemplate Json?`
   column on `PlatosMCPServer`, `{{secret}}` interpolation, applied to EVERY
   request. Never log resolved headers.
2. **Per-user templating (Gap C) — the isolation-critical piece.**
   `{{endUserId}}` (+`{{secret}}`) in url/headers. **Surprise: `endUserId` is
   threaded NOWHERE today** — plumb `platosEndUserId` from thread/scope → gateway
   executor → MCP executor (channel path resolves it at
   `channel-runtime.service.ts:~1435` but drops it before dispatch). Add
   `endUserId` to `McpExecuteInput`. **Hard invariant:** unresolved `{{endUserId}}`
   → structural `failed` ("requires linked user"), NEVER a shared identity.
   Two-users-two-identities isolation test (Fable's crown-jewel target). New
   nullable `discoveryUserId` column (catalog is per-server/shared; calls use the
   real user).
3. **Turn-loop integration (Gap D).** Register discovered MCP tools into
   `ToolRegistryService`'s scoped matrix with a new `mcpServerId` discriminator +
   `sourceEntityId:"mcp:<slug>"`, `category:"mcp"`, `callbackUrl:null` — so
   find_tools/execute_tools/display-modes/approvals/audit all work unchanged.
   **Surprise: `registerTools` demands a real `entityPk` + non-null callbackUrl**
   → needs a parallel MCP register path, not reuse. Gateway executor
   (`tool-executor.service.ts:~717`) branches on `mcpServerId` → dispatch via the
   MCP transport. Respect `PlatosAgentMCPBinding` like `linkedAgentIds`. Dots→`__`
   sanitization only at a first-class-exposure boundary (today MCP flows through
   find_tools/execute_tools as string args → dots fine). **Approval decision:**
   the gateway executor ALREADY opens a `PlatosAgentApproval` waitpoint before
   dispatch; the MCP executor has its OWN 4-tier gate → route MCP through the
   gateway applying the *MCP* policy (`PlatosOrgMcpPolicy`) into the gateway's
   waitpoint, and make the MCP internal call a pure transport dispatch (one gate,
   right policy, real waitpoint) — do NOT double-gate.
4. **Ops.** Discovery-refresh Trigger task (**Surprise: none exists** despite two
   comments claiming otherwise — build it, pattern = `observability-dlq-drain`),
   incl. re-register into ToolRegistry + evict removed tools. Cache invalidation
   on server delete + binding change (BM25/scoped cache, not just the Redis
   `mcp:tools:<id>` key). Env config (30s call / 15s discovery / pool 32 / 300s
   refresh). Secret redaction pass over logs + audit rows.

**Acceptance (§3):** #1,2,3,5 need a live Composio server + API key in SecretStore
+ a linked user (external dep — Tejas provides, like the Slack app tokens).
Verifiable without Composio: #4 (no-user structural failure), #6 (delete removes
tools within a refresh), #7 (existing tests + no secrets in logs/audit) + the
two-users isolation unit test. **`@modelcontextprotocol/sdk` must be added to
`apps/agent/package.json`** (only `packages/cli-v3` has it today; store 1.26.0
exports the needed transports).

## ② Subagent spawning

Spec: `docs/subagent-spawning-spec.md` (approved: both identity modes, ephemeral
default). `spawn_agent` meta-tool + `platos.agent.subrun` Trigger task (durable
multi-turn tool-calling loop via internal-turn callbacks, child thread with
`parentThreadId`) + report-back that WAKES the parent (`subagent_report` message →
durable parent turn). Guardrails: scope inherited never chosen, depth ≤2, children
cap, budget shared pool, tool-ACL narrowing, spawn dedupe, `parentRunId` tags.
Existing `delegate_to_sub_agent` / `spawn_bgo` / `agent_batch` stay.

## ③ Authz security fixes

Findings: `docs/security-audit-authz-2026-07-22.md` — 7 CONFIRMED
(1 critical, 5 high, 1 medium). Cross-*tenant* boundary holds; the end-user↔
operator boundary is broken where handlers omit `requireOperator()`, and
public-guest tokens are `principal='end-user'` with a full scope. Fixes:

| Sev | Fix |
|---|---|
| 🔴 Crit | Gate the client-trusted `allUsers` flag on `principal==='operator'` (thread list/get/messages; mirror the WS gateway at `connections.gateway.ts:1073`) — gate the FLAG not the endpoint (end-users read their OWN threads) |
| 🟠 High | `requireOperator` on agent-config CRUD (`agent.controller.ts:~1199`) |
| 🟠 High | `requireOperator` on tool toggle + arbitrary tool execute (`~1613`) |
| 🟠 High | ownership/operator gate on `monitoring/trace/:threadId` (`trace.service.ts:84`) |
| 🟠 High | `requireOperator` on `POST /mcp/platform/tokens` (`mcp-platform.controller.ts:654`) — blocks self-mint of an all-perms platform token |
| 🟡 Med | `requireOperator` on provider BYOK-key CRUD (`providers.controller.ts:94`) |

Fable-verify precise gating (over-gating breaks legit webapp-operator + SDK-
own-thread flows). Same thesis as `docs/security-audit-2026-07-16.md` (scope
tuple ≠ user boundary), round 2 — the operator tier exists, just isn't called here.
