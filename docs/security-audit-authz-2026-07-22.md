# Security Audit — Authorization Boundary Sweep (2026-07-22)

**Scope:** REST + MCP control-plane authorization on `apps/agent`. Target property: _no end-user or guest credential can read or mutate another user's data, or reach an operator-tier surface, within — or across — a tenant._
**Method:** multi-finder sweep, each finding independently re-verified against source by Fable (`CONFIRMED` = verified reachable in the actual code, not speculative).
**Prior context:** Phases 0–3 of the 2026-07-16 audit (`docs/security-audit-2026-07-16.md`) established the operator tier and the `requireOperator(scope)` gate. This sweep asked whether that gate is applied _consistently_. It is not.

---

## 1. Executive Summary

**The "no cross-user / cross-tenant access" property does NOT hold at the end-user↔operator boundary.** The cross-**tenant** boundary (the org/project/env scope tuple) holds in every finding — no confirmed break crosses tenants. But the operator tier introduced in Phase 1 is enforced only where a handler explicitly calls `requireOperator(scope)`, and a cluster of high-value REST + MCP surfaces omit that call. The result is a systemic instance of the audit's founding thesis: **the scope tuple is not a user boundary.** Any principal that ScopeGuard admits as `end-user` — including an *unauthenticated* public-guest token minted from `POST /api/v1/public/guest-token` (`public-guest-token.controller.ts:124`, classified `principal='end-user'` at `scope.guard.ts:434-437`) — passes ScopeGuard with a fully populated `scope`, and every handler that forgot the operator check treats it as authorized.

Two independent failure modes recur:
- **Client-trusted `allUsers` flag.** Three conversation-read handlers accept `?allUsers=true` from the query string and forward it to a service layer that _drops the per-user ownership filter_ when it is set (`conversation.service.ts:554`, `:631-641`). The flag was built for the operator dashboard; the WS twin gates it on `scope.principal === 'operator'` (`connections.gateway.ts:1073`), but the REST handlers never do. This yields full cross-user read of every other user's decrypted conversation content in the tenant.
- **Missing `requireOperator` on management surfaces.** Agent config CRUD, tool enable/execute, provider-key CRUD, monitoring trace, and MCP platform-token mint all run under ScopeGuard alone and never re-check the principal — so an end-user/guest reaches operator-only writes (rewrite a shared system prompt, invoke connected integration tools, re-point BYOK provider keys) and reads (another user's full execution trace; the whole scope's agent/provider/billing config via a self-minted all-permissions MCP token).

**Ranked exceptions (most severe first):** (1) client-controlled `allUsers` cross-user conversation read — *critical*; (2) agent-config CRUD tamper, (3) tool toggle + arbitrary tool execution, (4) monitoring/trace cross-user IDOR, (5) platform-MCP self-mint → operator control-plane — all *high*; (6) provider-key CRUD config-integrity — *medium*.

**Severity counts:** 1 critical, 5 high, 1 medium (7 confirmed findings total). Findings F1 and F6 are the *same underlying defect* (the `allUsers` passthrough on the thread routes) reported by two finders at different severities; they are kept separate below for traceability but share one fix.

**Coverage note:** This document reports only the 7 findings that survived Fable re-verification as `CONFIRMED`. REFUTED findings from the broader sweep: not surfaced to this report pass (0 documented here). NEEDS-CONTEXT findings: not surfaced to this report pass (0 documented here). Absence of a count here means the upstream triage did not hand them to this writer, not that none existed — the confirmed set should not be read as the sweep's full coverage.

---

## 2. Confirmed Findings

