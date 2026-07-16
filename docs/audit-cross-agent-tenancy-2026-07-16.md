# Cross-agent / cross-tenant audit — 2026-07-16

Triggered by a live leak: **Mark** (fitness agent) opened a chat with **Ada's** (SDR) Pulsegrid/cold-email context for the same user. Three parallel auditors swept (1) memory/KG read+write paths, (2) every other turn-time ingredient + broadcast surfaces, (3) the day's new Trigger-Sessions code. Rule under test: *a turn's context contains only its own agent's data, plus cluster-shared data when agents share a `clusteringId`.*

## FIXED this session

| # | Finding | Sev | Fix |
|---|---------|-----|-----|
| A | **Memory recall/injection/list had no agentId filter** — every agent read every agent's user memories (the Mark/Ada leak). | High | PR #42: pass `agentId: scope.agentId` at all three read sites. |
| B | **Clustered agents still searched scope-wide** — the #42 fix *dropped* the filter for clustered agents instead of resolving cluster members; `semanticSearchForCluster` also searched all agents in scope. | High | PR #43 + this PR: `memoryAgentFilter()` resolves cluster MEMBERS → `agentIds` filter; `list`/`semanticSearch` gained `agentIds`; fails **closed** to the single agent on error. |
| C | **Socket.IO dispatch IDOR** — `tryDispatchSession`/`tryDispatchDurable` joined `thread:<client-supplied-threadId>` with no ownership check (unlike `handleJoinThread`). A caller with a durable agent in their own scope could pass a victim's threadId → read the victim's streamed turns AND inject into their live UI; also attach to the victim's durable session `.out`. | High | This PR: both paths now resolve every threadId through the scope+owner-gated `getOrCreateThread`; a non-owned threadId mints a fresh owned thread instead of joining the victim room. |
| D | **Extraction wrote duplicate memories** every hourly sweep (same facts at 10/11/12:00). | Med | PR #43: per-thread watermark (`memx:wm:<threadId>` on `thread.updatedAt`); manual kicks pass `force`. |

## PRE-EXISTING — flagged, NOT yet fixed (need your call; larger/older surfaces)

| # | Finding | Sev | Recommended fix |
|---|---------|-----|-----------------|
| E | **REST `/api/v1/memory/*` `?userId=` override** — `GET /`, `/search`, `/export`, `/graph/*` take `userId` from a query param and any entity/session token reaches them (the agent-pin only guards `/agents/:id/*`). A session-token holder reads **any other user's** memories + full export (incl. archived + private). | **High** (cross-user, externally reachable) | Ignore client `userId` on session-token auth (force `scope.userId`); only honor `?userId=` for operator/admin-tier tokens. Add a default `agentId` filter too. |
| F | **`monitoring/users/:userId*` endpoints** — profile/memory content + LLM summaries for any `:userId`, session-token reachable, no membership tier. | **High** | Gate behind an operator/admin tier, not the plain scope guard. |
| G | **Scope-room broadcast** — every client joins `scope:{org}:{proj}:{env}`; `run_update` events (incl. BGO/batch `output`) and `approval_needed`/`approval_resolved` (incl. `action`+`details`) fan out to **all** clients in the scope, no user/agent gate. | **High** (client-delivery leak) | Narrow the broadcast: route run/approval events to a `user:` or `thread:` room, not the scope room; or gate membership. Structural — needs a design pass. |
| H | **`join_thread` scope-gated, not user-gated** — any same-scope client with a known threadId joins the thread room + receives its live stream (batch `output` may carry per-item PII). | Med | Add the `userId`/`createdByUserId` check to `handleJoinThread` (the dispatch paths now do this via getOrCreateThread; join_thread should match). |
| I | **Run-inspection meta-tools** (`get_run_details`/`replay_run`/`wait_for_runs`/`list_runs`) enforce no scope/owner check on `runId`; `list_bgos`/`list_runs` filter project+env only. | Med (default-OFF per agent) | Scope-check the runId against the caller's tuple before returning `output`/replaying. |
| J | **`agentId: NULL` writes** — REST `POST /memory`, MCP `memories.upsert`, RAG ingest, and export→import round-trips create/strip to null-agent rows: invisible to strict recall (silent loss) yet visible to any remaining scope-wide fallback. | Med | Stamp the caller's agentId on write; preserve agentId across export/import. |
| K | **KG has no `agentId` column** (`PlatosMemoryEntity`/`Relationship`). No turn-time KG *read* exists today (safe), but any future KG-in-prompt injection is an automatic cross-agent leak with nothing to filter on. | Note / landmine | Add `agentId` to KG rows before wiring any KG recall. |
| L | **Trigger session `externalId` = bare threadId**, globally keyed, no scope binding; Redis cursor key `chatsess:cursor:<threadId>` unscoped. Mitigated by fix C (threadId now owner-resolved) but defense-in-depth wants scope-namespacing. | Low (post-C) | Namespace session externalId + cursor key with the scope tuple. |

## BY DESIGN (documented, not bugs)

- **Conversation history, compaction summaries, artifacts** are keyed by `threadId`, not `agentId`. Agent-switch-mid-thread is a feature, so these are cross-agent *within a shared thread* by design. "Agent isolation" is really "thread isolation" for these three. Threads remain user-gated.
- **MCP `memories.*` / `kg.*` / `gdpr.export`** are operator surfaces (scope-tier tokens, gdpr approval-gated). Caveat: an operator can bind the platform MCP to an agent, handing it scope-wide memory reads — worth a docs warning.
- Profile cache, config/prompt Redis caches, dynamicBlocks/promptVars/sessionContext, scoped-env: all correctly agent- or scope-keyed. Safe.
- `WorkingMemoryService` is `threadId`-only keyed but has **no callers** (dead wiring) — safe today, latent if ever injected.

## Top pre-existing to fix next (recommended order)
1. **E + F** — REST `?userId=` / `monitoring/users` cross-user (externally reachable, High).
2. **G + H** — scope-room broadcast + `join_thread` gating (High/Med, structural).
3. **J** — agentId-null writes (data-integrity + the strict-filter blind spot).
