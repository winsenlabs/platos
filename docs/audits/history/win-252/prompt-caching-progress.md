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

## Iteration 3 — audit findings closed out, A measured

All 13 audit findings are now resolved. Ten were fixed in code; one is an operator decision; two
needed no action.

| # | Finding | Status |
|---|---|---|
| 1 | Breakpoints accumulate across steps; newest dropped | FIXED — strip-before-apply |
| 2 | Layer-1 cache HIT double-appends 3 prefix blocks | FIXED — gated on the miss |
| 3 | Skill tools dropped entirely on a Layer-1 cache HIT | FIXED — **was a live functional bug** |
| 4 | `{{user.current_time}}` resolves inside the cached prompt | FIXED — relocated to a pointer |
| 5 | `assembleAsync` bakes a second-precision clock into the prefix | FIXED — `omitDateTimeBlock` |
| 6 | CTX.6 block ordered by Map iteration / unordered `findMany` | FIXED — sort + `orderBy` |
| 7 | Exact tool counts in `## Available tool categories` | FIXED — bucketed |
| 8 | Entity IDs in `find_tools`' description reorder per turn | FIXED — sorted + deduped |
| 9 | Skill tools/prompt blocks from unordered `findMany` | FIXED — `orderBy` |
| 10 | MCP discovery cron refreshes the toolset every ~5 min | **OPERATOR DECISION** |
| 11 | `run()` had no breakpoint at all | FIXED — full parity with `stream()` |
| 11b | Claude via Vertex/Bedrock excluded by the provider gate | **NOT APPLICABLE** — no such route exists |
| 12 | `__datetime` / `__memory` / `__user_profile` post-breakpoint | correct as designed |
| 13 | Meta-tool key order; canary `Math.random` | no action |

Two of these deserve calling out because they were not really caching bugs:

- **Finding 3 was a live functional bug.** The skill block was gated on `!promptCacheHit` as a whole,
  but that block also *registers the executable tool closures* and the `find_tools` index — runtime
  state that is rebuilt every turn and is in no cached string. So on a warm Layer-1 cache the agent
  received a system prompt describing skill tools that were absent from `tools`: the model called one
  and got `NoSuchTool`, and `find_tools` would not list it. It tracked Redis warmth, so it presented
  as flakiness rather than breakage.
- **Finding 11b is not applicable.** The audit flagged Claude-on-Vertex as excluded by the
  `provider === "anthropic"` gate, but Platos has no Vertex-Anthropic route at all — the
  `google-vertex` manifest carries only Gemini and the GLM MaaS models. Nothing to exclude, and the
  serving research independently lands on keeping Claude on the Anthropic API direct.

### Workstream A — measured end to end

A billed turn needs a deploy or a live key, so the fix is measured against a fake endpoint
implementing Anthropic's documented prefix-cache semantics. The seam is worth stating precisely:

- **Real:** the message array, breakpoint placement, `prepareStep`, the provider's wire
  serialisation, the SDK's multi-step tool loop. The inspected request bodies are the exact bytes
  that would reach `api.anthropic.com`.
- **Simulated:** the token accounting — prefix entry at P covers `[0..P]`, longest-prefix match
  within the ~20-block lookback, at most 4 breakpoints honoured with overflow dropped in document
  order.

12-step turn, both arms through the same fake:

| metric | before | after |
|---|---|---|
| full-price tokens | 127,200 | **0** |
| cache-read tokens | 20,504 | 126,329 |
| cache-write tokens | 1,864 | 23,239 |
| billed base-token-equivalents | 131,580 | **41,682 (3.16x cheaper)** |
| cache-read share at step 12 | 8% | **91%** |
| peak breakpoints per request | 1 | 3 (limit 4) |

The before arm reproduces the production trace's signature exactly: cache-read pinned **flat** at the
system prefix while full-price grows every step. That is what 1,684,498 input against 198,224 read
looks like from the inside.

Asserted on **cost**, not cache-read share, because share flatters the fix — the non-read remainder
moves from full price (1.0x) to writes, which cost *more* per token (1.25x), not less. 3.16x is the
floor for this shape: the synthetic tool results are large relative to the system prompt, so the
cached prefix is a smaller fraction of each request than in the real trace, where 12 steps averaged
~140k context.

Two harness bugs surfaced while building this, both of which had produced confidently wrong numbers
before being caught — worth recording because either would have made the fix look wrong:

1. Hits were looked up only at positions marked in the *current* request. Anthropic does a
   longest-prefix match, and the prefix cached at the previous step's breakpoint is still a
   byte-identical prefix of this request.
