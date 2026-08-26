# External MCP Servers as Connected Entities — Design

**Status:** Architecture decision, ready for implementation
**Author:** Architect (per Tejas directive)
**Date:** 2026-07-22
**Supersedes:** the standalone-`PlatosMCPServer` model in `winsen-1-walle/docs/01-platos-native-mcp-spec.md` (Gap D's "synthetic `sourceEntityId` shim" is replaced by a real entity row)

> Tejas, verbatim: *"let Composio and any other MCP service be a CONNECTED ENTITY — that's all."*
> This document takes that literally and structurally: an external MCP server **is** a `PlatosConnectedEntity` of a new **connection kind**. It does not get a parallel registry, a parallel matrix, a parallel executor, a parallel approval path, or a parallel audit convention. Phase 1 (`apps/agent/src/mcp-agent/`) does not survive as dead parallel code — its two genuinely-reusable primitives (connection pool, credential/header resolver) are relocated onto the entity dispatch path; everything else is deleted.

---

## 0. TL;DR

| Question | Decision |
|---|---|
| **The model** | External MCP server = `PlatosConnectedEntity` with `connectionKind = "mcp"`. Its transport config (url/transport/creds/headersTemplate) lives in a new 1:1 `PlatosEntityMcpClient` row. Tools register into the **existing** `PlatosToolDefinition` + `PlatosEntityToolMapping` matrix. |
| **Dispatch** | One new branch in `ToolExecutorService.executeInner`, keyed on `entity.connectionKind`, inserted **before** the wire-entity `serviceSecret`/HMAC block. MCP kind → `mcpDispatch()` (pooled SDK `client.callTool`). Wire kind → unchanged WS/HTTP path. |
| **Per-user creds** | Inherits the entity end-user identity that the wire path already resolves. `{{endUserId}}` is resolved from the turn's `PlatosEndUser`; unresolved + templated ⇒ **structural failure, never a shared identity** — a NEW fail-CLOSED invariant (stricter than the fail-OPEN OIDC token block; §3.2/§3.4). |
| **Phase 1 fate** | `McpConnectionPool` + `McpCredentialService` **move** onto the entity path. `McpServerRegistryService`, `McpToolExecutorService`, `mcp-agent.controller.ts`, and the `PlatosMCPServer` / `PlatosMCPServerTool` / `PlatosAgentMCPBinding` models are **deleted**. `PlatosOrgMcpPolicy` **stays** (shared tier-2 store). |
| **Turn loop** | **Zero** turn-loop special-casing. `find_tools` / `execute_tools` / `SchemaInjectorService` / `linkedAgentIds` / approvals / audit already operate on `OrgToolEntry`; MCP tools become ordinary entries. |

---

## 1. THE MODEL

### 1.1 Decision

**An external MCP server (Composio, Linear-hosted, any streamable-HTTP MCP endpoint) is a `PlatosConnectedEntity`.** We add a single discriminator column `connectionKind` to distinguish *how tools are transported*:

- `connectionKind = "wire"` (**default, all existing entities**) — the classic platools relationship: a customer backend connects **inbound** (WS `/tools/sync` or registers an HTTP callback), Platos signs each dispatch with the entity's `serviceSecret` (HMAC), and the backend authenticates Platos's call.
- `connectionKind = "mcp"` (**new**) — an **outbound** MCP client relationship: Platos initiates the connection *to* the external server via the MCP SDK, authenticating with headers (API key / bearer / per-user token). There is no `serviceSecret` handshake and no callback URL; Platos is the client, not the server.

This is deliberately a **transport-direction** discriminator, because that is the only real difference between the two. Everything else an entity provides — the doorway identity, the scoped tool matrix, `linkedAgentIds` visibility, BM25/`find_tools`, the dispatch chokepoint, the 4-tier approval gate, the audit table, and (critically) the per-end-user credential machinery — is **shared verbatim**.

`connectionKind` is orthogonal to the existing `capabilities` array (`"tools" | "channel" | "identity"`). An MCP entity is `capabilities: ["tools"]`, `connectionKind: "mcp"`. We do **not** overload `capabilities` for this, because `capabilities` answers *"what kind of doorway"* and `connectionKind` answers *"which transport moves the tool call."*

### 1.2 Why not "keep `PlatosMCPServer`, bolt entity-UX on top"

Rejected. That is the parallel-code outcome Tejas explicitly ruled out. Keeping `PlatosMCPServer` means keeping a second registry, a second matrix (`PlatosAgentMCPBinding`), a second executor, a second (incomplete) approval story, and the audit-FK conflation where `PlatosToolCallAudit.entityPk` sometimes dereferences a `PlatosConnectedEntity` and sometimes a `PlatosMCPServer`. It also duplicates the crown-jewel per-user credential system instead of inheriting it. "Connected entity — that's all" means one object graph, not two with a UX veneer.

### 1.3 Data model

**Modified — `PlatosConnectedEntity`** (`schema.prisma:3614`):
```
+ connectionKind String @default("wire")  // "wire" | "mcp"
+ mcpClient      PlatosEntityMcpClient?    // 1:1, present iff connectionKind == "mcp"
```

**New — `PlatosEntityMcpClient`** (1:1 with entity, PK = `entityPk`, mirrors the `PlatosEntityMcpConfig` shape/relation convention — but note the two are opposite directions; see §1.4):
```
model PlatosEntityMcpClient {
  entityPk        String                @id
  entity          PlatosConnectedEntity @relation(fields: [entityPk], references: [id], onDelete: Cascade)
  transport       String                // "remote-http" | "remote-sse" | "hosted-*" (stdio deferred, dev-only)
  url             String?               // remote only; MAY contain {{endUserId}}
  credsSecretKey  String?               // bare SecretStore var name; never the raw secret
  headersTemplate Json?                 // { header: valueTemplate }; values may embed {{secret}} / {{endUserId}}
  lastDiscoveryAt DateTime?
  discoveryError  String?               @db.Text
  createdAt       DateTime              @default(now())
  updatedAt       DateTime              @updatedAt
}
```
These are exactly the surviving fields of `PlatosMCPServer`, **reparented onto the entity** (1:1) instead of being a standalone row. `agentId`, `slug`, `displayName`, `command/args/envVars` do **not** survive as columns here — they map onto entity fields (see §1.5).

**Modified — `PlatosEntityToolMapping`** (`schema.prisma:4011`): `callbackUrl` becomes **nullable**. Wire entities keep a callback URL; MCP entities have none (dispatch is outbound and never reads it). The `mcpDispatch` branch fires before any callback read, so a null is safe.

**In-memory `callbackUrl` typing (do NOT widen to `string | null` everywhere).** The DB column goes nullable, but the hydrated in-memory shapes `OrgToolEntry` (`tool-registry.service.ts:26`) and `ToolRouteMatch` (`tool-router.service.ts:53`) are both typed `callbackUrl: string` and flow through many wire call sites. Widening the type to `string | null` would force null-guards across all of them. Instead, at the single hydration point where DB rows become `OrgToolEntry`s (`tool-registry.service.ts:156`, `callbackUrl: m.callbackUrl`), coerce a null DB value to a **non-dereferenced sentinel** — `m.callbackUrl ?? "mcp:noop"` — for mcp-kind rows. The sentinel is **never fetched**: the `executeInner` mcp branch (§4) returns before the wire `serviceSecret`/callback block ever reads it, and `find_tools`/router never dereference it. The type stays `string`; the churn stays zero; the null lives only in Postgres. (See GAP-4 for the one operator surface that *does* read `callbackUrl` directly — the dashboard direct-POST test — which is handled explicitly, not by the sentinel.)

**Deleted:** `PlatosMCPServer`, `PlatosMCPServerTool`, `PlatosAgentMCPBinding` (see §2).

**Unchanged and reused as-is:** `PlatosToolDefinition`, `PlatosEntityToolMapping` (aside from the nullable callback), `PlatosToolHealth`, `PlatosToolCallAudit`, `PlatosMcpOidcSession`, `PlatosEndUser`/`PlatosEndUserIdentity`, `PlatosOrgMcpPolicy`.

### 1.4 Naming hazard (call out for the implementer)

`PlatosEntityMcpConfig` already exists and governs the **opposite** direction — Platos *serving* MCP to external clients (Claude Desktop etc.), PIFSP-21/22/25. The new `PlatosEntityMcpClient` governs Platos *consuming* an external MCP server. Do **not** merge them, do not reuse `identityProviders`/`toolAllowlist` from the server-side config for the client side. Two 1:1 configs, two directions, hung off the same entity. The spec's line-19 warning ("*Do not confuse this with `mcp-platform/` … different direction; leave it alone*") is exactly this boundary — respect it.

### 1.5 Mapping Phase-1 concepts onto entity concepts

| Phase 1 (`PlatosMCPServer`) | Entity model |
|---|---|
| `slug` | `entity.entityId` (the human slug) — used verbatim as `sourceEntityId` in the matrix cache key |
| `displayName` | `entity.displayName` |
| `agentId` non-null (per-agent install) | `entity.linkedAgentIds = [agentId]` |
| `agentId` null (org-scope, needs binding) | `entity.linkedAgentIds = []` (unrestricted) or an explicit multi-agent list |
| `PlatosAgentMCPBinding` per-agent-per-tool toggle | **collapses** to `entity.linkedAgentIds` (entity visibility) + `PlatosEntityToolMapping.enabled` (per-tool, per-env). See note below. |
| `transport / url / credsSecretKey / headersTemplate` | `PlatosEntityMcpClient` |
| `PlatosMCPServerTool` (discovery cache) | `PlatosToolDefinition` + `PlatosEntityToolMapping` |
| `PlatosOrgMcpPolicy` | unchanged (tier-2 store for the shared `MCPPermissionGatewayService`) |

**Deliberate granularity reduction:** the entity matrix expresses "*which agents see this entity*" (`linkedAgentIds`) and "*is this tool enabled in this env*" (`PlatosEntityToolMapping.enabled`), but not "*agent A sees tool X but not tool Y of the same entity*." Phase 1's `PlatosAgentMCPBinding.enabledTools` allowed that finer per-agent-per-tool cut. **No acceptance criterion requires it** (AC6 is satisfied by entity-level `linkedAgentIds` or per-tool `enabled`). We accept the coarser model; if per-agent-per-tool selection is ever a real customer need, it is a separate feature on the shared matrix, not a reason to keep a parallel table. This is a conscious simplification, not an oversight.

### 1.5a Wire-only entity columns for the mcp kind (least-invasive reuse)

Three existing `PlatosConnectedEntity` columns assume a wire entity. Rather than make them nullable-per-kind (schema churn + null-guards on the wire path), the mcp kind satisfies them harmlessly:

- **`serviceSecret String` (NOT NULL, `schema.prisma:3627`)** — the HMAC/WS-upgrade secret. mcpDispatch never reads it (outbound, no handshake). **Keep the column NOT NULL; generate-and-ignore.** Registration already supports `serviceSecret: "auto"` (`entities.ts:167`) which mints a random secret; the mcp registration path passes `"auto"` unconditionally. The row carries a valid-but-unused secret, so `entities_provision`/rotate/list all keep working and nothing on the mcp path ever signs with it. No schema change.
- **`mcpUrls String[]` + `entities_register` `minItems: 1` (`entities.ts:153`)** — this array is the *wire* "sync-from" endpoint list and is easily confused with the **outbound** `PlatosEntityMcpClient.url`. They are **not** the same thing. **Relax the `minItems` check per kind:** for `connectionKind === "mcp"`, `mcpUrls` is **not required** (register with `mcpUrls: []`); the real outbound endpoint arrives as `mcpClient.url` in the registration payload and lands on `PlatosEntityMcpClient`, never on `mcpUrls`. Keep `minItems: 1` enforced for wire. Do **not** overload `mcpUrls` to hold the client URL — that would resurrect the naming confusion §1.4 warns about.
- **`connectionStatus String @default("disconnected")` (`schema.prisma:3632`)** — surfaced by `entities_list` / `entities_census`. Wire entities flip to `"connected"` on WS upgrade. mcp entities have no inbound connection, so **`EntityMcpDiscoveryService` must stamp `connectionStatus = "connected"` on a successful `tools/list`** (and back to `"disconnected"` + set `PlatosEntityMcpClient.discoveryError` on failure). Without this, every MCP entity shows **disconnected forever** in census/list even while dispatch works.

### 1.5b Environment scoping of discovery (MIRROR the wire path exactly)

**The problem.** `PlatosConnectedEntity` is `(organizationId, projectId)`-scoped — it has **no** `environmentId`. But `PlatosEntityToolMapping` **requires** `environmentId` (composite unique `toolId_entityId_environmentId`), and `ToolRegistryService.registerTools` takes a mandatory `environmentId`. So discovery must decide which env(s) it writes tool definitions into, and who supplies that id.

**How wire entities do it today (the behavior we mirror).** A wire backend registers tools into **exactly one `RuntimeEnvironment` per WS connection** — the env it selected on the `/tools/sync` upgrade via `?env=<slug|id>` (`tool-sync-ws.service.ts:220-255`: exact `RuntimeEnvironment.id` match → normalized type hint → **`DEVELOPMENT` fallback**). `environmentId` is **always supplied by the caller** (the resolved connection), **never invented inside `registerTools`**. A backend that wants tools live in dev + staging + prod opens **one connection per env** and registers into each. There is no "register into all envs at once" primitive and no single canonical env — the entity is available in whatever env set its backend actually connected to.

**The MCP mirror (decided).** Discovery is Platos-initiated (outbound), so there is no inbound connection to carry an env. We therefore replace "one connection per env" with "one registration pass per env," enumerating the same env set a wire entity could land in — **all `RuntimeEnvironment`s of the entity's `(org, project)`**:

- `EntityMcpDiscoveryService.discover(entityPk)` reads the entity, then enumerates `prisma.runtimeEnvironment.findMany({ where: { projectId: entity.projectId } })`. **This `findMany` is the sole supplier of `environmentId`** — the caller of `discover` never passes one, mirroring the wire rule that ids come from resolved infra rows, not from the registration payload.
- For **each** enumerated env it calls, once per env: `ToolRegistryService.registerTools({ organizationId, projectId, environmentId, entityPk, sourceEntityId }, discoveredTools, /* callbackUrl */ null)` then `reconcileEntityTools(entityPk, environmentId, freshToolNames)`. `registerTools`/`reconcileEntityTools` keep their existing **single-`environmentId`** signatures unchanged — discovery loops; the registry stays env-at-a-time exactly as the wire path drives it.
- The **periodic refresh sweep** (§5) iterates the **existing `(entity, env)` mappings** — i.e. the env set the entity already has tools in — and re-discovers each, exactly mirroring a wire backend re-registering on reconnect. A newly-created `RuntimeEnvironment` picks up the entity's tools on the next full `discover(entityPk)` pass (started by create/update), same as a wire backend would have to open a connection to the new env.

**Why this is safe even though the entity has no env.** Tool **definitions** are env-independent (name/description/schema); registering the same definitions across every project env is the faithful analog of a wire backend that connected to every env. **Per-user credentials are resolved per-env at *dispatch* time, not at discovery time:** `mcpDispatch` resolves `credsSecretKey` through `ScopedEnvService` keyed on `scope.environmentId` (§3.2, §5), so a single `PlatosEntityMcpClient.credsSecretKey` transparently yields a different secret value per env (dev key vs prod key) without the client row needing an env column. Definitions fan out across envs; secrets stay per-env. This is precisely why the entity can stay `(org, project)`-scoped while the mapping stays per-env.

### 1.6 Justification against the acceptance criteria + the isolation invariant

- **AC1 (register + discover + tool-matrix):** operator registers an MCP entity; discovery (§3) writes `PlatosToolDefinition`/`PlatosEntityToolMapping`; the existing `entities_get_tools` / tool-matrix surfaces show them. ✔
- **AC2 (find + execute in a live turn, correct `user_id`):** MCP tools are ordinary `OrgToolEntry`s → `find_tools`/`execute_tools` reach them with no new code; `mcpDispatch` substitutes the turn's end user into `{{endUserId}}`. ✔
- **AC3 (two users → two `user_id`s, no pool sharing):** `{{endUserId}}` differs per user → resolved URL/headers differ → connection-pool key differs (key already includes resolved URL + resolved-headers hash). ✔
- **AC4 (no linked user + templated tool → structural failure):** the invariant, enforced fail-closed in `resolveHeaders`/`resolveUrl` **and** re-checked at the dispatch boundary (§3.2). This is a NEW fail-CLOSED rule — stricter than, and deliberately unlike, the fail-OPEN OIDC token block (§3.4 / GAP-6). ✔
- **AC5 (`require_approval` pauses with a real waitpoint):** MCP tools ride `ToolExecutorService.checkDispatchPermission` → `runApprovalPause` (the full BLPOP/Redis/Socket.IO implementation). Phase 1's status-only stub is deleted; approval parity is a **bug fix by inheritance**. ✔
- **AC6 (delete/disable removes tools within a refresh):** entity delete cascades `PlatosEntityToolMapping` (FK) → cache/BM25 eviction; `linkedAgentIds` edit → `syncEntityLinkedAgents` live-patch; per-tool disable → `setToolEnabled`. ✔
- **AC7 (existing entity tests pass; no secret leakage):** wire path is untouched (branch fires only for `connectionKind === "mcp"`); `McpCredentialService` redaction contract is preserved; audit rows never carry headers. ✔

---

## 2. RECONCILIATION WITH PHASE 1

Phase 1 is currently **uncommitted / net-new** on this branch (`git status`: modified `mcp-agent.module.ts`, `mcp-tool-executor.service.ts`, `server-registry.service.ts`, `shared/env.ts`, `schema.prisma`, `package.json`; untracked `mcp-client-pool.service.ts`, `mcp-credential.service.ts`; untracked migration `20260722180000_mcp_headers_template`). The `PlatosMCPServer`/`Tool`/`Binding` **tables** themselves predate Phase 1 — they were added by the committed April migration `20260422100000_platos_mcp_tables`, so they may exist in the prod DB even though nothing in the turn loop ever wrote through them.

### STAYS (moves onto the entity path)
- **`McpConnectionPool`** (`mcp-client-pool.service.ts`) — the LRU pool of official-SDK `Client`s, SSRF-pinned fetch, per-(id, url, creds-hash) keying, in-flight dedupe. **Relocate** to `apps/agent/src/tool-gateway/mcp-transport/` (or a shared `mcp-client` module imported by `ToolGatewayModule`). Its `GetClientInput.server` type is already `{ id: string }` — structural, no `PlatosMCPServer` coupling. Pool key gains nothing new structurally; §3.2 just guarantees the resolved URL fed to it already carries `{{endUserId}}`.
- **`McpCredentialService`** (`mcp-credential.service.ts`) — header resolution, `{{secret}}` interpolation, the `Json?`-shape-footgun guard, the redaction contract, `credentialHash`. **Relocate** alongside the pool. **Extend** to resolve `{{endUserId}}` (§3.2). Its `CredentialServerSlice` type is already structural (`{ headersTemplate?, credsSecretKey? }`) — `PlatosEntityMcpClient` satisfies it unchanged.
- **Discovery logic** (`fetchToolsList` / `syncDiscovery` bodies inside `server-registry.service.ts`) — the `initialize` + `tools/list` round-trip over the pooled SDK client. **Extract** into a new `EntityMcpDiscoveryService` (§3.1) whose output is `ToolRegistryService.registerTools`, not `PlatosMCPServerTool`.
- **SSRF layer** (`shared/url-validator.ts`) — already shared; untouched.
- **`PlatosOrgMcpPolicy`** + `MCPPermissionGatewayService` — untouched; already the shared tier-2 store used by `checkDispatchPermission`.
- **`shared/env.ts`** MCP knobs (`MCP_POOL_*`, `MCP_*_TIMEOUT_MS`) — keep the ones the pool/discovery still use (§5).

### MOVES / TRANSFORMS
- `PlatosMCPServer` transport columns → `PlatosEntityMcpClient` (reparented 1:1).
- Discovery output `PlatosMCPServerTool` → `PlatosToolDefinition` + `PlatosEntityToolMapping`.
- `PlatosAgentMCPBinding` semantics → `linkedAgentIds` + `PlatosEntityToolMapping.enabled` (§1.5).

### DELETED (no dead parallel code)
- **`McpToolExecutorService`** (`mcp-tool-executor.service.ts`) — entire service. Its `dispatch()` body (~40 lines: SSRF re-check, `resolveHeaders`, pooled `client.callTool`) migrates into `ToolExecutorService.mcpDispatch`. Its permission-gate call, its `findServer` resolution, and its audit write are **all redundant** — the executor already gates, resolves via the matrix, and audits.
- **`McpServerRegistryService`** (`server-registry.service.ts`) — the CRUD/matrix/binding half is deleted; only the discovery round-trip is extracted (above).
- **`mcp-agent.controller.ts`** — the `POST /servers`, `PUT …/bindings`, `GET …/tool-matrix` REST surface. Entity CRUD is done through the existing entity controller + MCP admin tools (`entities_register`/`entities_set_linked_agents`/`entities_get_tools`), extended for the MCP kind (§Commit 5).
- **`mcp-agent.module.ts`** — folded away; discovery service + relocated pool/credential wire into `ToolGatewayModule`.
- **Models** `PlatosMCPServer`, `PlatosMCPServerTool`, `PlatosAgentMCPBinding` — dropped (§Commit 6 migration; verify-empty gate).
- **The uncommitted `20260722180000_mcp_headers_template` migration** — do **not** ship it. `headersTemplate` is born on `PlatosEntityMcpClient` instead. Revert the file.

**Net:** after this work, `grep -r "PlatosMCPServer\|McpServerRegistry\|McpToolExecutor\|PlatosAgentMCPBinding" apps/agent/src` returns **zero** hits. The only survivors of Phase 1 are the two transport primitives, now living under the tool-gateway.

---

## 3. PER-USER ISOLATION (Phase 2) — inherited, not rebuilt

The single biggest payoff of the entity model: **MCP inherits the end-user identity the entity path already resolves.** We do not invent a per-user identity source for MCP — we reuse the turn's resolved `PlatosEndUser`.

### 3.1 Where the end-user comes from — every dispatch entry point pinned

**The identity carrier.** Add `endUserId?: string | null` to the existing `ToolCallOrigin` interface (`tool-executor.service.ts:83`), alongside `source`/`mcpUserId`/`mcpClientId`. The value is the resolved `PlatosEndUser.externalUserId` — the customer-meaningful opaque id — which becomes Composio's `user_id`. It rides the **existing** origin, not a bespoke `McpExecuteInput`.

**Signature change (required).** `executeBatch(calls, scope)` today (`tool-executor.service.ts:1086`) drops origin entirely — it fans out to `execute(call, scope)` with **no third arg**. Change it to `executeBatch(calls, scope, origin?: ToolCallOrigin)` and forward `origin` into every `execute(call, scope, origin)`. Without this, the two turn-loop `executeBatch` call sites (below) can never carry an end user, and every `{{endUserId}}` MCP tool invoked from a live turn or a skill would fail closed — a functional regression, not just an isolation gap.

**Every `execute()` / `executeBatch()` call site and its `endUserId` source:**

| # | Entry point (anchor) | `origin.source` | `endUserId` source |
|---|---|---|---|
| i | Turn-loop remote batch — `agent.service.ts:1764` | `agent_turn` | `thread.platosEndUserId` → load `PlatosEndUser.externalUserId`. The thread already carries `platosEndUserId` (`schema.prisma:3354`, resolved by `resolveEndUser()` in `getOrCreateThread`). Thread it through the new `executeBatch(..., origin)` arg. |
| ii | mcp_client inbound RPC — `mcp-entity.controller.ts:983` | `mcp_client` | Resolve from `origin.mcpUserId` / the token's OIDC linkage to a `PlatosEndUser`. **Fail-closed for mcp-kind tools:** if no `PlatosEndUser` resolves and the target tool is `connectionKind==="mcp"` with a `{{endUserId}}` template, dispatch **must fail** at the §3.2 guard — never fall through to a shared identity. (Already passes an origin object at :994; add `endUserId` to it.) |
| iii | Replay — `agent.controller.ts:3842` | `replay` | The stored audit row's origin. The `PlatosToolCallAudit` row already persists `mcpUserId`/`source` (and must also persist `endUserId` — add it to the audit write); replay reconstructs `origin` from the stored row rather than passing none. A replayed mcp-kind `{{endUserId}}` tool with no stored end user fails closed (correct — you cannot silently re-attribute it). |
| iv | wire_test admin tool — `entities.ts:237` | `wire_test` | N/A — this path tests **wire** entities only. For an mcp-kind entity, `entities_wire_test` is the wrong door; route MCP tool-testing through the §GAP-4 dashboard flow / `mcpDispatch`, or reject with a kind-aware error. If ever exercised against an mcp tool, `endUserId` is explicit-or-absent and the §3.2 guard fails it closed. |
| iv-b | Controller wire-test — `agent.controller.ts:2076` (`POST entities/:entityId/wire-test`, EOBD.97) | *(none today; add `wire_test` for audit consistency)* | Same "wrong door for mcp" posture as (iv). Today it calls `execute(call, scope)` with **no origin at all** — so `endUserId` is absent and an mcp-kind `{{endUserId}}` tool fails closed at the §3.2 guard with zero upstream calls. **Never synthesize an endUserId here.** Optional tidy-up in Commit 4: pass `{ source: "wire_test" }` so the audit row is attributed; behavior is already correct without it. |
| v | Skill invocation batch — `agent.service.ts:3877` | `skill_invocation` | The owning thread's end user — same `thread.platosEndUserId → externalUserId` as (i). Forward via the new `executeBatch(..., origin)` arg from the skill's `args.scope`/thread context. |
| vi | Durable Trigger path — `/internal/execute-tool` (§7) | `agent_turn` (reconstructed) | The reconstructed `RequestScope` must carry the resolved end user through the HMAC payload; §7 covers the plumbing. A `{{endUserId}}` mcp tool invoked from a durable task with no reconstructed end user fails closed. |

Provenance of the underlying value is unchanged from the spec's Gap-C wiring: on the API path `X-Platos-Session-Token` / `X-Platos-User-Token` → `resolveEndUser()`; on the Slack/channel path `channel-runtime.service.ts` speaker identity → `PlatosEndUser`. The novelty here is only that the resolved id **rides the origin all the way to `mcpDispatch`**, including across the previously origin-blind `executeBatch`.

### 3.2 Resolution + the HARD invariant
Extend `McpCredentialService`:
```
resolveHeaders(server, scope, endUserId?: string | null): Record<string,string>
resolveUrl(urlTemplate, endUserId?: string | null): string   // NEW — url can also carry {{endUserId}}
```
Rules (identical posture for URL and headers):
1. Scan template for the literal `{{endUserId}}`.
2. If present **and** `endUserId` is null/empty → throw `McpCredentialError("tool requires a linked end user")`. **Never substitute a default, a placeholder, an org id, or `scope.userId`.** `mcpDispatch` maps this to a structured `{ status: "failed", error: "tool requires a linked user" }` and **dispatches nothing upstream** (mock transport receives zero calls — AC4).
3. If present and resolved → interpolate via `split/join` (same as `{{secret}}`).
4. `{{secret}}` unchanged (lazy fetch via `ScopedEnvService`, keyed on `scope.environmentId`, redacted errors).

**HARD dispatch-boundary invariant (state unambiguously, enforce belt-and-suspenders).** Independently of the resolver throwing, `mcpDispatch` performs a **final post-substitution scan** on the resolved `url` and every resolved header value immediately before touching the pool/transport. If the literal `{{endUserId}}` **still appears** in any resolved value, `mcpDispatch` returns a structured `{ tool, status: "failed", error: "tool requires a linked user", latencyMs }` and **sends nothing upstream** — no pool `getClient`, no `client.callTool`, zero bytes on the wire. It **never** substitutes, defaults to, or falls back on a shared/org/`scope.userId` identity. Two enforcement points, one rule: the resolver throws on a templated-but-null id (step 2), and the dispatch boundary refuses any residual template that slipped through. A pooled `Client` is created **only** from fully-substituted url+headers, so a mis-substituted call can never reach — let alone reuse — another user's session (AC4 + AC3).

**Relationship to the OIDC block (do NOT call this a "mirror").** The OIDC token-forwarding block at `tool-executor.service.ts:858-877` is explicitly **fail-OPEN**: its own comment says *"Fail-open: a missing/expired token means the entity sees no token header and must handle that gracefully"*, and its `catch {}` swallows lookup errors so dispatch proceeds token-less. The `{{endUserId}}` rule is therefore **not** a reuse of that posture — it is a **NEW, stricter, fail-CLOSED** invariant: where OIDC omits a header and continues, the template rule **aborts the entire dispatch**. Earlier drafts said the rule "mirrors" the OIDC path; that was inaccurate and is corrected here. The shared idea is only the slogan **never fall back to a shared identity** — the OIDC path achieves that by forwarding no token to a backend that already knows its own users, while the template path (whose whole identity signal *is* the substituted id) must instead refuse to dispatch. This distinct behavior gets its **own unit test** in Commit 2 (templated + no endUserId ⇒ throws/failed, zero upstream calls), separate from any OIDC test.

### 3.3 Pool-level isolation (defense in depth)
`McpConnectionPool` key = `${entity.id}:${resolvedUrl}:${credentialHash(resolvedHeaders)}`. Because `resolvedUrl` and `resolvedHeaders` already contain the substituted `{{endUserId}}`, two different end users **cannot** share a pooled `Client` session even if a substitution bug slipped a wrong value through — the key diverges. This is the spec's Gap-A requirement ("*pool keyed on the resolved URL/credentials so users never share a session*") satisfied for free by keying after resolution. (AC3.)

### 3.4 Relationship to the OIDC vault
Both mechanisms coexist and both hang off the entity:
- **Templated (`{{endUserId}}`)** — Composio-style. The end-user id is *substituted* into the outbound request; the external server scopes by `user_id`. No per-user token stored. **This is the default and the only one AC1–AC7 require** (spec: "*Start with templates; Composio does not need the table*").
- **OIDC-federated (`PlatosMcpOidcSession`)** — for external servers that need a real per-user OAuth token. Already implemented for wire entities; an MCP entity could reuse it (forward the decrypted token as a header) if a future server needs it. **Out of scope for this phase** — noted so the door stays open without a schema change. Note its posture is **fail-OPEN** (`:858-877`): a missing token means "no header, keep going," which is safe *for OIDC* because the backend authenticates the user itself. The templated path cannot borrow that posture — its identity signal is the substituted id, so a missing id must fail closed (§3.2). The two are different-posture-by-design, not the same rule applied twice.

---

## 4. TURN-LOOP INTEGRATION (Phase 3) — zero special-casing

The entire point of the model: because an MCP tool is an ordinary `PlatosEntityToolMapping` row on an ordinary entity, **the turn loop needs no MCP-aware code at all.**

- **Registration → matrix:** `EntityMcpDiscoveryService` loops the project's `RuntimeEnvironment`s (§1.5b — the env supplier) and calls, **once per env**, `ToolRegistryService.registerTools({ organizationId, projectId, environmentId, entityPk: entity.id, sourceEntityId: entity.entityId }, discoveredTools, /* callbackUrl */ null)`. `registerTools` already stamps `linkedAgentIds` + write-throughs `scopedToolCache` + indexes BM25, and keeps its single-`environmentId` signature. **Change required:** make `callbackUrl` optional/nullable in `registerTools` and the mapping upsert.
- **Visibility:** `isVisibleToAgent` / `linkedAgentIds` apply unchanged — MCP entity tools are gated per agent exactly like wire tools.
- **`find_tools`:** `toolRegistry.findTools(query, scope, limit, source, scope.agentId)` returns MCP entries with no change. Optional `sessionContext.entity_ids` narrowing works because MCP entities have a real `entityId`.
- **`execute_tools`:** the caller passes a bare tool name (MCP tools register under their bare name, e.g. `GITHUB_CREATE_ISSUE`, not a `slug.tool` qualified name — matching entity-tool convention and eliminating the dual naming scheme). Non-local calls fall through to `ToolExecutorService.executeBatch` → `execute()`.
- **Single gate, no double-gating:** `execute()` runs safety → rate-limit → `checkDispatchPermission` (tier-1..4, `PlatosOrgMcpPolicy` as tier-2) → `executeInner`. The deleted `McpToolExecutorService` gate is gone, so a call is gated **exactly once**. Approval `require_approval` uses `runApprovalPause` (real waitpoint) — AC5.
- **Dispatch branch** (the only executor change) in `executeInner`, inserted **before** the wire `serviceSecret` read (~`tool-executor.service.ts:743`):
  ```
  const entity = await this.prisma.platosConnectedEntity.findFirst({
    where: { id: toolEntry.entityPk, organizationId: scope.organizationId, projectId: scope.projectId },
    include: { mcpClient: true },   // 1:1
  });
  // ... existing L2 scope re-verify ...
  if (entity.connectionKind === "mcp") {
    return this.mcpDispatch(entity, entity.mcpClient, toolEntry, call, scope, origin, startTime);
  }
  // else: existing wire path (serviceSecret → HMAC → WS/HTTP) unchanged
  ```
  `mcpDispatch`: resolve `endUserId` from origin/scope → `resolveUrl` + `resolveHeaders` (guarded, §3.2) → `pool.getClient({ id: entity.id }, resolvedUrl, resolvedHeaders)` → `client.callTool({ name: call.tool, arguments: call.params }, undefined, { timeout: MCP_CALL_TIMEOUT_MS })` → return the same `{ tool, status, result, latencyMs }` shape the wire branch returns. **No `_context` envelope, no HMAC, no OIDC-token block** — those are wire-only.
- **Operator/dashboard tool-test flow (GAP-4 — the one direct callback read):** two test endpoints exist and behave differently:
  - `POST /tools/execute` (`agent.controller.ts:1622`) already routes through `toolExecutor.execute(..., { source: "wire_test" })`, so it hits the `mcpDispatch` branch automatically and works for mcp entities **unchanged** — just thread `endUserId` onto its origin (today it passes `{ source: "wire_test" }` with none; for an mcp tool with a `{{endUserId}}` template and no end user it correctly fails closed).
  - `POST` direct-callback test (`agent.controller.ts:~1690-1785`) is **wire-only by construction**: it reads `entity.serviceSecret` (HMAC-signs) and POSTs to `toolEntry.callbackUrl` itself, bypassing the executor. For an mcp-kind entity both are meaningless (dummy secret, `mcp:noop`/null callback). **Fix:** load `connectionKind` alongside `serviceSecret` at `:1713`; if `connectionKind === "mcp"`, **do not** build the HMAC/fetch — instead delegate to `toolExecutor.execute({ tool: toolEntry.toolName, params, purpose: "ui_test" }, scope, { source: "wire_test", endUserId })` (which runs `mcpDispatch`), or, if that delegation is deemed out of scope for this endpoint, **reject with a kind-aware 400**: `"MCP entities are not testable via the callback-POST path; use POST /tools/execute."` Preferred: delegate (one branch, full parity). Either way the endpoint must **never** read `entity.serviceSecret` or `toolEntry.callbackUrl` for an mcp row.
- **Health + audit:** unchanged. `execute()`'s wrapper records `PlatosToolHealth` and `PlatosToolCallAudit` with `entityPk = entity.id` — which now dereferences a **real** `PlatosConnectedEntity`, resolving Phase 1's audit-FK semantic conflation (`entityPk` no longer sometimes-a-server-sometimes-an-entity). AC7's "audit rows carry no secrets" holds because `mcpDispatch` never puts headers/url-with-secret into the audit payload.

---

## 5. OPS (Phase 4)

- **Discovery initiator:** on MCP-entity create/update, `EntityMcpDiscoveryService.discover(entityPk)` fires (fire-and-forget, like the old controller did). Plus a periodic refresh sweep every `PLATOS_MCP_DISCOVERY_INTERVAL_SEC` (default 300, reuse the old cache-TTL constant) over entities where `connectionKind = "mcp"` and `lastDiscoveryAt` is stale.
- **Replace semantics + prune:** discovery is idempotent-replace. `registerTools` is additive-upsert, so add `ToolRegistryService.reconcileEntityTools(entityPk, environmentId, freshToolNames[])` — disables/removes `PlatosEntityToolMapping` rows (and evicts BM25 + `scopedToolCache`) for tools no longer reported. Updates `PlatosEntityMcpClient.lastDiscoveryAt` / `discoveryError`.
- **Cache invalidation:** already handled by the registry's write-through + `syncEntityLinkedAgents` (linkedAgentIds edits) + `setToolEnabled`. Entity delete → FK cascade drops mappings; add the matching cache/BM25 eviction on delete if not already present. AC6.
- **Redis `mcp:tools:<serverId>` cache is retired** — the registry's `scopedToolCache` + Postgres are the single source of truth; no second cache to keep coherent.
- **Env knobs (final set):** `MCP_POOL_SIZE`, `MCP_POOL_IDLE_MS`, `MCP_DISCOVERY_TIMEOUT_MS`, `MCP_CALL_TIMEOUT_MS`, `PLATOS_MCP_DISCOVERY_INTERVAL_SEC`. Drop any `PlatosMCPServer`-specific knobs. Keep `PLATOS_TOOL_DISPATCH_PERMISSION_GATE` / `..._APPROVAL_TIMEOUT_SECONDS` (shared).
- **Secret redaction:** `McpCredentialService` already refuses to log/echo header values or the decrypted secret; preserve that contract in `mcpDispatch` (never log `resolvedHeaders` or a `resolvedUrl` that embedded a secret). `credentialHash` (sha256, non-reversible) is the only header-derived value that ever leaves the service, used solely as a pool-key component. AC7.

---

## 6. IMPLEMENTATION PLAN (one logical commit per unit)

> Opus executes top-to-bottom; Fable verifies each. **Every Prisma schema/migration change is flagged 🔶.**

**Commit 0 — Revert ALL uncommitted Phase-1 schema/migration drift.** 🔶
Two reverts, both mandatory:
1. Delete the migration folder `internal-packages/database/prisma/migrations/20260722180000_mcp_headers_template/`.
2. **Revert the uncommitted `schema.prisma` Phase-1 edits** — specifically the `+ headersTemplate Json?` field (and any other Phase-1 addition) on `model PlatosMCPServer` (`schema.prisma:~5149`, confirmed via `git diff schema.prisma`). `headersTemplate` is reborn on `PlatosEntityMcpClient` in Commit 1; it must **not** survive on `PlatosMCPServer`, or Commit 1's `prisma migrate dev` will generate a spurious `ALTER TABLE "PlatosMCPServer" ADD COLUMN "headersTemplate"` alongside the three intended changes.
Verify: migration folder gone; `git diff internal-packages/database/prisma/schema.prisma` shows **zero** changes touching `PlatosMCPServer` (the working tree matches `HEAD` for that model); no orphan migration.

**Commit 1 — Schema: entity as MCP connection kind.** 🔶
- Add `connectionKind String @default("wire")` to `PlatosConnectedEntity`.
- Add `PlatosEntityMcpClient` model (§1.3) + the `mcpClient PlatosEntityMcpClient?` back-relation.
- Make `PlatosEntityToolMapping.callbackUrl` nullable.
- New **additive** migration (default backfills every existing entity to `"wire"`; nullable callback is non-destructive). Verify: `prisma migrate dev` applies clean; existing entity rows unaffected; `entities_list`/wire dispatch untouched.
- **Generated-SQL assertion (Commit 0 depends on this):** the migration SQL contains **EXACTLY three** schema changes and nothing else — (a) `ALTER TABLE "PlatosConnectedEntity" ADD COLUMN "connectionKind" ... DEFAULT 'wire'`, (b) `CREATE TABLE "PlatosEntityMcpClient" (...)`, (c) `ALTER TABLE "PlatosEntityToolMapping" ALTER COLUMN "callbackUrl" DROP NOT NULL`. The generated SQL must contain **no statement referencing `PlatosMCPServer`** (in particular no `ADD COLUMN "headersTemplate"`). If any `PlatosMCPServer` line appears, Commit 0's schema-revert was incomplete — stop and fix Commit 0 before shipping this migration.

**Commit 2 — Relocate + extend the credential/pool primitives.**
- Move `mcp-credential.service.ts` + `mcp-client-pool.service.ts` to `apps/agent/src/tool-gateway/mcp-transport/`; wire into `ToolGatewayModule`.
- Extend `McpCredentialService` with `resolveUrl()` and the `endUserId` param + the fail-closed `{{endUserId}}` guard (§3.2).
- Unit-test the **NEW fail-CLOSED invariant** directly (its own test, distinct from any OIDC/fail-open test — GAP-6): templated + no endUserId ⇒ throws; templated + endUserId ⇒ interpolates; two endUserIds ⇒ two `credentialHash`es; and a resolved value with a residual `{{endUserId}}` ⇒ dispatch-boundary refusal (§3.2). Verify: new tests pass; no `mcp-agent` import remains.

**Commit 3 — Discovery service (reparented) + registry callback-optional + prune.** 🔶(no migration, but touches `registerTools` signature)
- New `EntityMcpDiscoveryService` (extracted `initialize`+`tools/list` over the pooled client). `discover(entityPk)` enumerates the project's `RuntimeEnvironment`s (§1.5b) and, per env, calls `ToolRegistryService.registerTools(..., callbackUrl?: string | null)` then `reconcileEntityTools`. The env supplier is the `runtimeEnvironment.findMany` inside `discover`; callers never pass an `environmentId`.
- Make `callbackUrl` optional in `registerTools` + the mapping upsert.
- Add `ToolRegistryService.reconcileEntityTools(entityPk, environmentId, freshNames)` — single-env signature; discovery loops it per env.
- Verify: register a mock streamable-HTTP MCP entity in a project with ≥2 `RuntimeEnvironment`s → tools appear in `PlatosToolDefinition` + a `PlatosEntityToolMapping` row **per env** and in `find_tools` (AC1); dropping a tool from the mock + re-discover prunes it in every env (AC6).

**Commit 4 — Dispatch branch in `ToolExecutorService`.**
- Add `include: { mcpClient: true }` to the entity re-verify read; insert the `connectionKind === "mcp"` branch → `mcpDispatch()` before the `serviceSecret` block (§4).
- `mcpDispatch` reuses pool + credential service; returns the standard result shape; health/audit ride the existing `execute()` wrapper. It performs the §3.2 post-substitution dispatch-boundary scan before any pool/transport call.
- **Add `endUserId?` to `ToolCallOrigin` (`:83`) and change `executeBatch(calls, scope)` → `executeBatch(calls, scope, origin?)`**, forwarding `origin` into each `execute(call, scope, origin)`. Wire the six entry points to their `endUserId` sources per the §3.1 table: turn-loop (`agent.service.ts:1764`) and skill batch (`:3877`) from `thread.platosEndUserId → externalUserId`; mcp_client (`mcp-entity.controller.ts:994`) from the token/OIDC linkage; replay (`agent.controller.ts:3842`) from the stored audit origin; durable path per §7. Add `endUserId` to the `PlatosToolCallAudit` write so replay can reconstruct it.
- Verify: live turn `find_tools`+`execute_tools` on the mock entity round-trips with the correct `user_id` (AC2); `require_approval` policy pauses via `runApprovalPause` and resumes (AC5); the fail-closed unit test — mcp tool + `{{endUserId}}` template + no end user via `executeBatch` ⇒ structured failure, zero upstream calls; **wire-entity tests unchanged/green** (AC7).

**Commit 5 — Operator surface for MCP entities.**
- Extend entity registration (controller + the `entities_*` MCP admin tools) to create a `connectionKind: "mcp"` entity + its `PlatosEntityMcpClient` and kick discovery; add a manual "refresh discovery" action; register the periodic refresh sweep (§5).
- **Wire-only column handling for the mcp kind (§1.5a):** pass `serviceSecret: "auto"` (generate-and-ignore); **relax `entities_register` `minItems: 1` on `mcpUrls` when `connectionKind === "mcp"`** (register with `mcpUrls: []`, take the endpoint as `mcpClient.url`); ensure `EntityMcpDiscoveryService` stamps `connectionStatus = "connected"` on a successful `tools/list` (and `"disconnected"` + `discoveryError` on failure) so census/list don't show every MCP entity disconnected forever.
- Route the dashboard direct-POST tool-test through `mcpDispatch`/`execute` (or reject kind-aware) per GAP-4.
- Verify: end-to-end operator flow — register Composio-style entity via API → discovery → tool-matrix populated → **`entities_list`/`entities_census` show `connected`** → bind to an agent via `linkedAgentIds` → agent turn executes (AC1+AC2); per-user check: two end users → two `user_id`s at the (mock/real) upstream, distinct pooled sessions (AC3); no-linked-user + templated tool → structured failure, zero upstream calls (AC4).

**Commit 6 — Delete Phase-1 parallel code + models.** 🔶
- Delete `McpToolExecutorService`, the CRUD/matrix half of `McpServerRegistryService`, `mcp-agent.controller.ts`, `mcp-agent.module.ts`; remove `McpAgentModule` from `app.module.ts`.
- Remove `PlatosMCPServer`, `PlatosMCPServerTool`, `PlatosAgentMCPBinding` from `schema.prisma`; keep `PlatosOrgMcpPolicy`.
- **Drop-tables migration** — the April `20260422100000_platos_mcp_tables` tables exist in prod. 🔶 **Guard:** the migration (or a pre-flight) must assert **all three** tables are empty — `SELECT count(*) FROM "PlatosMCPServer" = 0` **AND** `SELECT count(*) FROM "PlatosMCPServerTool" = 0` **AND** `SELECT count(*) FROM "PlatosAgentMCPBinding" = 0` — before dropping any of them (a child `PlatosMCPServerTool`/`PlatosAgentMCPBinding` row could exist even if the parent count looks off, and each carries data worth migrating). If **any** is non-empty (unexpected — never wired to the turn loop), run a data-migration first: per `PlatosMCPServer` row, create a `PlatosConnectedEntity(connectionKind="mcp")` + `PlatosEntityMcpClient`, map `agentId → linkedAgentIds`, carry `PlatosAgentMCPBinding`/`PlatosMCPServerTool` intent onto `linkedAgentIds`/`PlatosEntityToolMapping.enabled`, then re-discover. Ship the drop only after all three count-0 assertions pass.
- Verify: `grep -r "PlatosMCPServer\|McpServerRegistry\|McpToolExecutor\|PlatosAgentMCPBinding" apps/agent/src` ⇒ empty; full build + typecheck green; entity-tool + MCP-entity suites green.

**Commit 7 — Acceptance harness + docs.**
- Map AC1–AC7 to tests (mockable: AC1/AC4/AC5/AC6/AC7; live-Composio: AC2/AC3 — run against a real key on `test.platos`). Assert secrets never appear in logs/audit rows (AC7).
- **AC1 endpoint reword (GAP-8):** AC1 was originally phrased against `POST /api/v1/agent/mcp/servers` (the deleted `mcp-agent.controller.ts` surface). Record in the harness that this endpoint is **intentionally superseded** by entity registration (`entities_register` with `connectionKind: "mcp"` + `mcpClient`, plus the extended entity controller) — so its removal (Commit 6) is an accepted supersession, **not** a regression to flag. The harness asserts the *entity-registration* path satisfies AC1; a check for the old `/mcp/servers` route existing should be removed or inverted (assert-absent), not left as a failing probe.
- Update `docs/tool-gateway.md` and this doc's status to "implemented."
- Verify per the "fixes must be fully e2e" rule: fix→test→push→changelog→version→VPS deploy→verify the live binary on `test.platos`, then a real Composio round-trip.

---

## 7. Open items / call-outs for the implementer
- **`endUserId` provenance** on non-chat entry points (durable Trigger.dev `/internal/execute-tool`): the reconstructed `RequestScope` must carry the resolved end-user, or a `{{endUserId}}` MCP tool invoked from a durable task fails closed (correct, but note it so durable turns that need MCP thread the end-user through the HMAC payload).
- **`stdio` transport** stays deferred (dev-only, K.10) — `PlatosEntityMcpClient.transport` accepts it, discovery/dispatch throw "not implemented," MVP ships remote-http/sse + hosted-*.
- **Bare tool-name collisions** across MCP entities behave exactly as entity-tool collisions do today (per-entity matrix rows, first-match-in-scope, `entity_ids` narrowing). Composio names are already app-prefixed, so low risk; do **not** reintroduce `slug.tool` qualified names.