| # | Severity | Boundary | File:line | One-line exploit |
|---|----------|----------|-----------|------------------|
| F1 | **critical** | cross-user | `agent.controller.ts:510` (also `:298`, `:312`) | `GET /threads?allUsers=true` then `/threads/{id}/messages?allUsers=true` with a guest token → every user's decrypted conversation content in the tenant. |
| F2 | high | privilege-escalation | `agent.controller.ts:1199` | Guest/end-user token → `PATCH /agents/{id}` rewrites the shared system prompt / tools / model routes (or `DELETE`s the agent) for all users. |
| F3 | high | privilege-escalation | `agent.controller.ts:1613` | Guest/end-user token → `POST /tools/execute` fires connected integration tools with attacker args; `PATCH /tools/.../enabled` flips tools env-wide. |
| F4 | high | cross-user | `trace.service.ts:84` | `GET /monitoring/trace/{victimThreadId}` returns another user's full messages + spans + cost rollup, no ownership/operator gate. |
| F5 | high | privilege-escalation | `mcp-platform.controller.ts:654` | End-user token → `POST /mcp/platform/tokens {permissions:["*"]}` self-mints an all-permissions platform token → reads scope-wide agent/provider/billing config (and writes, when approvals unset). |
| F6 | high | cross-user | `agent.controller.ts:298` | Same defect as F1, reported at high: ungated `allUsers` on `listThreads`/`getThread`/`getMessages` drops the ownership filter. |
| F7 | medium | privilege-escalation | `providers.controller.ts:94` | End-user token → `POST/PATCH/DELETE /providers/keys` re-defaults or deletes BYOK provider-key config scope-wide (config-integrity/DoS; no secret disclosure). |

_(F1 and F6 are one bug; F1 carries the correct effective severity.)_

---

## 3. Per-Finding Detail

### F1 / F6 — Client-controlled `allUsers=true` bypasses per-user ownership on thread list/get/messages — **critical** (cross-user)
**Files:** `apps/agent/src/agent-runtime/agent.controller.ts:282-300` (listThreads), `:302-316` (getThread), `:497-512` (getMessages); `apps/agent/src/agent-runtime/conversation.service.ts:554`, `:631-641`, `:1335-1354`.

