---
area: agent, webapp
type: fix
---

Anthropic prompt caching across the message history, plus two billing corrections.

**Agent — caching (the cost fix).** A multi-step tool turn placed a single
`cache_control` breakpoint on the system message. `streamText` then runs the tool
loop internally, appending `tool_use` / `tool_result` blocks between steps, so
that one breakpoint went stale at step 1 and every later step re-paid full price
for the entire growing history. A real turn billed 1,684,498 input tokens against
198,224 cache reads across ~12 steps — about 1.47M tokens at full price, 300.85¢
for one turn.

Breakpoints now roll forward across the message array via `prepareStep`, spending
3 of Anthropic's 4 on messages and leaving 1 on the system prompt, with
intermediate breakpoints spaced under the ~20-block lookback so a step with many
parallel tool calls cannot miss. Measured on the real code path against a fake
endpoint implementing Anthropic's documented prefix semantics: full-price tokens
127,200 → 0, billed equivalents 131,580 → 41,682 (3.16x cheaper), cache-read
share at step 12 8% → 91%. The non-streaming `run()` path had no breakpoint at
all and now has parity.

**Agent — cache-prefix stability.** Ten fixes so the prefix is byte-identical
between turns: a live millisecond timestamp no longer resolves inside the cached
system prompt; the datetime block is no longer double-rendered by the turn-time
retrieval re-assemble; tool and skill ordering is deterministic rather than
Postgres heap order; per-category tool counts are bucketed so registry churn does
not rewrite the prompt; `find_tools`' entity list is sorted; and three prefix
blocks are no longer appended a second time on a Layer-1 cache hit.

**Agent — functional fix, not a caching one.** On a warm Layer-1 prompt cache the
skill block was skipped in full, including the part that registers skill tools'
executable closures and the `find_tools` index. The agent received a system prompt
describing skill tools that were absent from its tool set: the model called one
and got `NoSuchTool`, and `find_tools` would not list it. It tracked Redis cache
warmth, so it presented as flakiness rather than breakage.

**Agent — tool-input repair.** A stringified object/array argument is now repaired
in place at the SDK's `repairToolCall` hook instead of bouncing the error back to
the model, which cost a full-price step per retry (three of them in the trace
above). Schema-driven, so a legitimately JSON-looking string argument is never
corrupted.

**Webapp — cached tokens were billed twice.** `gen_ai.usage.input_tokens` is
inclusive of the cache slice, and `calculateCost` sums usage types additively, so
cached tokens were charged at the full input rate inside `input` and again at the
cached rate. A step reading 18k of 20k context from cache billed 5.7x too much,
and the error grew as caching improved. Now normalised to a non-overlapping split
before pricing. The agent's own cost path was already correct; only this OTLP
enrichment path was affected.

**Webapp — Gemini 2.5 Flash-Lite cached-input price.** Upstream carries $0.025 per
1M cached tokens; Google publishes $0.01. Corrected via a new
`price-overrides.json`, because `defaultPrices.ts` is generated from a file synced
verbatim from Langfuse and a direct edit would be reverted by the next
`sync-prices`. The three sibling Gemini 2.5 cached prices were checked and are
already correct.