2. `cache_control` was included in the hashed content. It is metadata about where to cut, not
   content — if it were hashed, advancing a breakpoint would change the bytes of the block it used to
   sit on and every hit would miss, making Anthropic's own documented "move the breakpoint forward"
   pattern impossible. This one pinned reads at the system prefix and made the fix look inert.

## Final state

| | |
|---|---|
| Branch | `feat/prompt-caching-and-serving-research`, 8 commits, **not deployed** |
| Tests | 60 new, all passing (breakpoints 17, repair 11, wire 5, volatile 12, datetime 5, categories 9, simulation 2) |
| Typecheck | clean |
| Pre-existing agent-suite failures | 17, confirmed identical on `main` — none mine |
| Report | `docs/research/llm-serving-and-caching.md`, 1,021 lines, 5 sections + table + recommendation |

Against the brief's stop conditions: **C** is done with regression tests; **B** is done with all five
sections and a committed recommendation; **A** is code-complete and measured on the real code path,
but its *live* gate is still open because only the operator can deploy.

## Iteration 4 — DEPLOYED to test.platos, A's gate PASSED on the live binary

Operator lifted the no-deploy constraint. Branch pushed to `origin`, agent and webapp both built and
deployed **sequentially** (never concurrently — a concurrent build previously OOM-killed dockerd on
this 7.9 GB box). Peak load: agent build 4.1, webapp build 7.0, versus 89 during that incident. All
six services healthy throughout; the agent stayed healthy for the whole webapp build.

### A's verification gate — PASSED with real numbers

Driven against a disposable `zz-cache-verify` agent on `anthropic:claude-sonnet-5` with a
deliberately long (>1024-token) prompt and read-only memory tools, so nothing outward-facing could
fire. Walle itself was deliberately NOT used to drive turns — it holds live mail/calendar/CRM tools
and a multi-step turn could have taken real actions.

Turn 1, five steps, straight off `docker logs`:

```
[agent.cache] step in=4512 read=0    write=4510 uncached=2 read_pct=0%
[agent.cache] step in=4610 read=4510 write=98   uncached=2 read_pct=98%
[agent.cache] step in=4704 read=4608 write=94   uncached=2 read_pct=98%
[agent.cache] step in=4802 read=4702 write=98   uncached=2 read_pct=98%
[agent.cache] step in=4900 read=4800 write=98   uncached=2 read_pct=98%
```

Turn 2 in the same thread, first step: `in=4545 read=4510 write=33 uncached=2 read_pct=99%`.

- **Gate was "steps 2+ at >= 90% cache read". Actual: 98%.** Only **2 tokens per step** pay full
  price.
- **Cross-turn caching confirmed.** Turn 2 starts *warm* at 99% rather than cold. That is the direct
  proof that findings 2-9 (timestamp relocation, deterministic ordering, no double-append, bucketed
  counts) work on the live binary — before them, turn 2 step 1 would have read 0.

**Honest limit on this measurement.** Tool results here were ~98 tokens per step, so the absolute
saving on this particular turn is small. The 3-5x whole-turn figure applies to turns shaped like the
evidence trace, where large tool payloads accumulate across a dozen steps. What is proven live is the
mechanism and the hit rate; the magnitude scales with how much history a turn actually accrues.

### A bug found only by deploying

The per-step metric was written as `logger.debug`. Nest suppresses `debug` under
`NODE_ENV=production`, so on the live agent it emitted **nothing** — the verification hook could
never fire on the deployment whose bill it exists to explain. Confirmed empirically (zero DEBUG lines
in the container). Promoted to `log` level, gated on the provider actually reporting cache counters
so non-caching providers stay quiet. Everything above was measured only after that second deploy.

## Operator actions

1. ~~A's live verification gate~~ **DONE — see Iteration 4.** 98% steady-state, 99% cross-turn.
2. **Sonnet 5 price step 2026-09-01**: USD 2/10 -> 3/15 per 1M. Needs a dated catalog entry.
3. **MCP discovery vs cache retention** (finding 10): the ~5-minute discovery cron mutates the tool
   registry on roughly the same cadence as Anthropic's 5-minute cache window, so a busy environment
   can lose the prefix to discovery alone. Findings 6/7/8 removed the *incidental* churn (ordering,
   counts, ID order), so what remains is genuine change — a real new tool appearing. Options: lengthen
   the cron, or only rebuild the prefix when the tool set actually differs. Your call.
4. **Together account + key** as a scope secret (`scopedEnv.get()` has no `process.env` fallback),
   plus model-string remaps: `zai-org/GLM-4.5`, `GLM-4.5-Air`, `GLM-4.6` are gone from Together's
   live catalog and will fail opaquely.
5. ~~Two pre-existing cost-reporting bugs~~ **FIXED and deployed** — see "Billing" below.

