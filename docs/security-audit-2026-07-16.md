Both critical claims verify. `verifyAnyBearer` builds the `VerifiedToken` purely from `oa.scope`/`oa.scopes` and never inspects `oa.entityPk` (lines 291-310) — and `mcp:write` maps to `["*"]` with `tier: "scope"`. `internalDurableTurn` gates only on `verifyAdminToken` then passes `body.scope` verbatim into `executeStreamingTurn` (lines 3788-3803) with no HMAC over the body and no binding of scope to the caller. All load-bearing findings confirmed against source. Now writing the report.

# Platos Production-Hardening Security Report
**Target:** make `play.platos.dev` safe for real multi-tenant production (winsen.ai pilots)
**Date:** 2026-07-16 · **Scope reviewed:** agent runtime (`apps/agent`), auth/scope, WS/SSE streaming, MCP gateway, memory/KG/RAG, durable-exec callbacks, budgets/approvals, webapp secrets

---

## 1. Executive Summary

**Verdict: `play.platos.dev` is NOT safe for real multi-tenant production today.** It is safe under exactly one assumption — that **every principal inside a single `(organizationId, projectId, environmentId)` tuple is a mutually-trusting operator**. That assumption is precisely what the winsen.ai pilot / embedded-widget / Percy AI-employee direction breaks: many *untrusted end-users* (and anonymous public-guest tokens) share one scope tuple. The moment that happens, the codebase has cross-user AND cross-tenant breaks that expose message content, PII, spend, BYOK-backed execution, and secret-signing keys.

The root cause is architectural and singular: **Platos has a correct *edge* posture (scope derived from a verified token, raw scope headers rejected behind the proxy) but treats the scope tuple as if it were a user boundary. It is not.** There is (a) **no operator/end-user tier** — an entity-minted or public-guest session token is indistinguishable from a webapp operator token at every handler; (b) **no per-user partition** in the realtime layer — every socket joins a tenant-wide `scope:` room; and (c) **no structural enforcement** — scope filtering is per-handler convention, so any forgotten `where` is a live IDOR, and the cross-scope regression suite is `it.skip` scaffolding.

**Top blockers (must fix before any real pilot):**

| # | Blocker | Class |
|---|---------|-------|
| B1 | **End-user token can rotate an entity's serviceSecret and receive the plaintext** → the HMAC signing key → mint tokens for *any* user. Full auth-model collapse. (`agent.controller.ts:1947`) | Critical — verified |
| B2 | **Durable-exec internal callbacks trust `body.scope` verbatim behind one shared static admin token** → cross-tenant turn execution under victim BYOK keys/memory. (`agent.controller.ts:3769`) | Critical — verified |
| B3 | **Entity anonymous OAuth flow mints `mcp:write` → `["*"]` scope-tier platform token, entityPk never checked** → org/project-wide read+write from an embedded chatbot visitor. (`mcp-platform.controller.ts:291`) | Critical — verified |
| B4 | **Platform-MCP `trigger.tasks.trigger` forwards attacker `payload.scope` verbatim to the shared Trigger project** → cross-org escalation past the "within minting org" admin boundary. (`mcp-platform/tools/trigger.ts:200`) | Critical |
| B5 | **No operator tier across the whole monitoring/memory/files/budget surface** → any in-scope token reads other users' messages, memories, PII, spend, and file bytes, and mutates budget caps. | High (structural) |
| B6 | **Scope-room realtime broadcast** leaks approvals (tool args), run output, thread titles, and userId↔agent maps to every user in the tenant; **`join_thread` is scope- but not user-gated** → live token-stream hijack. | High |

None of these are cross-org *by default* except B1/B2/B3/B4 and the two unscoped-Redis-key reads (thread cost, thread spans). Everything else is cross-*user within a tenant* — which is the exact isolation a shared pilot instance needs.

**Bottom line for the pilot:** if winsen.ai onboards two customers into two *separate* `(org, project, env)` tuples AND you fix B1–B4 (the cross-org escalations) AND you never expose the memory/monitoring REST surface publicly, you can run a **single-user-per-tenant** pilot relatively safely. To run **multiple end-users under one tenant** (the widget/AI-employee model), you must additionally land the operator tier (B5) and the realtime room redesign (B6). Do not put real customer PII on it before that.

---

## 2. Findings — ranked by severity

Each finding names the best-practice pattern the fix applies (from the LangGraph / Vercel AI SDK / Trigger.dev / OWASP / realtime-rooms research).

### CRITICAL

---

**C1 — End-user session token can rotate an entity's serviceSecret and receive the new plaintext (full auth-model escalation)**
`apps/agent/src/agent-runtime/agent.controller.ts:1947-1970` → `auth.service.ts:664-680`
**Verified in source.** `regenerateEntitySecret` gates *only* on `getScope(req)` (line 1952), which returns `req.scope` verbatim with no role/operator check. `ScopeGuard` populates `req.scope` identically for an `iss:'entity'` end-user token and an `iss:'platos-platform'` operator token, and the agent-pin only fires on `/agents/:id/*` paths (this path has no agentId). `regenerateServiceSecret` returns the new plaintext, spread into the 200 body at line 1969. Because the entity `serviceSecret` **is** the HMAC key that `validateSessionToken`/`createSessionToken` sign with, and the mint endpoint accepts an attacker-chosen `userId`, any entity-minted token obtains the signing key and can mint tokens for **arbitrary users** → read/write every user's threads/messages/memories in that scope. Also DoS-disconnects the victim entity's live WS.
**Fix (OWASP API5 BFLA — deny-by-default, centralized function-level authz):** introduce a single `requireOperator(req)` that throws 403 unless `req.scope` came from an `iss==='platos-platform'` token. Surface `iss` onto `req.scope` in `scope.guard.ts` (~line 326-338). Call `requireOperator` at the top of `regenerateEntitySecret`, `registerEntity`, `patchEntity`, `getEntityTestCredentials`, `setTestCredentials`. Never return the rotated secret in a call an untrusted client can trigger — but the operator gate is the load-bearing fix.

---

