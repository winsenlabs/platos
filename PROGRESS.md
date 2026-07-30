# PROGRESS — prompt caching + LLM serving research

Branch: `feat/prompt-caching-and-serving-research`
**Not deployed.** The operator deploys. No prod env vars, secrets, or agent `modelRoutes` touched.

## Iteration 1

### Workstream A — Anthropic message-history caching: CODE COMPLETE, verification gate PENDING

**Root cause confirmed in code.** `agent.service.ts` built the message array once per turn with a
`cache_control` breakpoint on the **system message only**:

```
messages = [ {role:system, providerOptions:{anthropic:{cacheControl}}}, ...history, {role:user} ]
```

`streamText` then runs the whole tool loop *internally*, appending `tool_use` / `tool_result`
blocks between steps. So the single breakpoint went stale at step 1 and every later step re-paid
full price for the entire growing history. That is exactly the evidence trace: 1,684,498 input
tokens billed against 198,224 cache reads on a 12-step turn, 300.85 cents for one turn.

**API facts verified against the installed SDK (not assumed):**
- Installed: `ai@7.0.28`, `@ai-sdk/anthropic@4.0.15`.
- Per-message field name is `providerOptions.anthropic.cacheControl` — confirmed by *existing
  working code* on the system prompt (`agent.service.ts` system message) and the sub-agent path.
- `prepareStep` exists and is **stable** (not `experimental_`) in `ai@7.0.28`. Its
  `PrepareStepFunction` receives `{ steps, stepNumber, model, instructions, messages,
  initialMessages }` and the d.ts states: *"If you return a `messages` override, those messages
  carry forward to later steps."* This is the per-step hook the fix needs.
- `repairToolCall` exists and is stable; `ToolCallRepairFunction` receives
  `{ toolCall, tools, inputSchema, error: NoSuchToolError | InvalidToolInputError }` and returns a
  repaired call or `null`. Used for Workstream C.

**Implemented:**
- `apps/agent/src/agent-runtime/anthropic-cache-breakpoints.ts` (new, pure, 14 unit tests):
  - Keeps the system breakpoint; spends the remaining **3 of Anthropic's 4** on the message array.
  - Always marks the **last non-system message** (the moving head).
  - Places intermediate breakpoints every **15 content blocks** (`BREAKPOINT_BLOCK_STRIDE`), safely
    under the ~20-block lookback, so a step with many *parallel* tool calls cannot silently miss.
  - Non-destructive: merges into existing `providerOptions` / existing `anthropic` options.
  - Idempotent, does not mutate input, never marks a `system` message.
- `agent.service.ts`: initial array marked, and **`prepareStep` re-marks on every internal step**
  (the actual fix). Anthropic-path only — OpenAI prefix-caches automatically and Google/Vertex
  cache implicitly, so no invented breakpoints elsewhere (brief req. 5).
- Per-step debug metric (brief req. 6): `[agent.cache] step in= read= write= uncached= read_pct=`.
  `read_pct` on steps 2+ is the regression canary.

**Verification gate — NOT yet passed.** Needs a real multi-step turn on the Anthropic provider with
per-step usage captured (target: steps 2+ show `cache_read_input_tokens` >= 90% of context;
whole-turn full-price tokens down 3–5x vs the evidence trace). Blocked on running a live turn
against a test agent; the operator controls deploys, so this will be measured either against a
locally-run agent or by the operator after deploy. **Numbers to be recorded here, not adjectives.**

### Workstream C — tolerant tool-call param parsing: DONE (11 passing tests)

- `apps/agent/src/agent-runtime/tool-input-repair.ts` (new, pure).
- Fixes at the SDK's `repairToolCall` hook, so a stringified input is repaired **in place with zero
  extra LLM round-trips** — the previous behaviour bounced the error back to the model and burned
  three full-price 100k-token steps in the evidence trace.