**Exploit chain (all six links verified in source):**
1. `Caddyfile.example:105` routes `/api/v1/agent*` publicly.
2. Attacker mints an `end-user` credential — either an entity session token (`POST /api/v1/entities/:id/session-tokens`, attacker-chosen `userId`) or an *unauthenticated* public-guest token (`POST /api/v1/public/guest-token`, `public-guest-token.controller.ts:124`). ScopeGuard admits both on the proxy path with `principal='end-user'` (`scope.guard.ts:374-461`, `:434-437`).
3. The PIFSP-1 agent-pin (`scope.guard.ts:379-389`, extractor regex `:524`) only fires on `/agents/:id/*` paths. The thread routes carry no `agentId` segment, so the pin is skipped — a token pinned to public agent A still passes.
4. `GET /api/v1/agent/threads?allUsers=true` → `listThreads` forwards `allUsers` verbatim (`:298`); service drops the `OR:[{userId},{createdByUserId}]` ownership clause when `allUsers` is true (`conversation.service.ts:631-641`), leaving only the org/project/env tuple → **every thread of every user** (id, title derived from other users' first message, agentId, userId, tags).
5. For each harvested `threadId`: `GET /api/v1/agent/threads/{id}/messages?allUsers=true` → `getMessages` (`:510`) delegates to `getThread` with `allUsers` (`conversation.service.ts:554` drops the same OR), then loads and **decrypts** every message row (`applyDecryption`, `:1353`) → full plaintext user+assistant+tool+thinking content of another user's private conversation. `GET /threads/{id}?allUsers=true` leaks per-thread metadata the same way.

**Why it is not caught elsewhere:** every monitoring aggregate handler in the same controller calls `requireOperator(scope)` (e.g. `:2656`, `:2843`, `:3320`), and the WS `join_thread` path gates the identical capability on `scope.principal === 'operator'` (`connections.gateway.ts:1073`). These three REST handlers are the omission. `getScope()` (`agent.controller.ts:120`) returns `req.scope` verbatim; `requireOperator` is imported (`:51`) but never called on these routes.

**Severity:** critical — reachable by an unauthenticated guest token; exposes decrypted conversations of all other end-users. Cross-user within a tenant; the org/project/env tuple still holds, so not cross-tenant.

**Recommended fix:** treat `allUsers` as an operator-only capability. In all three handlers, compute the effective flag as `allUsers === true && scope.principal === 'operator'` (mirror `connections.gateway.ts:1073`), or call `requireOperator(scope)` before honoring the flag and 403 otherwise. Do not trust the raw query param. Defense-in-depth: in `conversation.service.ts`, require an explicit `operator:true` service-level assertion (not just a boolean) before dropping the ownership OR.

---

### F2 — Agent config CRUD is not operator-gated — **high** (privilege-escalation)
**File:** `apps/agent/src/agent-runtime/agent.controller.ts:1199` (updateAgent), `:1209` (deleteAgent), `:1268` (rollback), `:1287` (setCanary), `:1329` (setFeatureFlags), `:1375` (promoteCanary), `:962` (getAgent), `:1230` (listVersions); `apps/agent/src/agent-runtime/agent-crud.service.ts:565-575`, `:612-615`.

**Exploit:** the entire agent-config/lifecycle block (`:949-1385`) uses only `getScope(req)`; the first `requireOperator` in the controller is at `:1990` (entity registration). A public-guest token pinned to agent A (`isGuest:true`, `agentId:A`) passes the agent-pin because `tokenAgentId == pathAgentId == A` (`scope.guard.ts:381`); principal stays `end-user`. `PATCH /api/v1/agent/agents/A {"systemPrompt":"…exfiltrate…","toolsBlockConfig":{…}}` (or `{"isActive":false}`, or `DELETE`) reaches `updateAgent`, which has no operator check. `AgentCrudService.update/delete/rollback` filter by (org,project,env) only (`agent-crud.service.ts:565-575`, `:612`), so the write succeeds and the rewritten prompt/tools/model-route governs **every other user's** turns on agent A. An entity-minted end-user token carrying **no** `agentId` claim skips the pin entirely (`scope.guard.ts:522-526`) and can mutate *any* agent in the scope tuple.

**Severity:** high — within-tenant; guest tokens bound to their pinned public agent, entity tokens to their scope tuple. Prompt-injection of a shared agent + destructive delete/rollback.

**Recommended fix:** add `requireOperator(scope)` at the top of every mutating and config-read handler in the `:949-1385` block (updateAgent, deleteAgent, rollbackAgentVersion, setAgentCanary, setAgentFeatureFlags, promoteAgentCanary, and the version/get reads that expose full config). The agent-pin authenticates _which_ agent a runtime token may drive; it is not an authorization tier for config management.

---

### F3 — Tool config toggle + arbitrary tool execution not operator-gated — **high** (privilege-escalation)
**File:** `apps/agent/src/agent-runtime/agent.controller.ts:1587` (setToolEnabled), `:1613` (executeTool); `apps/agent/src/agent-runtime/tool-executor.service.ts` (no principal check), `:705`; `apps/agent/src/agent-runtime/tool-registry.service.ts:365-425`.

**Exploit:** both handlers derive scope via `getScope(req)` with no `requireOperator`; neither URL contains an `/agents/` segment, so the agent-pin never fires (`scope.guard.ts:522-526`). The only global guards are `ScopeGuard + RateLimitGuard` (`app.module.ts:88`, `:90`); the controller has no `@UseGuards`. With any in-scope end-user/guest token: `POST /api/v1/agent/tools/execute {"tool":"<connected_tool>","params":{…}}` → `ToolExecutorService.execute` → `executeInner` resolves the tool via `getScopedTools(scope)` (`tool-executor.service.ts:705`) and dispatches under the entity's own `serviceSecret` HMAC — **bypassing the per-agent tool ACL** (`isVisibleToAgent` only runs when an `agentId` is passed, which this path does not). Separately, `PATCH /api/v1/agent/tools/{entityId}/{toolName}/enabled {"enabled":false}` flips a tool env-wide for all agents via `registry.setToolEnabled`.

**Severity:** high — an anonymous widget guest triggers real tenant integration side-effects (email/CRM/DB) with attacker-chosen args, and can disable/enable tools scope-wide. Intra-tenant (`getScopedTools`/`setToolEnabled` confined to the caller's tuple, `tool-registry.service.ts:365-425`).

**Recommended fix:** gate `setToolEnabled` and `executeTool` with `requireOperator(scope)` (the wire-test/tool-execute surface is an operator/dashboard capability). If a legitimate non-operator tool-invocation path is needed, route it through the agent loop where the per-agent ACL (`isVisibleToAgent`) is enforced, never through the raw executor.

---

### F4 — `monitoring/trace/:threadId` has no ownership or operator gate — **high** (cross-user)
**File:** `apps/agent/src/monitoring/trace.service.ts:84-100`, `:119-138`; `apps/agent/src/agent-runtime/agent.controller.ts:2679-2687`.

**Exploit:** `getThreadTrace` (`:2680`) calls `traceService.buildThreadTrace(scopeTuple(scope), threadId)` with no `requireOperator`; `scopeTuple()` is `{organizationId,projectId,environmentId}` only. `buildThreadTrace` loads the thread filtering on org/project/env alone — **no** `userId`/`createdByUserId` clause (`:84-90`) — then returns all `PlatosAgentMessage` rows (content, toolCalls, thinkingContent, responseJson), OTel spans, and cost rollup (`:119-138`). Any co-tenant token that knows a victim `threadId` (trivially harvested via F1's `GET /threads?allUsers=true`) reads the victim's entire conversation + execution trace. The sibling `getThreadCost` directly above (`:2660`, audit H2) was hardened to resolve through the ownership-gated `getThread()`; the trace handler was left on the scope-tuple-only path.

**Severity:** high — cross-user IDOR leaking full decrypted conversation content and trace to any in-scope token with a threadId.

**Recommended fix:** resolve the thread through the ownership-gated `conversation.service.ts getThread()` (`:538-554`) before building the trace, exactly as `getThreadCost` does; OR add `requireOperator(scope)` if the trace view is operator-only. Do not query `PlatosAgentMessage` by `threadId` alone from a scope-tuple context.

---

### F5 — Platform-MCP token mint has no operator gate → self-minted operator control-plane — **high** (privilege-escalation)
**File:** `apps/agent/src/mcp-platform/mcp-platform.controller.ts:654-684`; `apps/agent/src/.../token.service.ts:112-132`; `scope.guard.ts:206-216`; `apps/agent/src/mcp-platform/tools/providers.ts:193-218`, `index.ts:241`; `permission-gateway.service.ts:270-289`.

**Exploit:**
1. Attacker holds any entity-signed end-user session token (chat-widget/SDK visitor); ScopeGuard resolves `principal='end-user'` with scope `{org,proj,env,userId}` (`scope.guard.ts:434-437`).
2. `POST /mcp/platform/tokens` is **not** in the ScopeGuard bypass allowlist (`scope.guard.ts:206-216` bypasses only the bare protocol routes `/mcp/platform`, `/sse`, `/messages`, `/events/subscribe`), so it runs under normal session-token auth and the end-user token is accepted.
3. `mintToken` (`:654`) checks only `if (!scope) throw` (`:669`) — no `requireOperator`, no principal check (`requireOperator` is never imported anywhere in this module). `tier` normalizes to `"scope"` by default (`token.service.ts:112`), and the ADMIN OrgMember gate only fires for `tier==="admin"` (`:118`), so a `"scope"`-tier mint with `permissions:["*"]` is unrestricted. A `plt_mcp_` all-permissions token pinned to the attacker's (org,proj,env) is returned.
4. That token self-authenticates at the allowlisted `POST /mcp/platform` via `verifyAnyBearer → tokenService.verify` (`:325-354`, `:369`) and drives scope-level operator read tools that filter by the (org,proj,env) tuple only, never `userId`: `agents.list`/`agents.get` (all agent prompts/tools/config, `index.ts:241`), `providers.list_keys` (BYOK key inventory + metadata, `providers.ts:193-218`), `environments.list_secrets`, `budgets.list`, `monitoring.*`. The permission gateway auto-allows all `*.list`/`*.get` by tool tier, not caller principal (`permission-gateway.service.ts:270-289`).
5. When `MCP_INTERACTIVE_APPROVALS` is unset (default), `getRouter()` installs no approval gate (`:246-301`) and `require_approval` tools fall back to legacy auto-execute — so the same token also reaches destructive writes (`entities.regenerate_secret`, `environments.set_secret`, `providers.add_key`, `agents.delete`), widening this from a config/metadata read to full operator control-plane write within the tenant.

**Severity:** high — end-user→operator escalation across the whole scope; cross-user but intra-tenant.

**Recommended fix:** call `requireOperator(scope)` at the top of `mintToken` (`:654`) — token issuance is an operator/dashboard action, as the AUTHZ MAP §1f comment already states. Additionally, reject `permissions:["*"]` / `tier:"scope"` mints from a non-operator principal at `token.service.ts:112`, and default `MCP_INTERACTIVE_APPROVALS` to on for `require_approval` tools.

---

### F7 — Provider (BYOK) key CRUD is not operator-gated — **medium** (privilege-escalation)
**File:** `apps/agent/src/providers/providers.controller.ts:94` (createKey), `:145` (updateKey), `:182` (deleteKey), `:59-92` (listKeys); `providers.module.ts` (no UseGuards).

**Exploit:** `ProvidersController` (`@Controller('api/v1/agent/providers')`) imports no `requireOperator`; every handler uses `getScope(req)` only, and the module declares no guard beyond the global `ScopeGuard + RateLimitGuard`. An in-scope end-user/guest token can: `POST /keys {isDefault:true}` to clear the sitting default and install its own (`:105-116`); `PATCH /keys/:id` to re-point the default across other users' keys (`:157-169`); or `DELETE /keys/:id` to remove any non-pinned key (`:206`). `updateKey`/`deleteKey` locate the row by the scope tuple only — `createdBy` is stored (`:127`) but never used as a filter. This redirects which `PlatosProviderKey` agents resolve for LLM calls, breaking provider config for all users in the scope.

**Not a disclosure hole:** `listKeys` selects only metadata + an `envVarSet` boolean (`:69-90`); keys store an `envVarName` pointer, not secret material.

**Severity:** medium — config-integrity/DoS, no key disclosure. The sibling `FilesController` gates every cross-user management handler with `requireOperator(scope)` (`files.controller.ts:45,106,160,217`, "audit H10"), proving the intended norm.

**Recommended fix:** add `requireOperator(scope)` to `createKey`, `updateKey`, `deleteKey` (and `listKeys`), mirroring `FilesController`.

---

## 4. Coverage

### Dimensions audited
1. **Conversation read (REST):** `listThreads` / `getThread` / `getMessages` — **broken** (F1/F6).
2. **Conversation read (monitoring):** `monitoring/trace/:threadId` — **broken** (F4); `getThreadCost` sibling verified hardened (H2).
3. **Agent config lifecycle:** update/delete/rollback/canary/flags/promote/get/versions — **broken** (F2).
4. **Tool control-plane:** enable-toggle + arbitrary execute — **broken** (F3).
5. **Provider/BYOK config:** key create/update/delete/list — **broken** (F7); `FilesController` verified correctly gated (reference norm).
6. **MCP platform token issuance + control-plane:** `POST /mcp/platform/tokens` + downstream scope-level tools — **broken** (F5).

Cross-cutting: **cross-tenant boundary (org/project/env tuple) held in all 7** — no confirmed break escapes the tenant. Every break is the end-user↔operator (intra-tenant) boundary.

### ScopeGuard bypass allowlist (verified)
`scope.guard.ts:206-216` bypasses session-token auth for exactly these bare MCP/protocol routes:
- `/mcp/platform`
- `/sse`
- `/messages`
- `/events/subscribe`

**`POST /mcp/platform/tokens` is NOT allowlisted** — it runs under normal session-token auth, which is precisely why an end-user token reaches `mintToken` (F5). Guest/entity classification: `isGuest` and entity-signed tokens → `principal='end-user'` at `scope.guard.ts:434-437`; the guard returns `true` (admits) and defers the tier decision to each handler's `requireOperator` call — so any handler missing that call is open. The PIFSP-1 agent-pin (`scope.guard.ts:379-389`, extractor `:524`) fires only on `/agents/:id/*` paths and is therefore irrelevant to the `/threads*`, `/tools/execute`, `/monitoring/*`, `/providers/*`, and `/mcp/platform/tokens` surfaces.

---

## 5. Fix Priority

1. **F1/F6 (critical) — first.** Unauthenticated-guest-reachable, leaks decrypted cross-user conversations. Gate `allUsers` on `scope.principal === 'operator'` in all three thread handlers (mirror `connections.gateway.ts:1073`). One change, highest blast radius.
2. **F5 (high) — self-mint escalation.** `requireOperator(scope)` on `mintToken`; reject `["*"]`/`scope`-tier from non-operators. Closes the whole-scope config/secret-metadata read (and, with default approvals off, writes).
3. **F2 (high) — shared-agent tamper.** `requireOperator` across the `:949-1385` config block. Prevents prompt-injection of shared agents + destructive delete.
4. **F3 (high) — tool execute/toggle.** `requireOperator` on `executeTool` + `setToolEnabled`; real integration side-effects.
5. **F4 (high) — trace IDOR.** Route through ownership-gated `getThread()` or `requireOperator`.
6. **F7 (medium) — provider-key CRUD.** `requireOperator`, mirroring `FilesController`.

**Common root cause / systemic fix:** the operator tier is opt-in per handler (`requireOperator` must be remembered) rather than default-deny. Consider a controller/route-level operator guard (or a `@RequiresOperator()` decorator enforced by a guard) on all management surfaces, so a forgotten check fails closed instead of open. Each of the 7 findings is one missing line against that norm.