**C2 — Durable-exec internal callbacks trust `body.scope` verbatim behind one shared static admin token (cross-tenant impersonation)**
`apps/agent/src/agent-runtime/agent.controller.ts:3769-3841` (+ `3856`, `3914`, `3967`, `3683`); gate `scope.guard.ts:254-284`
**Verified in source.** `internalDurableTurn` checks only `verifyAdminToken(req)` (line 3789), then passes `body.scope` straight into `executeStreamingTurn` (line 3803), which resolves the BYOK provider key, thread, memory, and persistence all **under the supplied scope**. Nothing binds `body.scope` to the caller — no HMAC over the body, no check that `agentId`/`threadId` belong to the scope. The sibling `/internal/execute-tool` callback HMAC-signs the *whole* body with `TRIGGER_INTERNAL_SECRET` (so scope can't be swapped); these newer durable callbacks regressed to bearer-only. Caddy routes `/api/v1/agent*` publicly and passes the admin-token header through. Combined with B4/C3, an attacker enqueues `platos.agent.employee-run` with a foreign `payload.scope` and runs a turn *as another org* under their BYOK key.
**Fix (Trigger.dev — the mint step is the only trust boundary; OWASP API1 — re-derive, never trust client id):** require `X-Platos-Signature = HMAC-SHA256(TRIGGER_INTERNAL_SECRET, body+timestamp)` on all five durable callbacks (`internalDurableTurn`, employee-run, skill-run, batch-turn, compaction), reusing `verifySignature` from `internal-execute-tool.controller.ts`, so `body.scope` is covered by the signature. Additionally cross-check inside each handler that `body.agentId`/`body.threadId` belong to `body.scope` via a scoped `findFirst`, failing closed on mismatch.

---

**C3 — Entity OAuth token bypasses the platform-MCP entityPk pin; `mcp:write` → `["*"]` scope-tier grant**
`apps/agent/src/mcp-platform/mcp-platform.controller.ts:291-311` (`verifyAnyBearer`); mint flow `oauth.controller.ts:796-883`
**Verified in source.** `verifyAnyBearer` builds a `VerifiedToken` purely from `oa.scope` + `oa.scopes` and **never inspects `oa.entityPk`** (lines 291-310), while the per-entity surface *does* reject foreign entityPk. The anonymous entity OAuth flow mints a `plt_oa_*` token with scopes taken verbatim from attacker-controlled `body.scope` (`oauth.controller.ts:875`, no server-side clamp). Requesting `scope=mcp:write` maps to `permissions:["*"]`, `tier:"scope"` (line 295-296, 308) → passes `allows()` for every non-admin-tier platform tool (`agents.create/update/delete`, `threads.delete`, `providers.add_key`, `entities.regenerate_secret`, `memories.upsert`, `messages.list`) against the entity's org/project. (Note: the first-pass `mcp:tools`→broad-read claim is *false* — that permission mapping is dead due to leading-wildcard/underscore mismatches; the real escalation is `mcp:write`.)
**Fix (OWASP API1 — least privilege at the mint step; Trigger.dev — resource-pinned scopes minted by trusted backend, never client-declared):** (a) in `verifyAnyBearer`, reject OAuth tokens carrying an `entityPk`: `if (oa.entityPk) return null;` — mirror the per-entity pin, inverted. (b) Clamp entity-flow scopes to the entity's advertised set (`mcp:tools`) at `issueAuthCode` time so `mcp:write` can never be minted for an entity client. (c) Fix the dead read-permission mapping (`platos.whoami` with dots; implement leading-wildcard matching or enumerate concrete read tool names) so legit `mcp:read` tokens aren't silently useless.

---

**C4 — Platform-MCP `trigger.tasks.trigger` forwards attacker-controlled `payload.scope` to the shared Trigger project**
`apps/agent/src/mcp-platform/tools/trigger.ts:200-228`
`tasks.trigger` accepts `payload:{type:'object'}` with no shape/allowlist and forwards `params.payload` verbatim via the single admin-level `PLATOS_TRIGGER_API_KEY`. The MCP token's org is never applied to the payload. The gate is `requiresAdminTier` — but admin-tier is "cross-scope **within the minting org**", not a platform superuser. In the default deploy (`MCP_INTERACTIVE_APPROVALS=false`) the `require_approval` auto-escalation is a no-op. The worker forwards `payload.scope` verbatim to the internal callback (C2), so an org-A admin enqueues a `platos.*` task with `payload.scope` = org B and the callback runs as org B.
**Fix (OWASP API1 — re-derive scope server-side; Microsoft/OpenAI multitenancy — tenant-scoped keys, never client-supplied):** in `tasks.trigger.execute`, for any `platos.*` task whose payload carries a `scope`, **overwrite** `payload.scope.{org,project,env}` with the MCP token's own verified scope (`buildScope(token)`) rather than trusting the caller's payload. Combine with C2's HMAC+ownership check so even a mis-scoped enqueue fails at the callback.

---

### HIGH

---

**H1 — No operator tier: entire monitoring / activity / cost / audit read surface is reachable by any in-scope end-user token**
`apps/agent/src/agent-runtime/agent.controller.ts:2741, 2761, 2979, 3079-3326, 3472, 3489, 3509, 3631, 4289, 4330`
`monitoringUserDetail`/`monitoringUserSummary`/`monitoringUserConsumption` take a `:userId` path param, query threads/memories/safety-events/PII/email filtered on the scope tuple only, and (summary) feed a victim's data to an LLM to produce a prose dossier. `costByUser`, `monitoringBreaches`, `topUsers`, `toolAudit`, `recentActivity`, `safety-events` (with `?userId=` filter) — all gated only by `getScope`. `/api/v1/agent*` is publicly proxied. **This is the structural root under H1–H7.**
**Fix (OWASP API5 — one centralized deny-by-default RBAC module; LangGraph `disable_studio_auth` lesson — no dev-convenience default-allow on a shared prod instance):** apply `requireOperator(req)` (from C1) to the entire `/monitoring/*`, `/activity/*`, `/monitoring/tool-audit`, `/monitoring/approvals`, `/monitoring/safety-events`, `/monitoring/users/*` family. Add a `cross-scope-isolation.test.ts` case asserting an `iss:'entity'` token gets 403 on these routes.

---

**H2 — `monitoring/cost/thread/:threadId` has NO scope binding — cross-*tenant* IDOR**
`apps/agent/src/agent-runtime/agent.controller.ts:2576-2579` → `cost.service.ts:1223-1230`
**Verified in source.** `getThreadCost(@Param threadId)` takes no `@Req()`, never reads `req.scope`, and calls `costService.getThreadCost(threadId)` which does `redis.hgetall('cost:thread:'+threadId)` — key namespaced by `threadId` only, **zero scope filter**. Crosses the org/project/env boundary entirely (worse than in-scope findings). The very next handler `getThreadTrace` 404s on cross-scope — proving this is an omission, not a pattern.
**Fix (OWASP API1 — check ownership in every function that takes a client id):** add `@Req() req`, resolve the thread via a scoped `findFirst` (or `conversationService.getThread(threadId, scope)`), 404 on miss — mirror `getThreadTrace:2587`. Longer term namespace the Redis key with the scope tuple.

---

**H3 — `join_thread` is scope-gated but NOT user-gated → same-scope live token-stream hijack**
`apps/agent/src/connections/connections.gateway.ts:944-965`
**Verified in source.** The `findFirst` filters `id + org + project + env` only (lines 944-950) — it omits the `{ userId OR createdByUserId }` ownership clause that `getThread` and the dispatch-path `getOrCreateThread` both enforce. So any same-scope socket that knows a victim `threadId` joins `thread:<id>` and receives every `agent_event` streamed in — live tokens, tool_results, batch output PII. `threadId`s are handed out via the scope-room `overview.turn.completed`/`thread.title.generated` broadcasts (H4), so no guessing is needed.
**Fix (Vercel AI SDK — re-resolve ownership server-side, 404-not-403; LangGraph `@auth.on.threads.read` filter):** replace the bare `prisma.findFirst` with `conversationService.getThread(data.threadId, scope)` (which ORs `userId`/`createdByUserId` under the scope tuple) and join only if non-null. Return the indistinguishable "thread not found".

---

**H4 — Scope-room broadcast leaks approvals (tool args), run output/PII, thread titles, and userId↔agent maps to every user in the tenant**
`apps/agent/src/connections/connections.gateway.ts:134-166, 285` · `trigger-bridge/runs-bridge.service.ts:124-140` · `agent-task.service.ts:1308-1323, 1635-1651`
Every socket joins `scope:{org}:{project}:{env}` unconditionally on connect (line 285). Into that tenant-wide room the code emits: `approval_needed` with `action`+`details` (tool name + arguments, often PII) + `requestedBy` (134-155); `run_update` carrying `snap.output` + `metadata.progress` (per-item batch LLM output — SDR contact content) via `RunsBridge` (runs-bridge:140); `thread.title.generated` (LLM-derived from the user's message content) and `overview.turn.completed` `{agentId, threadId, userId}` (thread ids + who-talks-to-which-agent). This is a passive cross-user realtime bus.
**Fix (realtime-rooms — room key must be at least as narrow as the smallest authorized audience; Pusher private-channel discipline):** see §3 redesign. Deliver content-bearing `run_update`/approvals/titles only to `thread:{threadId}` and per-user rooms; the scope room, if kept at all, carries redacted status-only frames and is operator-role-gated.

---

**H5 — Cross-user approval resolution (BOLA) over both WS and REST**
`connections.gateway.ts:986-1034` · `agent.controller.ts:770-800` · `approvals.service.ts:199-230, 292-302`
Both resolve paths gate only on `getById(scopeTuple, approvalId)` — filtered by the scope tuple, never by `requestedBy` or thread ownership. The `PlatosAgentApproval` row *carries* `requestedBy` and `threadId` but neither is compared at resolve time. The `approvalId` is reachable because `approval_needed` is fanned to the whole scope room (H4). So any same-scope user (including anonymous public-guest) can **approve** another user's destructive gated tool call, or **reject** to DoS every other user's gated actions.
**Fix (OWASP API1 — ownership check by id):** after `getById`, reject unless `found.requestedBy === scope.userId` (or thread-ownership resolves), returning 404-equivalent. Add `requestedBy` to the `resolve()` `updateMany` where-clause as defense-in-depth. Operators resolving on behalf of end-users go through an explicit `requireOperator` branch. Also verify `parsed.respondedBy` in the agent's BLPOP-wake path before treating the wake as authoritative.

---

**H6 — WS streaming never enforces the token's pinned `agentId`; client-controlled `data.agentId` drives any agent in scope**
`apps/agent/src/connections/connections.gateway.ts:370, 439`
`handleConnection` validates the session token but never copies `payload.agentId` into scope; `handleMessage` derives the agent from client-supplied `data.agentId` as top priority and stamps it into scope with no comparison to any pinned agentId. `agent.service.ts` loads the agent scoped by `(org,project,env)` only — no visibility gate. Contrast the HTTP path where `ScopeGuard` enforces `tokenAgentId !== pathAgentId → 403`. So a **public-guest token pinned to public agent A can run a turn against private agent B** (B's prompt, tools, memory, BYOK keys).
**Fix (LangGraph — capability must be re-checked, not trusted from the wire):** capture `pinnedAgentId = payload.agentId` onto the socket at connect; in `handleMessage`/`handleJoinThread`/durable path, after resolving `agentId`, enforce `if (pinnedAgentId && agentId !== pinnedAgentId) reject` — mirroring `scope.guard.ts:300-308`.

---

**H7 — REST `/api/v1/memory/*` honors client `?userId=` (read) and `body.userId` (write) → cross-user memory read/export + poisoning**
`apps/agent/src/memory/memory.controller.ts:85 (write, verified), 154, 569, 596, 632, 671, 705`
**Write verified in source** (`userId: body.userId || scope.userId`, line 85). Reads compute `userId || scope.userId` on list/search/export/graph. Export forces `includeArchived:true` → full DSAR of another user's private+archived memories + KG. Writes let an attacker attribute a memory (surfaced into the agent's system-prompt memory block) to a victim → cross-user prompt injection. `relate` (705) forges a consistent victim `userId` across both endpoints, defeating the `createRelationship` cross-user guard.
**Reachability caveat (needs-human on the read/write DSAR, per verification):** the reference `Caddyfile.example` proxies only `/api/v1/agent*` and `/mcp/*`; `/api/v1/memory*` falls through to the webapp. So through the *documented* public proxy these are **not** externally reachable — but they are on the internal docker network and in any self-host that routes `/api/v1/*` to the agent (which `scope.guard.ts:271-275` explicitly anticipates for the SDK).
**Fix (LangGraph `@auth.on.store` — validate namespace against identity, don't construct from client input; OWASP API3 mass-assignment):** for non-operator tokens, force `userId = scope.userId` and ignore the query/body param on list/search/export/graph and on create/relate/update writes. Only honor an explicit `userId` for operator-tier tokens. Mirror `importBundle`'s already-correct behavior (it pins `scope.userId`). Do NOT add `/api/v1/memory*` to the public Caddyfile.

---

**H8 — Turn-time RAG runs as `userId='default'` → RAG corpus pooled cross-user per scope**
`apps/agent/src/agent-runtime/agent.service.ts:4897, 5116, 6157, 6231` · `skill-handlers.ts:223-229` · `skill-runtime.service.ts:140-234`
All four `skillRuntime.invokeTool()` call sites pass a bare 3-tuple with **no `userId`** (the `ScopeTuple` type doesn't carry it). `context` (agentId/threadId) is used only for cost accounting and never reaches the handler scope. So `ragResolveUserId` reads `undefined` and returns the literal `'default'` — every real user's RAG ingest/retrieve runs under one shared bucket at `visibility:'agent_visible'`. User A's ingested private doc is retrievable by User B's agent in the same scope.
**Fix (LangGraph `@auth.on.store` — namespace pinned to authenticated identity, fail closed on missing identity):** widen the tuple passed to `invokeTool` at all four sites to include `userId: scope.userId`; make `SkillRuntimeService` merge the acting userId into the scope it hands to `dispatch`. Retire the silent `'default'` fallback for authenticated turns — throw/refuse when `userId` is absent so a missing identity fails closed rather than pooling.

---

**H9 — `kg.get_entity` / REST graph relationships read is userId-blind (cross-user KG PII leak)**
`apps/agent/src/memory/knowledge-graph.service.ts:193-204, 211-255`
`getEntityById` filters on `(org, project, env)` only — no `userId` — while every other KG read requires it. `getRelationships` hydrates counterpart entities (full names, aliases, decrypted metadata) scope-only. Reachable via (a) the `kg.get_entity` MCP tool (takes only `{entityId}`, not tier-gated) and (b) REST `GET /graph/entities/:id/relationships` (ScopeGuard-only). Any in-scope token reads another user's entity + full relationship neighborhood by supplying their `entityId` (which appear in export bundles/audit results).
**Fix (OWASP API1):** thread `userId` through `getEntityById(scope, id, userId)` and `getRelationships`, add it to both WHERE clauses. `kg.get_entity` must take a required `userId`; REST must resolve `userId` from `scope.userId` only.

---

**H10 — Files browser returns presigned S3 download URLs for any user's thread attachments (cross-user file exfiltration)**
`apps/agent/src/files/files.controller.ts:204-282`
`listAttachments` filters by scope tuple + client `threadId` with no `userId` check, then mints 5-minute presigned GETs for every attachment. The agent-pin regex doesn't match `/api/v1/agent/files/*`, and the agent enforces no operator/membership tier. Any entity/guest token in scope enumerates + downloads other users' file bytes. **`/api/v1/agent/files/*` IS publicly proxied.**
**Fix (OWASP API1 + API5):** gate `/files/*` on `requireOperator`, and for Level-4 verify the thread's `userId` matches the caller unless operator-tier.

---

**H11 — External MCP + entity-callback fetches follow redirects without re-validation (blind SSRF → cloud metadata)**
`apps/agent/src/mcp-agent/mcp-tool-executor.service.ts:192-210` · `server-registry.service.ts:232-250` · `tool-executor.service.ts:955-999`
All three call `validatePublicUrl(url)` then bare `fetch(url, …)` with default `redirect:'follow'` — only the *initial* URL is validated. A registered server/callback that passes the check can `302 → http://169.254.169.254/…` and the agent chases it server-side. The entity-callback path additionally forwards the signed `X-Platos-*` scope headers + user token to the redirect target. The repo already ships `fetchWithValidatedRedirects` (used correctly in `skills/*`) but not here.
**Fix:** replace the three bare `fetch(url,…)` with `fetchWithValidatedRedirects(url, 3, {…})`. Pin the resolved IP to close the DNS-rebind TOCTOU. Only send privileged headers to the validated final hop.

---

**H12 — Per-tool MCP ACL (`minIdentityMode`/`allowedPatIds`) is never enforced on entity-MCP dispatch**
`apps/agent/src/mcp-platform/mcp-entity.controller.ts:730-802` · `mcp-tool-acl.service.ts:155-174`
`handleToolsCall`/`handleToolsList` enforce only the coarse entity-wide `toolAllowlist`. `McpToolAclService.filterByIdentity` has **zero call sites** on any dispatch path. Worse, `authenticate()` builds a token with no `identityMode` field, so there's nothing to filter on. An operator who sets a tool to `minIdentityMode:'oidc'` gets zero enforcement — any bearer PAT valid for the entity calls every exposed tool.
**Fix:** thread `identityMode`/`scopes` through `authenticate()`; in `handleToolsCall`, after the allowlist check, load the ACL row and call `toolAclService.filterByIdentity([aclRow], caller)`, reject on `PERMISSION_DENIED`; mirror in `handleToolsList` to hide restricted tools.

---

**H13 — `stop` handler AbortController key never matches → stop is a silent no-op (LLM keeps streaming + billing)**
`apps/agent/src/connections/connections.gateway.ts:1096-1112` vs set at `401/403`
**Verified in source.** `handleMessage` stores the controller under `ackey = …:${tid}:${replyToMessageId ?? 'main'}` (line 401). `handleStop` reconstructs `…:${data.threadId}` — **without the trailing `:${replyToMessageId}` segment** (line 1105). The keys can never match, so `activeStreams.get(key)` is always `undefined`, `abort()` never runs, yet the client is emitted a fabricated `{done, stopped:true}`. The UI shows "done" while the model streams to completion and keeps accruing cost with no WS way to halt it. Re-breaks the exact EOBD.26 behavior the comment claims to fix.
**Fix (Vercel AI SDK — stream-owner store keyed correctly; reconnect/stop re-checks owner):** reconstruct the exact key (`accept replyToMessageId in the stop payload`), or iterate `activeStreams` keys with prefix `…:${threadId}:` and abort matches. Add `scope.userId` into `ackey` so one user's stop can't abort a co-tenant's turn. Only emit `done` if a controller was actually aborted.

---

**H14 — Webapp accepts `.env.example` / weak session + magic-link secrets in production**
`apps/webapp/app/env.server.ts:107-108, 469, 1541-1596`
`SESSION_SECRET` and `MAGIC_LINK_SECRET` are bare `z.string()` (no `.min()`, no sentinel); `PLATOS_SESSION_SECRET` is `.optional()`. The only prod boot guard validates MinIO keys, never the signing secrets. `.env.example` ships `SESSION_SECRET=abcdef1234-replace-with-real-secret`; docker-compose's `${SESSION_SECRET:?required}` rejects only *empty*, not the copied placeholder. These sign the login cookie (also the API JWT secret) and magic-link tokens. A self-hoster who copies `.env.example` boots a prod webapp whose login keys are the repo's public placeholder → forge a session cookie / magic link for any user. The agent side already guards `PLATOS_SESSION_SECRET` with `.min(16)` + a prod sentinel refusal; the webapp — the actual minter — has neither.
**Fix:** add `.min(16)` to both, and mirror the agent's `superRefine`: in the existing `NODE_ENV==='production'` block (line 1541), throw if any signing secret equals a known placeholder or is under the minimum.

---

**H15 — Global `PlatosToolDefinition.name` uniqueness lets one tenant overwrite another's shared tool row + poison BM25 ranking**
`apps/agent/src/tool-gateway/tool-registry.service.ts:231-264` · `schema.prisma:3674`
`name` is globally `@unique`. `registerTools` does `findUnique({where:{name}})` with no scope filter; on `schemaHash` mismatch it overwrites `description/paramSchema/bm25Tokens` and re-indexes the shared `toolId` in the process-wide BM25 index. Org B collides on a common name (`search`, `send_email`) and rewrites the shared row → immediately poisons Org A's BM25 `find_tools` *ranking*, and after any `rebuildIndex()` (boot/bulk op) Org A's cache repopulates from the DB row → inherits Org B's schema+description. Also a self-inflicted DoS (two tenants flap the shared `schemaHash` on reconnect).
**Fix (OWASP — tenant identity is structural, not a global key):** change to `@@unique([organizationId, projectId, name])`, scope the `registerTools` lookup to `findFirst({name, org, project})`. Short-term minimum: key the BM25 index by `(scopePrefix + toolId)` and stop overwriting a row that belongs to a different scope.

---

**H16 — Budget-cap CRUD reachable by any end-user token (financial DoS / cap bypass)**
`apps/agent/src/agent-runtime/agent.controller.ts:4481-4573`
`upsertBudget`/`deleteBudget`/`overrideBudget` sit behind only ScopeGuard — zero role checks — while ~9 sibling endpoints in the *same controller* correctly gate on a timing-safe `PLATOS_ADMIN_TOKEN`. `capId`s come from the equally-unrestricted `GET /budgets`. An end-user (or anonymous public-guest, for those scopes) can `DELETE` the org spend cap, `override` to suspend enforcement, or set a huge `limitCents`, then drive unbounded spend against the operator's BYOK keys. `override` even records the attacker as the authorizer.
**Fix (OWASP API5):** gate the three mutations (and ideally `GET /budgets`) behind the operator tier — reuse the `PLATOS_ADMIN_TOKEN` check already in this file, or `requireOperator`.

---

### MEDIUM

- **M1 — `TRIGGER_INTERNAL_SECRET` defaults to a hardcoded public literal** (`internal-execute-tool.controller.ts:32`, `const … || "dev-internal-secret-change-me"`). No boot guard (`shared/env.ts:136` optional). A self-host that forgets it exposes forgeable HMAC on `/internal/execute-tool` and `/internal/batch-turn`. **Fix:** read via validated env, crash at boot if unset/default in production.
- **M2 — Entity session-token mint spreads `body.claims` LAST** (`session-token.controller.ts:112-124`), enabling conditional cross-org mint when an `entityId` slug collides across orgs (common slugs: `main`, `default`, `widget`), and trivially defeats the agent pin in-org. **Fix:** whitelist `body.claims`, merge *before* the typed fields, drop reserved keys — mirror the safe ordering already in `createPlatformSessionToken`.
- **M3 — OAuth entity access/refresh tokens encrypted with the *message-body* key and fail open to plaintext** (`oauth.controller.ts:1442-1495`). Violates the three-key separation; `PLATOS_MESSAGE_ENCRYPTION_KEY` is `.optional()` so common configs persist OAuth refresh tokens in plaintext. **Fix:** route through `SecretsService` (`PLATOS_ENCRYPTION_KEY`, fail-closed in prod); remove the plaintext fallback.
- **M4 — Entity `serviceSecret` stored plaintext despite schema comment "// encrypted"** (`schema.prisma:3583`; used raw as HMAC key at `auth.service.ts:203,226,324,336`). Any DB read yields the token-signing key. **Fix:** encrypt at rest via `SecretsService`; add a separate `sha256` lookup column for the plaintext-equality match in `tool-sync-ws.service.ts:202`. At minimum fix the misleading comment.
- **M5 — Entity WS `tool_result`/`tool_error` matched by `callId` across a global pending map with no responder-entity binding** (`tool-sync-ws.service.ts:38-45, 477-528`). A connected entity supplying a matching (leaked) `callId` can inject a forged result / abort another tenant's call. **Fix:** record `{entityId, environmentId}` on `PendingCall`, reject frames from a non-matching connection.
- **M6 — `thread:lifecycle`/`overview:event` broadcast message-derived titles + userId↔agent maps to the scope room** (`connections.gateway.ts:156-166`). Folds into §3. **Fix:** deliver to `thread:{id}` + per-user rooms only.
- **M7 — Approval resolution + entity registration by end-user tokens** (`agent.controller.ts:770-871, 1902-1945`) — cross-user approve/reject and durable minting-authority foothold. **Fix:** operator gate. (Same root as C1/H5.)
- **M8 — Admin-supplied PII `customRegex` compiled + run against every message with no ReDoS guard** (`pii-filter.service.ts:122-137`). Catastrophic backtracking pins the single-threaded event loop → multi-tenant stall. **Fix:** RE2/`safe-regex`, bound input length + wall-clock.

### LOW / INFO

- **L1** — `handleMessage` unscoped thread→agentId lookup (`connections.gateway.ts:371-384`): agentId oracle + telemetry mislabel; content re-gated downstream. **Fix:** add scope tuple to the `findFirst`.
- **L2** — `executeInner` re-loads entity `serviceSecret` via `findUnique(entityPk)` with no scope re-verify (`tool-executor.service.ts:732-749`). Cache boundary holds today; defense-in-depth. **Fix:** `findFirst` with scope tuple.
- **L3** — `MemoryService.list()` `agentIds` branch references an unbound SQL placeholder (`memory.service.ts:551-560` vs `832-837`) → clustered `list_memories` throws, **fails closed** (empty result). **Fix:** push `input.agentIds` in `buildListArgs`.
- **L4** — Redis keys unscoped: `chatsess:cursor:<threadId>` (gateway:699), Trigger idempotency `turn-<threadId>-<clientMessageId>` (gateway:890). Cuid collision only; defense-in-depth. **Fix:** prefix with scope tuple.
- **L5** — RAG ingest + bundle import write `agentId=NULL` (`skill-handlers.ts:377-391`, `memory.controller.ts:294-309`) → cross-agent visibility asymmetry. **Fix:** stamp `agentId` once H8 threads it through.
- **L6 (info)** — KG rows have no `agentId` column (`schema.prisma:4657-4728`) — latent cross-agent leak the moment any turn-time KG recall is wired. **Fix:** add nullable `agentId` before wiring KG-in-prompt.
- **L7 (needs-human)** — Run-inspection meta-tools (`get_run_details`/`replay_run`, `agent.service.ts:3157+`) take an unscoped `runId` on the shared Trigger project. Default-OFF + long random ids. **Fix:** tag runs with scope metadata, verify on retrieve; or per-scope Trigger projects.
- **L8 (needs-human)** — Global 15MB body limit applies to unauthenticated bypass routes (`main.ts:144`) → memory-amplification DoS. **Fix:** per-route 256KB cap on `/api/v1/public/*`, `/mcp*`, `/oauth/*`; keep 15MB only on catalog ingest. Code-vs-Caddy is an ops call.

---

## 3. Realtime Room-Topology Redesign

**The core defect:** every socket joins one tenant-wide `scope:{org}:{project}:{env}` room at connect (`connections.gateway.ts:285`), and sensitive events (approvals with tool args, run output, thread titles, activity metadata) are broadcast to it. A Socket.IO room has **no inherent privacy** — its safety is 100% the join-authorization logic. The room key must be **at least as narrow as the smallest set of principals allowed to see the event**, derived from server-verified identity only.

**Target topology** (namespace `/agent/{agentId}` authorized at connect → rooms inside it):

| Room key | Who joins (server-gated) | Carries |
|---|---|---|
| `thread:{threadId}` | sockets whose **owner** passed `getThread(threadId, scope)` (H3 fix) | token stream, `tool_call`/`tool_result`, `done`/`error`, `run_update` with output, thread rename **for that thread** |
| `user:{org}:{project}:{env}:{userId}` | that user's sockets (browser + mobile fan-in) | `approval_needed`/`approval_resolved` addressed to that user, per-user thread-list/overview updates, notifications |
| `scope:{org}:{project}:{env}` | **operators only** — role-gated via the `OrgMember.role` lookup already at `connections.gateway.ts:414-419` | genuinely org-wide *operator* signals (dashboard overview, budget alerts) — **never** end-user message bodies, titles, or tool args |
| `role:{org}:{project}:{env}:{role}` | sockets whose verified role matches | role-scoped operator broadcasts (admin-only safety alerts) |

**Concrete changes (all in `connections.gateway.ts` unless noted):**

1. **Stop joining end-users to the scope room** (line 285). At connect: always `client.join(user:{org}:{project}:{env}:{userId})`; join `scope:*` **only** if a verified operator role. Lift the `orgMember.findFirst` role lookup (currently at 414-419) into `handleConnection` and stash `isOperator` on the socket. (This is the Socket.IO analog of Pusher `private-`/`presence-` server-round-trip authorization and Ably per-user capability tokens.)
2. **Re-target approvals** (134-155) → `user:{…}:{requestedBy}`, not the scope room. Gate `approval_response` on owner === `scope.userId` or operator role (H5).
3. **Re-target `run_update`** (`runs-bridge.service.ts:124-140`): full frame (output + `metadata.progress`) → `thread:{threadId}` only; to any scope room emit only a redacted `{runId, status, threadId}`.
4. **Re-target thread lifecycle + title** (156-161, `agent-task.service.ts:1635`) → `thread:{threadId}` (+ owner's `user:` room). Drop the scope-room target. (`thread.rename` at 1087 is correctly user-gated but still over-broadcasts — fold in.)
5. **Validate `overview:event` room server-side** (162-165): reconstruct `scope:{org}:{project}:{env}` from the payload tuple, never forward the raw `payload.room` string; operator-audience only.
6. **Formalize connect-time authz as `io.use()` middleware** (currently inline 180-315), rejecting with `next(new Error(...))` → un-bypassable, centralized, mirroring the global `APP_GUARD` HTTP `ScopeGuard`.
7. **Finish the per-agent namespace migration** (the deprecation notice at 288-294 promises `/agent/{agentId}` but only the shared `/agent` namespace exists). A parametric namespace + `.use()` gives a namespace-level authorization seam (the Socket.IO analog of Pusher/Ably per-tenant namespaces) — authorize agent access + enforce the H6 agent-pin at connect, then rooms handle per-user/per-thread fan-out.

**Net:** no end-user message body, tool result, run output, thread title, or approval detail is ever emitted to a room broader than its rightful audience. This is the change that makes a shared `(org, project, env)` safe for multiple untrusted end-users.

---

## 4. Prioritized Fix Sequence

Ordered by (blocker status × blast radius × implementation cost). Each notes blast-radius and whether a product decision is required.

**Phase 0 — cross-tenant escalations (do before ANY pilot; these are the only cross-*org* breaks + the auth-model collapse):**

1. **C1** — operator gate on entity-secret / entity-registration / test-cred mutations. *Blast: full auth-model collapse (mint tokens for any user). No product decision — clearly an operator action.* Introduces the reusable `requireOperator(req)` + `iss` on `req.scope` that Phase 1 reuses.
2. **C2** — HMAC-sign + ownership-check the 5 durable-exec callbacks. *Blast: cross-org turn execution under victim BYOK keys. No product decision — mirror the existing signed callback.*
3. **C3** — reject entityPk OAuth on platform MCP + clamp entity scopes to `mcp:tools`. *Blast: org/project-wide read+write from an embedded chatbot visitor. No product decision.*
4. **C4** — rebind `payload.scope` to the MCP token's scope in `trigger.tasks.trigger`. *Blast: cross-org via shared Trigger project. No product decision.*
5. **H2** — scope-bind `getThreadCost`; **M1** — fail-closed `TRIGGER_INTERNAL_SECRET`; **H14** — webapp secret guards; **M4** — entity-secret schema comment (at minimum). *Blast: cross-tenant spend oracle / forgeable internal HMAC / forgeable login on a copied `.env`. No product decisions — all clear bugs.*

**Phase 1 — the operator tier (unlocks the multi-user-per-tenant model; one structural change, many endpoints):**

6. **H1 / H10 / H16 / M7** — apply `requireOperator` across `/monitoring/*`, `/activity/*`, `/files/*`, budget CRUD, entity registration, approval-resolve operator branch. *Blast: cross-user PII/spend/files + financial DoS within a tenant. **Product decision:** confirm which surfaces are operator-only vs self-service (e.g. a user reading their *own* cost is fine; reading `:userId` others' is operator).*
7. **H7 / H9** — force `userId = scope.userId` on memory + KG reads/writes for non-operator tokens. *Blast: cross-user memory read/export/poisoning + KG PII. **Product decision:** does any legit flow need cross-user memory writes? If yes, that's the one operator-gated exception.* Do NOT add `/api/v1/memory*` to the public Caddyfile.

**Phase 2 — realtime + per-user isolation (the room redesign; largest single code change):**

8. **§3 room redesign** — per-user + per-thread + operator-role rooms; **H3** (user-gate `join_thread`); **H4/M6** (retarget broadcasts); **H5** (approval owner-check); **H6** (WS agent-pin); **H13** (fix stop key). *Blast: live token-stream hijack + passive cross-user leak of content/approvals/run output within a tenant. No product decision — the redesign is mechanical once the operator tier exists.* This is the gate for "multiple untrusted end-users under one tenant."

> **STATUS — Phase 2 SHIPPED (2026-07-17), deployed to test.platos, Fable-verified.**
> On connect every socket now joins only `user:{org}:{proj}:{env}:{userId}`; **operators additionally** join the tenant `scope:` room (`connections.gateway.ts` ~336). **H3** routes `join_thread` through `conversationService.getThread(threadId, scope, { allUsers: principal==='operator' })` (fails closed on the owner-OR clause). **H4/M6** retarget `approval:event` and `thread:lifecycle` to the requester/owner user room + operator scope room. **H5** gates both resolve paths (WS + `agent.controller.ts` HTTP) on `principal==='operator' || requestedBy===scope.userId`, **failing closed when `requestedBy` is null** (userless/MCP context → operator-only). **H6** pins the token `agentId` and rejects `AGENT_SCOPE_MISMATCH`. **H13** keys `activeStreams` by `…:userId:threadId:…` and stops by prefix-match, emitting `done` only when something aborted.
>
> **Fable adversarial verify (cross-model) caught, now fixed:** (a) the H5 guard originally read `requestedBy && requestedBy !== userId`, which **failed open** on a null requester — hardened to fail closed. (b) Moving end-users out of the scope room **starved three legitimate event paths** — `approval_resolved` (missing requester `userId` → never reached the requester's card), `thread:lifecycle` (owner not in scope room → conversation-list stopped updating), and `run_update` (owner not always in the thread room). All three now also fan out to the owner's `user:` room (`agent.controller.ts`, `agent.service.ts`, `tool-executor.service.ts`, `runs-bridge.service.ts`). Chat token delivery to `thread:{id}` was unaffected (smoke-verified).
>
> **Residual (deferred to Phase 4):** `overview:event` still forwards a publisher-supplied `payload.room` unvalidated (§3 item 5 — server-side room reconstruction); current publishers are safe. Non-guest entity/operator tokens minted without an `agentId` claim leave `pinnedAgentId` undefined (unconstrained) — consistent with the HTTP `ScopeGuard`, not a Phase 2 regression.

**Phase 3 — SSRF, RAG isolation, tool-ACL, DoS hardening:**

9. **H11** — `fetchWithValidatedRedirects` on the 3 MCP/entity-callback fetches. *Blast: blind SSRF → cloud metadata + scope-header leak. No product decision.*
10. **H8 / L5** — thread `userId` (+ `agentId`) into the RAG scope; retire the `'default'` fallback (fail closed). *Blast: cross-user RAG corpus pooling. No product decision.*
11. **H12** — enforce per-tool MCP ACL on dispatch. *Blast: ACL bypass on entity MCP. No product decision.*

> **STATUS — Phase 3 cluster 1 (H8, H11, H12) SHIPPED (2026-07-17), deployed to test.platos, Fable-verified (two rounds).**
> **H8** — `ragResolveUserId` (`skill-handlers.ts`) now **fails closed** (throws) instead of pooling into a shared `"default"` bucket; the acting `userId` is threaded through all five turn-time `invokeTool` sites (`agent.service.ts` ×4, `agent.controller.ts` ×1) and `invokeTool`'s scope param was widened to `ScopeTuple & { userId?: string }`. Resolver call sites catch the throw fail-open (degrade to saved prompt); execute sites surface it as a tool error. **H11** — the three privileged outbound fetches (`mcp-tool-executor.service.ts`, `server-registry.service.ts`, `tool-executor.service.ts` entity-callback) now use `fetchWithValidatedRedirects`, which re-validates **every** redirect hop (`redirect:"manual"`), so signed `X-Platos-*` headers + user token can only reach an SSRF-validated hop. **H12** — `filterByIdentity` is now enforced on `tools/call` (reject `PERMISSION_DENIED`) and hides tools on `tools/list`; `identityMode`/`scopes` are threaded through all four token paths.
>
> **Beyond the plan / Fable-caught (all fixed):** (a) `filterByIdentity`'s identity gate was exact-match — it would have **denied every OAuth (`oidc`) caller a default `bearer` tool** (breaking the pilot widget the moment enforcement went live) and let a `bearer` PAT through an `oidc`-required tool. Rewrote it as a hierarchical floor (`anonymous < bearer < oidc`). (b) **12a** — the anonymous "continue without signing in" flow mints an OAuth token (`mcp:anon:` userId) that was stamped `identityMode:"oidc"`, so an anonymous visitor cleared a `minIdentityMode:"oidc"` gate; now demoted to `"anonymous"` on both the `authenticate()` and `messages()` paths. (c) **12b** — `handleToolsCall` fail-opened when a tool was on the coarse allowlist but had no ACL row (the `autoInsert` invariant is never enforced; config-PATCH writes the allowlist directly). Both call and list now fall back to the **system-default ACL** (min `"bearer"`, denies anonymous) so they apply the identical effective gate (`exposed:true` filtered in both — no callable-but-list-hidden drift). (d) `handleRpc` now `await`s the handlers so ACL-query rejections return a JSON-RPC error envelope instead of an HTTP 500.
>
> **⚠️ BEHAVIOR CHANGE (operator-facing) — `filterByIdentity` had zero call sites before, so this is the FIRST time the per-tool MCP ACL is enforced at all.** On a tool with no explicit ACL row (or a default `bearer` row), two caller classes that previously worked are **now denied**: (1) **anonymous** MCP callers — an entity that wants anonymous tool access must set that tool's `minIdentityMode` to `"anonymous"`; (2) **custom-scoped tokens** whose `scopes` lack `"mcp:tools"` (a PAT minted with custom `scopes`, or an OAuth token requesting a nonstandard scope). Standard tokens (default `scopes:["mcp:tools"]`) pass. Confirm the deployed entities' caller mix before relying on this in the pilot.
>
> **Residuals (deferred to Phase 4):** H11 DNS-rebind TOCTOU is not closed (validate-by-hostname, no IP-pin — needs hardening inside `fetchWithValidatedRedirects`); privileged headers still follow a redirect to any **public** host (SSRF-to-internal closed, exfil-to-arbitrary-public open). Duplicate `toolName` rows (uniqueness is `(entityPk, toolId)`) could let list (Map last-wins) and call (`findFirst` first-wins) pick different rows — low-severity, needs an `orderBy` or a name-level uniqueness constraint.

12. **H15** — tenant-scope `PlatosToolDefinition` (or at least the BM25 index). *Blast: cross-tenant tool-row overwrite + ranking poison. **Product decision:** schema migration timing (`@@unique` change is a migration).*
13. **M2, M3, M5, M8** — claims-whitelist mint, OAuth-token key separation, WS responder binding, ReDoS guard. *No product decisions.*

**Phase 4 — defense-in-depth + the CI gate that makes it stick:**

14. **Make `cross-scope-isolation.test.ts` real and blocking** — two-org + two-user fixture via `internal-packages/testcontainers`; assert cross-tenant AND cross-user reads/writes/subscribes return null/`[]`/404/rejected across every scoped model and every transport (HTTP, WS join, memory REST). Wire into CI as a **merge gate** (OWASP API1 rule #4: don't deploy changes that fail the authz tests). *This is the enforcement that keeps Phases 0-3 from regressing.*
15. **L1, L2, L4, L7, L8, L6** — scope-namespace the remaining Redis keys / lookups; add `agentId` to KG rows before any KG recall; decide body-limit code-vs-Caddy. *L7/L8 need-human (run-ownership tagging model; body-cap ops call).*
16. **Postgres RLS backstop** (optional but highest defense-in-depth): `ENABLE ROW LEVEL SECURITY` + `current_setting('platos.org')` policies on `Platos*` scoped tables, GUCs set per-request via a Prisma `$extends` transaction wrapper. Roll out **log-only → enforcing**, minding the `PLATOS_ADMIN_TOKEN` cross-scope sweeps (run those as a `BYPASSRLS` role). *This is the layer that holds even when a handler forgets its `where` — it directly answers CLAUDE.md's own admission that "the scope model is an implicit convention with no universal query layer."*

**Key files for the changes above:** `apps/agent/src/auth/scope.guard.ts` (add `iss`→`req.scope`, `requireOperator`), `apps/agent/src/agent-runtime/agent.controller.ts` (C1, C2, H1, H2, H10, H16, monitoring family), `apps/agent/src/connections/connections.gateway.ts` (§3 redesign, H3, H5, H6, H13), `apps/agent/src/mcp-platform/mcp-platform.controller.ts` (C3), `apps/agent/src/mcp-platform/tools/trigger.ts` (C4), `apps/agent/src/memory/memory.controller.ts` + `knowledge-graph.service.ts` (H7, H9), `apps/agent/src/agent-runtime/agent.service.ts` + `skills/official/skill-handlers.ts` + `skill-runtime.service.ts` (H8), `apps/agent/src/mcp-agent/{mcp-tool-executor,server-registry}.service.ts` + `tool-gateway/tool-executor.service.ts` (H11), `apps/agent/src/mcp-platform/mcp-entity.controller.ts` + `mcp-tool-acl.service.ts` (H12), `apps/webapp/app/env.server.ts` (H14), `internal-packages/database/prisma/schema.prisma` (H15, L6, RLS), `apps/agent/src/auth/cross-scope-isolation.test.ts` + `internal-packages/testcontainers` (Phase 4 gate).