- **Schema-driven on purpose.** A string is only unwrapped when the tool's own JSON Schema says the
  property is an object/array. Blindly `JSON.parse`-ing anything that starts with `{` or `[` would
  corrupt legitimate string arguments (email bodies, code snippets, pasted JSON) — there is an
  explicit test for that. No schema => no repair, never a guess.
- Regression test uses the exact evidence shape: `{"calls": "[{\"tool\":…,\"params\":{…\\n…}}]"}`
  with real newlines in the body, plus a doubly-nested variant (stringified `calls` *and*
  stringified `params`).

### Workstream B — provider/caching landscape: IN FLIGHT

Running as a parallel research fan-out (5 providers from live docs + a cache-prefix byte-stability
audit of this repo), synthesising to `docs/research/llm-serving-and-caching.md`.

## Verified numbers so far

| Item | Value |
|---|---|
| New unit tests passing | 25 (14 breakpoints + 11 repair) |
| Typecheck | clean (agent app) |
| Evidence-trace waste | ~1.47M tokens/turn at full price, 300.85 cents |
| Breakpoint budget used | 4 of 4 (1 system + 3 message) |
| Intermediate stride | 15 content blocks (lookback ~20) |

## Blockers / operator decisions

1. **A's verification gate needs a live multi-step Anthropic turn.** Not deployable by me.
2. **Mid-thread toolset refresh vs cache retention** — if the scoped tool registry changes mid-thread
   the `tools` block changes and wipes the entire cache. Pending the audit's finding; will be
   written up in the report as an operator trade-off.
3. Anything the audit flags as CROSS-TURN-FATAL in the system prompt (e.g. a live timestamp) may need
   a prompt-block change, which touches agent config — operator's call.

## Iteration 2

### Workstream B — DONE

`docs/research/llm-serving-and-caching.md`, 1,021 lines. All five paths (Anthropic direct, Claude on
Vertex, Vertex MaaS open models, Gemini context caching, Together.ai) with priced tables, a
comparison table, the cache-prefix audit verbatim, and committed verdicts. Unverifiable claims are
marked `NOT CONFIRMED FROM DOCS` rather than guessed.

**Verdicts:** Claude stays on **Anthropic API direct** (Vertex global is exact price parity, so it
buys nothing; automatic caching and cache diagnostics are Claude-API-only). GLM -> **Together.ai**
(`zai-org/GLM-5.2`). Kimi -> **Together.ai** (`Kimi-K2.6`), conceding openly that Vertex Kimi is
~2x cheaper on input and does cache, but the Vertex open-model endpoints **retire 2026-10-21**.

### Workstream A — CRITICAL SELF-INFLICTED BUG FOUND AND FIXED

The audit caught that iteration 1's caching **did not work**. `withAnthropicCacheBreakpoints` was
additive, `prepareStep` re-applies it per step, and a `messages` override **carries forward**, so
markers accumulated instead of moving. Reproduced before fixing:

| | markers per request (Anthropic limit = 4) |
|---|---|
| before | 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> **11** |
| after | 2 -> 2 -> 2 -> 2 -> 2 -> 2 -> 2 -> 2 -> 3 -> 3 -> 3 |

Past 4 the request is rejected or the overflow is dropped in document order, discarding the
**newest** (head) breakpoint — the one that makes the next step a hit. So iteration 1 would have
reproduced the very trace it was written to fix. Fixed with strip-before-apply; regression test now
simulates the real carry-forward loop over 10 steps. The old "idempotent" test missed it because it
re-applied to the *same* array, where the chosen indices do not move.