6. **NEW / PRE-EXISTING — ClickHouse is unprovisioned on test.platos, so LLM cost metrics do not
   persist.** Found while verifying the deploy. The agent logs
   `[Platos Spans] clickhouse write failed: the inherited telemetry database does not exist` on every turn.
   ClickHouse holds only `default`, `system` and the two information schemas, and `default` contains
   **zero tables** — no `platos_spans_v1`, no `llm_metrics_v1`. `CLICKHOUSE_MIGRATIONS=1` is set in
   `.env`, so migrations are nominally enabled but have not run.

   Not caused by this deploy: the span insert used the inherited database name in
   `spans.service.ts` and has been since 2026-05-05 (`fcc6854`), and this branch touches no
   ClickHouse or span file.

   Why it matters here: the billing double-count fix operates on the span-enrichment path, so its
   corrected numbers currently have nowhere to land on this box. The fix is right and deployed; it
   will start producing correct output the moment ClickHouse is migrated. **Per-turn cost tracking is
   unaffected** — that runs through the agent's own Postgres-backed cost service, which is what
   produced the 300.85 cents figure and the `costCents` on the verification turns above.
6. **Prompt-authoring note, no action required.** Callers that pass their own per-turn-fresh
   `sessionContext` values (a caller-supplied `custom.now`, a per-request request ID) referenced from
   a *system* prompt block will still defeat cross-turn caching. Finding 4 only covers keys that mean
   "now" by contract; Platos cannot tell a deliberately-fixed timestamp from a live one by shape
   alone.

## Billing fixes (added on operator request, deployed)

Both were flagged during the research; each was re-verified at the source rather than taken on trust,
and the verification changed the conclusion in both directions.

**1. Cached tokens billed twice — webapp OTLP cost enrichment.**
`gen_ai.usage.input_tokens` is the AI SDK's `usage.inputTokens`, which is INCLUSIVE of the cache
slice, and `calculateCost` sums usage types additively. So cached tokens were charged at the full
input rate inside `input` and again at the cached rate. A step reading 18k of 20k context from cache
billed 21,800 base-token-equivalents instead of 3,800 — **5.7x overstated**, and the error *grows* as
caching improves, so this branch's own caching work would have made reported cost progressively
wronger.

Scope was narrower than reported in one way and broader in another: the report blamed
`registry.ts:150-156` and called it Gemini-specific. The additive loop is the mechanism, but the
registry is a generic price-table evaluator whose contract only holds if counts do not overlap, so
fixing it there would break callers that already pass exclusive values. Fixed at the boundary that
knows the SDK's semantics (`toBillableUsage`). And it was never Gemini-specific — the SDK normalises
to inclusive, so it hit every provider on that path. The agent's own cost path was already correct.

**2. Gemini 2.5 Flash-Lite cached-input price.**
Catalog carried $0.025/1M; Google publishes **$0.01/1M**. I initially believed this claim was wrong —
$0.025 is 25% of the $0.10 input price, a common ratio — and checked Google's pricing page before
touching anything. It quotes "Context caching: $0.01 (text / image / video)". The report was right
and my reasoning was wrong. The three sibling prices were checked at the same time and are all
already correct (`gemini-2.5-flash` $0.03, `gemini-2.5-pro` $0.125 / $0.25) and deliberately left
alone.

`defaultPrices.ts` is generated from a JSON file synced verbatim from Langfuse upstream, so editing
either would have been reverted by the next `pnpm run sync-prices`, silently restoring the
mispricing. Added `price-overrides.json`, applied by `generate.mjs` on top of the sync, recording the
provider quote, source URL and verification date. The generator throws if an override targets a
missing model/tier/key **or if upstream catches up and the override becomes redundant**, so overrides
get deleted rather than accumulating.

Not modelled: Google also charges cache storage at $1.00/1M tokens/hour for explicit caching. The
catalog is a per-token table with no notion of time-based storage — that needs a schema change, not a
price entry. Noted in the override file.

Both verified in the running webapp bundle: `calculateCost(responseModel, toBillableUsage(usageDetails))`
is present, `input_cached_tokens: 1e-8` is present, and the old `2.5e-8` appears zero times.

## Deployment record

| | |
|---|---|
| Branch | `feat/prompt-caching-and-serving-research` @ `20b2fc5`, pushed to origin |
| Deployed | test.platos.dev, agent + webapp, sequentially |
| Rollback | previous tree preserved at `/opt/platos-prev` |
| Services | all six healthy; agent healthy in 20s, webapp in 20s |
| Live gate | **PASSED** — 98% steady-state cache read, 99% cross-turn |
| Verified in binary | breakpoints/volatile-vars/repair modules compiled in; `toBillableUsage` and `1e-8` present in the webapp bundle |
