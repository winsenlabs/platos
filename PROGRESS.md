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

## Next action

Land B's report, then record A's before/after numbers from a live turn.