### Cache-prefix stability audit — triage of all 13 findings

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Breakpoints accumulate across steps; newest dropped | CACHE-FATAL | **FIXED** (strip-before-apply + test) |
| 6 | CTX.6 block ordered by Map iteration / unordered `findMany` | CROSS-TURN-FATAL | **FIXED** (sort at render + `orderBy` in `rebuildIndex`) |
| 9 | Skill tools + skill prompt blocks from unordered `findMany` | CROSS-TURN-FATAL | **FIXED** (`orderBy: [{skillId:"asc"}]`) |
| 2 | Layer-1 Redis cache HIT double-appends 3 system blocks | CROSS-TURN-FATAL | OPEN |
| 3 | Skill tools + skill prompt block skipped entirely on a Layer-1 cache hit | CROSS-TURN-FATAL **+ functional bug** | OPEN — worth fixing regardless of caching |
| 4 | `{{user.current_time}}` (ms precision) substituted into the SYSTEM prompt | CROSS-TURN-FATAL | OPEN — **highest remaining value** |
| 5 | `assembleAsync` bakes datetime + `current_date` into system prompt for retrieval-block agents | CROSS-TURN-FATAL | OPEN |
| 7 | `## Available tool categories` embeds live counts in system prompt | CROSS-TURN-FATAL (summary/hybrid) | OPEN |
| 8 | `find_tools` description embeds per-turn `entity_ids` | CROSS-TURN-FATAL (if it varies) | OPEN |
| 10 | MCP discovery cron guarantees a toolset refresh every ~5 min | CROSS-TURN-FATAL, unavoidable today | **OPERATOR DECISION** |
| 11 | `run()` (non-streaming) has no breakpoint at all; Vertex/Bedrock Claude excluded | gap | OPEN |
| 12 | `__datetime` / `__memory` / `__user_profile` land post-breakpoint | SAFE | correct as designed |
| 13 | Meta-tool key order; canary `Math.random` | SAFE | no action |

**Reading of this:** finding 1 blocked caching *within* a turn (now fixed). Findings 2-9 block it
*between* turns. Finding 4 is the single highest-value remaining item: a millisecond timestamp in the
system prompt means cross-turn caching can never hit for any agent whose prompt references
`{{user.current_time}}`, and the Layer-1 cache does not mask it (the cached value is stored
pre-substitution, so it re-renders fresh every turn).

### Two pre-existing bugs the audit surfaced (unrelated to caching, worth logging)

1. Stale `gemini-2.5-flash-lite` cached price in `defaultPrices.ts`.
2. `registry.ts:150-156` sums additively and **double-counts Gemini cached tokens**, because
   `promptTokenCount` is already inclusive of cached tokens.

Neither is touched yet.

## Verified numbers

| Item | Value |
|---|---|
| New unit tests passing | 32 (17 breakpoints + 11 repair + 4 wire) |
| Typecheck | clean |
| Marker accumulation before / after | 11 / 3 (limit 4) |
| Wire format confirmed | `messages[2] role=user part[0] type=tool_result cache_control={"type":"ephemeral"}` |
| Report | 1,021 lines, 5 sections + table + audit + recommendation |

## Operator actions

1. **A's live verification gate (blocked on you).** After deploying the branch, run a multi-step tool
   turn on an Anthropic-provider test agent and capture per-step usage. The debug line
   `[agent.cache] step in= read= write= uncached= read_pct=` prints it. Gate: steps 2+ show
   `read_pct` >= 90%, and whole-turn full-price tokens fall 3-5x versus the evidence trace
   (1,684,498 input / 198,224 read). Record here.
2. **Sonnet 5 price step 2026-09-01**: USD 2/10 -> 3/15 per 1M tokens. Needs a dated catalog entry.
3. **MCP discovery vs cache retention** (finding 10): the ~5-min discovery cron mutates the registry
   on roughly the same cadence as Anthropic's 5-min cache window. Trade-off is yours.
4. **Together account + key** as a scope secret (`scopedEnv.get()` has no `process.env` fallback),
   plus model-string remaps: `zai-org/GLM-4.5`, `GLM-4.5-Air`, `GLM-4.6` are gone from Together's
   live catalog and will fail opaquely.
5. **Findings 4/5/7/8 may need prompt or agent-config edits** (e.g. dropping
   `{{user.current_time}}` from prompt blocks), which is your call, not mine.

## Next action

Fix finding 4 (timestamp out of the system prefix) — the highest-value remaining unlock — then 3
(skills silently dropped on cache hits, a real functional bug), then 2/5/7/8, then 11.
