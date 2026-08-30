---
title: "[POINT-IN-TIME] LLM serving and caching: provider paths for Platos"
lifecycle: "POINT-IN-TIME"
---

> **Lifecycle: POINT-IN-TIME.** This is a historical snapshot, not current product acceptance. Verify current truth with executable repository evidence.

# LLM serving and caching: provider paths for Platos

Workstream B research deliverable. Research performed 2026-07-30 against live vendor documentation. Every price, limit and field name below is quoted from a fetched doc page; anything that could not be confirmed from a doc is labelled **NOT CONFIRMED FROM DOCS** rather than estimated.

---

## 1. Why this exists

On 2026-07-30 a single user turn on the **Winsen Walle** agent (thread `cms72itce002llf01bz98ycta`, trace `0adb2b4070f540634d5f610f3f1bbca0`, model `anthropic:claude-sonnet-5`) cost **300.85 cents**, i.e. USD 3.0085, for one turn.

The shape of that turn:

| Metric | Value |
|---|---|
| User turns | 1 |
| Sequential LLM steps | approximately 12 |
| Tool calls | 17 |
| Wall clock | 128 seconds |
| `inputTokens` | 1,684,498 tokens |
| `cacheReadTokens` | 198,224 tokens |
| `cacheWriteTokens` | 12,389 tokens |
| Effectively billed at full input price | approximately 1,486,274 tokens (1.47M tokens) |

That is roughly 1.47M tokens billed at the full input rate inside a single turn. The arithmetic reconciles against Anthropic's published Claude Sonnet 5 introductory rates (USD 2.00 per 1M input tokens, USD 0.20 per 1M cache-read tokens, USD 2.50 per 1M 5-minute cache-write tokens, USD 10.00 per 1M output tokens; see [platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing.md)): 1.486M tokens at USD 2.00 per 1M tokens is USD 2.97, plus about USD 0.04 of cache reads, plus about USD 0.03 of cache writes, plus output, which lands on the observed USD 3.0085.

**Root cause.** Only the system prompt carried a `cache_control` breakpoint. The message array, which by step 12 was approximately 95% of the context (each step appends a `tool_use` block plus a `tool_result` block, and the 17 tool results were large), was never marked and therefore never cached. Each of the 12 steps re-sent the entire accumulated array at the full 1.0x input rate.

The counterfactual: if the accumulated prefix had been served from cache at the documented 0.1x read multiplier, the input leg of that turn would have been on the order of USD 0.30 rather than USD 2.97, i.e. roughly a 10x reduction on approximately 95% of the spend. That single number is the reason this document exists.

Two questions follow from it, and this document answers both:

1. **Where should Platos serve each model family**, given that caching mechanics, economics and feature surface differ per provider path? Sections 2.1 through 2.5, summarised in the comparison table in section 3.
2. **Will caching actually land once we place the breakpoints?** Placing breakpoints only helps if the bytes before them are stable across requests. Section 4 is a line-level audit of Platos's own prompt assembly, and it finds one defect that makes the message-array caching work merged at `e5c5bbe` a no-op from step 2 onward. Section 5 commits to per-family verdicts.

---

## 2. Provider paths

### 2.1 Anthropic API direct (api.anthropic.com; docs now served from platform.claude.com)

Anthropic direct is the reference implementation of prompt caching and the only path where the full caching feature set exists. It is the baseline every other path in this document is measured against.

#### Models offered

Claude only. The models overview ([platform.claude.com/docs/en/about-claude/models/overview](https://platform.claude.com/docs/en/about-claude/models/overview.md)) lists Claude Fable 5 (`claude-fable-5`), Claude Mythos 5 (`claude-mythos-5`, invitation only via Project Glasswing), Claude Opus 5 (`claude-opus-5`), Claude Sonnet 5 (`claude-sonnet-5`), Claude Haiku 4.5 (`claude-haiku-4-5`), plus legacy Opus 4.8/4.7/4.6/4.5, Sonnet 4.6/4.5, and deprecated Opus 4.1 (retires 2026-08-05).

Context and output: Fable 5, Opus 5 and Sonnet 5 are all 1M tokens context with 128k tokens max output; Haiku 4.5 is 200k tokens context with 64k tokens max output. On the Message Batches API, Opus 5/4.8/4.7/4.6 and Sonnet 5/4.6 support up to 300k output tokens behind beta header `output-300k-2026-03-24`.

**Not offered:** GLM, Kimi, DeepSeek, Qwen, Llama, Gemini. There is no first-party gateway, no OpenAI-compatible shim, no third-party model catalog on api.anthropic.com. Consequence for Platos: this path can only ever serve the Claude leg of routing.

Thinking support differs in a way that matters for cache invalidation: Opus 5 and Sonnet 5 support adaptive thinking (no `budget_tokens`; Fable 5 is always on), while Haiku 4.5 still uses the older `thinking.type: "enabled"` form. `effort` defaults to `high` on Opus 5 and Sonnet 5 on the Claude API.

#### Caching mechanics

Complete and explicit. Source: [platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md).

**How the key is formed.** Marking a content block with `cache_control: {"type": "ephemeral"}` creates a cache entry keyed on a hash of the entire prompt prefix up to and including that block. The prefix match must be byte-identical: "Cache hits require 100% identical prompt segments, including all text and images up to and including the block marked with cache control." Render and hash order is `tools`, then `system`, then `messages`, forming a hierarchy where a change at one level invalidates that level and everything after it. `ephemeral` is currently the only supported cache type.

**Breakpoints.** Maximum 4 per request. Cacheable block types: tool definitions in `tools`; content blocks in `system`; content blocks in `messages.content` for both user and assistant turns (text, images, documents in user turns, `tool_use` and `tool_result` in both). Not directly cacheable: thinking blocks (they are cached alongside other content when they appear in prior assistant turns, but cannot carry `cache_control` themselves), sub-content blocks such as citations (cache the top-level block instead), and empty text blocks. Passing top-level automatic caching when 4 explicit breakpoints already exist returns HTTP 400.

**TTLs.** Default 5 minutes; optional 1 hour via `cache_control: {"type": "ephemeral", "ttl": "1h"}`. When mixing, "a 1-hour cache entry must appear before any 5-minute cache entries." Mixed-TTL billing uses three positions: A is tokens at the highest cache hit (0 if none), B is tokens at the highest 1h breakpoint after A (equal to A if none), C is tokens at the last breakpoint. You are billed cache-read on A, 1h-write on (B minus A), 5m-write on (C minus B). No TTL longer than 1 hour is offered.

**Multipliers on base input price**, verbatim from the pricing page: 5-minute cache write is 1.25x; 1-hour cache write is 2.0x; cache read (hit) is 0.1x. Documented breakeven: "caching pays off after just one cache read for the 5-minute duration (1.25x write), or after two cache reads for the 1-hour duration (2x write)." These multipliers stack with the Batch API 50% discount, with the data-residency 1.1x (`inference_geo: "us"`), and with fast-mode pricing.

**Minimum cacheable prefix, per model.** Below the minimum, requests are "processed without caching, and no error is returned", i.e. a silent no-op:

| Model | Minimum cacheable prefix |
|---|---|
| Claude Opus 5 | 512 tokens |
| Claude Fable 5 | 512 tokens |
| Claude Mythos 5 | 512 tokens |
| Claude Opus 4.8 | 1,024 tokens |
| Claude Sonnet 5 | 1,024 tokens |
| Claude Sonnet 4.6 / 4.5 | 1,024 tokens |
| Claude Opus 4.7 | 2,048 tokens |
| Claude Mythos Preview | 2,048 tokens |
| Claude Opus 4.6 / 4.5 | 4,096 tokens |
| Claude Haiku 4.5 | 4,096 tokens |
| Claude Opus 4.1 (deprecated) | 1,024 tokens |
| Claude Haiku 3.5 (retired) | 2,048 tokens |

The minimum is not monotonic across generations. A 1,000 to 2,000 token prefix caches on Opus 5 and silently will not cache on Haiku 4.5. Any Platos routing rule that treats Haiku as the cheap fallback for small prompts should know it gets zero caching there.

**The 20-block lookback window**, which is the sharp edge for agent loops: "The lookback window is 20 blocks. The system checks at most 20 positions per breakpoint, counting the breakpoint itself as the first. If the system finds no matching entry in that window, checking stops (or resumes from the next explicit breakpoint, if any)." Worked example from the docs: turn 1 breakpoint at block 10 writes; turn 2 breakpoint at block 15 finds the block-10 entry (5 back, inside the window); turn 3 breakpoint at block 35 checks blocks 35 down to 16 and misses the entry at block 15. Documented failure mode: "If a growing conversation pushes your breakpoint 20 or more blocks past the last write, the lookback window misses it. Add a second breakpoint closer to that position from the start so a write accumulates there before you need it." The Walle turn at issue appended 17 tool calls, i.e. approximately 34 blocks, so it is squarely in this regime.

**Scoping and isolation.** Caches are per-model: cache diagnostics has a dedicated miss reason `model_changed`, described as "The `model` differs from the previous request (for example, a router, A/B test, or fallback selected a different model). The cache is per-model", with the remedy "Hold the model constant within a cached conversation." Caches are isolated between organizations ("Different organizations never share caches, even if they use identical prompts") and additionally isolated per workspace on the Claude API, Claude Platform on AWS, and Microsoft Foundry. Bedrock and Google Cloud use organization-level isolation only. There is no mechanism to deliberately share a cache between orgs or workspaces.

**Usage response fields**, which Platos's cost accounting must read in full:

- `usage.input_tokens`: input tokens NOT read from and NOT used to create a cache, i.e. the uncached remainder after the last breakpoint.
- `usage.cache_read_input_tokens`: tokens served from cache this request.
- `usage.cache_creation_input_tokens`: tokens written to cache this request.
- `usage.output_tokens`.
- `usage.cache_creation.ephemeral_5m_input_tokens` and `usage.cache_creation.ephemeral_1h_input_tokens`: per-TTL breakdown, present when using or mixing TTLs.
- Server-tool counters alongside: `usage.server_tool_use.web_search_requests`, `.web_fetch_requests`, `.code_execution_requests`.

Total prompt size equals `cache_read_input_tokens` plus `cache_creation_input_tokens` plus `input_tokens`, documented explicitly. Logging only `input_tokens` will under-report prompt size by roughly 10x on a well-cached agent loop. Note the contrast with Gemini in section 2.4, where the equivalent field is inclusive rather than exclusive.

**Newer caching features.**

1. **Automatic caching** (GA, and the recommended starting point). "Add a single `cache_control` field at the top level of your request. The system automatically applies the cache breakpoint to the last cacheable block and moves it forward as conversations grow." This is not zero-config implicit caching: you still must send the top-level field, and with no field at all there is no caching. Rules: no-op if the last block already carries explicit `cache_control` with the same TTL; HTTP 400 if the last block carries explicit `cache_control` with a different TTL; HTTP 400 if 4 explicit breakpoints already exist; if the last block is ineligible the system walks backward to the nearest eligible block.
2. **Cache diagnostics** (beta header `cache-diagnosis-2026-04-07`; see [platform.claude.com/docs/en/build-with-claude/cache-diagnostics](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics.md)). Send `diagnostics: {"previous_message_id": <prior response id> | null}`; the response carries a `diagnostics` object. `diagnostics.cache_miss_reason.type` is a discriminated union: `model_changed`, `system_changed`, `tools_changed`, `messages_changed`, `previous_message_not_found`, `unavailable`. The four `*_changed` types also carry `cache_missed_input_tokens`, a byte-length-derived estimate described as "a magnitude indicator rather than a billing number". Four response states: field absent (no opt-in); `null` (first turn, or no divergence found); `{"cache_miss_reason": null}` (comparison still running, inconclusive); `{"cache_miss_reason": {...}}`. In streaming, `diagnostics` arrives on the `message_start` event. Claude API only, not on Bedrock or Google Cloud. Best effort, never blocks the request. ZDR-eligible: stores only hashes plus token-count estimates keyed by response id, scoped to org plus workspace, short retention. This is the single highest-value diagnostic Platos could adopt, because every finding in section 4 maps onto one of those typed reasons.
3. **Cache pre-warming.** A `max_tokens: 0` request runs prefill and writes the cache, returning immediately with empty `content`, `stop_reason: "max_tokens"` and populated `usage` (zero output tokens billed, normal cache-write charge). Place the breakpoint on the last block shared with the real request, not on the placeholder user message.
4. **Cache-preserving escape hatches** for two things that would otherwise invalidate the prefix. Mid-conversation system messages: append `{"role": "system", ...}` to `messages[]` instead of editing top-level `system`; no beta header required; supported on Opus 5, Opus 4.8, Fable 5, Mythos 5, NOT Sonnet 5. Mid-conversation tool changes: `tool_addition` and `tool_removal` blocks with `tool_reference`, beta header `mid-conversation-tool-changes-2026-07-01`, Opus 5 onward, and the added tool must be pre-declared with `defer_loading: true`.

**Invalidation hierarchy (what survives what).**

| Change | tools cache | system cache | messages cache |
|---|---|---|---|
| Tool definitions add/remove/reorder, or non-deterministic schema serialization | invalidated | invalidated | invalidated |
| Model switch | invalidated | invalidated | invalidated |
| Web-search toggle, citations toggle, `speed` setting | survives | invalidated | invalidated |
| System prompt content change | survives | invalidated | invalidated |
| `tool_choice`, images added or removed, thinking params, effort setting | survives | survives | invalidated |
| Message content change | survives | survives | invalidated |

Other prompt-affecting params that break the cache and are only reported as `unavailable` by diagnostics: `context_management`, `output_config`, `output_format`, and the set of active `anthropic-beta` headers.

**Other operational mechanics.** Cache hits are not deducted against the rate limit ("Improve your rate limit utilization, because cache hits are not deducted against your rate limit"), so caching buys throughput headroom as well as cost. The page does not restate this as an explicit input-tokens-per-minute formula, so treat the exact accounting as documented-by-that-sentence only. Concurrency: "a cache entry only becomes available after the first response begins. If you need cache hits for parallel requests, wait for the first response before sending subsequent requests", which means N parallel identical requests all pay full write price unless a lead request goes first. Refresh: "The cache is refreshed for no additional cost each time the cached content is used", and a hit is billed at the 0.1x read rate. Whether a hit resets the TTL clock to a full 5 minutes or 1 hour is implied by the word "refreshed" but is **NOT CONFIRMED FROM DOCS** as an explicit statement. Managed Agents sessions get prompt caching automatically with the same multipliers, but the Batch API discount and fast-mode premium do not apply inside Managed Agents sessions.

#### Pricing

All figures USD per 1M tokens (MTok), from [platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing.md). Columns: base input, 5-minute cache write, 1-hour cache write, cache hit plus refresh, output.

| Model | Input | 5m write | 1h write | Cache hit | Output |
|---|---|---|---|---|---|
| Claude Opus 5 (`claude-opus-5`) | 5.00 | 6.25 | 10.00 | 0.50 | 25.00 |
| Claude Opus 4.8 (`claude-opus-4-8`) | 5.00 | 6.25 | 10.00 | 0.50 | 25.00 |
| Claude Opus 4.7 / 4.6 / 4.5 | 5.00 | 6.25 | 10.00 | 0.50 | 25.00 |
| Claude Sonnet 5, through 2026-08-31 (introductory) | 2.00 | 2.50 | 4.00 | 0.20 | 10.00 |
| Claude Sonnet 5, from 2026-09-01 (standard) | 3.00 | 3.75 | 6.00 | 0.30 | 15.00 |
| Claude Sonnet 4.6 / 4.5 | 3.00 | 3.75 | 6.00 | 0.30 | 15.00 |
| Claude Haiku 4.5 (`claude-haiku-4-5`) | 1.00 | 1.25 | 2.00 | 0.10 | 5.00 |
| Claude Fable 5 (`claude-fable-5`) | 10.00 | 12.50 | 20.00 | 1.00 | 50.00 |
| Claude Mythos 5 (limited availability) | 10.00 | 12.50 | 20.00 | 1.00 | 50.00 |
| Claude Opus 4.1 (deprecated, retires 2026-08-05) | 15.00 | 18.75 | 30.00 | 1.50 | 75.00 |

**Timing flag.** Today is 2026-07-30. Sonnet 5's USD 2.00 per 1M input tokens / USD 10.00 per 1M output tokens introductory rate expires in approximately 32 days (2026-08-31) and becomes USD 3.00 / USD 15.00 on 2026-09-01, a +50% step change on both legs. Platos's cost catalog needs a **dated** entry for Sonnet 5, not a constant. Walle runs on `anthropic:claude-sonnet-5`, so that 300.85-cent turn becomes roughly 451 cents on the same traffic after 2026-09-01 if nothing is cached.

**Batch API**, flat 50% off input and output, stacking with caching multipliers: Opus 5 at USD 2.50 per 1M input tokens / USD 12.50 per 1M output tokens; Sonnet 5 at USD 1.00 / USD 5.00 through 2026-08-31 then USD 1.50 / USD 7.50; Haiku 4.5 at USD 0.50 / USD 2.50; Fable 5 at USD 5.00 / USD 25.00.

**Other price modifiers relevant to a routing decision.**

- Long context: Claude 4.6 and later include the full 1M-token context window at standard pricing, with no long-context premium tier. "A 900k-token request is billed at the same per-token rate as a 9k-token request." Caching and batch discounts apply at standard rates across the full window.
- Data residency: `inference_geo: "us"` applies a 1.1x multiplier on all token categories including cache writes and cache reads (Claude 4.6 and later). `inference_geo: "global"` is the default at standard price. Earlier models return HTTP 400 on the parameter.
- Fast mode (research preview, Claude API only, Opus 5 and Opus 4.8 only): USD 10.00 per 1M input tokens / USD 50.00 per 1M output tokens, with caching multipliers applying on top. Not available with the Batch API. Errors on Opus 4.7.
- Web search: USD 10.00 per 1,000 searches plus token costs. Web fetch: no additional charge. Code execution: free when used with `web_search_20260209` or later / `web_fetch_20260209` or later; otherwise 1,550 free container-hours per org per month, then USD 0.05 per hour per container with a 5-minute minimum.
- Managed Agents: tokens at standard model rates plus USD 0.08 per session-hour, metered only while status is `running`.
- Tool-use system-prompt overhead is per-model and material for small requests: Opus 5 is 286 tokens (`auto` or `none`) or 406 tokens (`any` or `tool`); Sonnet 5 is 354 or 474 tokens; Opus 4.7 is 675 or 804 tokens.
- Tokenizer caveat: Claude 4.7 and later use a newer tokenizer producing "approximately 30% more tokens for the same text" versus Sonnet 4.6 and earlier. Per-token price parity does not mean per-request cost parity. Re-baseline with `count_tokens` per model rather than comparing sticker prices.

#### Auth, regions, latency

**Auth.** API key via `x-api-key: $ANTHROPIC_API_KEY` plus `anthropic-version: 2023-06-01`, which is the simplest option for a server-side runtime like Platos. OAuth via `Authorization: Bearer <token>` plus header `anthropic-beta: oauth-2025-04-20`; note this is a header change, not a key swap, so an OAuth token sent on `x-api-key` returns HTTP 401, and tokens are short-lived and not auto-refreshed when passed via env var. Workload Identity Federation activates when `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID` and `ANTHROPIC_IDENTITY_TOKEN_FILE` or `ANTHROPIC_IDENTITY_TOKEN` are all set; the SDK exchanges the JWT at `/v1/oauth/token` and auto-refreshes. That is the documented path for CI, servers and containers instead of interactive login, and it is directly relevant if Platos wants to stop shipping static keys to the VPS.

SDK credential precedence, first match wins: `ANTHROPIC_API_KEY`, then `ANTHROPIC_AUTH_TOKEN`, then the `ANTHROPIC_PROFILE`-selected or active OAuth profile, then WIF env vars, then the default on-disk profile. A stale exported `ANTHROPIC_API_KEY` silently shadows everything else, including when set to an empty string. Setting both `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` makes the SDK send both headers and the API rejects the request with HTTP 401.

**Cache-relevant auth detail.** Cache isolation is per workspace on the Claude API, and cache-diagnostics fingerprint lookup requires "an API key from the same organization and workspace." Which key Platos uses therefore determines which cache pool it hits. If Platos issues per-tenant keys or per-tenant workspaces, tenants cannot share a cached system prompt; if it wants shared-prefix reuse across tenants, that traffic must go through one workspace. This intersects directly with the existing scope-tuple and operator-tier boundary work.

**Regions.** The first-party Claude API is global by default; there is no per-region endpoint hostname, everything goes to api.anthropic.com. Residency control is a request parameter, not an endpoint: `inference_geo: "us"` pins inference to the US at a 1.1x multiplier on every token category including cache reads; `inference_geo: "global"` is the default at standard price; supported on Claude 4.6 and later, with earlier models returning HTTP 400 if the parameter is present. It is a top-level request field, not an `extra_body` key. `response.usage.inference_geo` reports where inference actually ran. Partner clouds are the alternative for hard region pinning, at a 10% premium and at the cost of losing automatic caching, cache diagnostics, Batches and the Models API.

**Latency.** Anthropic publishes no datacenter locations, no per-region endpoint hostnames and no latency or time-to-first-token figures for the first-party API. Any claim about measured latency from Render or Trigger.dev to api.anthropic.com is **NOT CONFIRMED FROM DOCS** and must be measured by Platos rather than asserted. Structurally favourable: Platos compute is already US-hosted and default global routing from a US egress adds no cross-ocean hop from Platos's own placement.

Documented latency levers that are relevant: cache pre-warming via `max_tokens: 0` exists specifically to "eliminate the cache-miss latency penalty on the first user interaction"; the concurrency rule means parallel fan-out must lead with one request or every branch pays cold-write latency; `effort` (`low` through `max`) is the primary latency and cost dial on Opus 5 and Sonnet 5, both defaulting to `high`; fast mode gives up to approximately 2.5x higher output tokens per second on Opus 5 and Opus 4.8 at USD 10.00 / USD 50.00 per 1M tokens, Claude API only, with its own separate rate-limit pool, and switching `speed` invalidates the prompt cache; SDK client timeout defaults to 10 minutes, and units differ by SDK (the TypeScript SDK takes milliseconds).

**Rate limits.** Managed Agents endpoints have their own per-org requests-per-minute limits separate from Messages token limits (300 RPM create, 600 RPM other, environments 60 RPM, max 5 concurrent). Claude Opus 5 draws on a separate rate-limit bucket from the combined Opus 4.x pool, so shifting Platos traffic from Opus 4.8 to Opus 5 neither inherits nor frees the old headroom. Fast mode has its own limit again.

#### Feature gaps

There are effectively no feature gaps on this path, because it is the baseline. Confirmed available: Message Batches API (50% discount, stacks with caching, not available on Bedrock or Google Cloud); token counting via `POST /v1/messages/count_tokens`; the full tool-use surface (client tools, strict tool use, parallel tool use, programmatic tool calling, tool search, server tools for web search / web fetch / code execution, MCP connector); full SSE streaming with `diagnostics` on `message_start`; the Models API (`GET /v1/models`) for live capability and context-window discovery; prompt caching in both automatic and explicit form with 5m and 1h TTLs plus cache diagnostics.

Features that are Claude-API-first-party only, i.e. that Platos loses if it routes Claude through a partner cloud: automatic prompt caching, cache diagnostics (beta), fast mode, `inference_geo` data residency, Message Batches, the Models API, mid-conversation system messages, web fetch, code execution, Agent Skills, MCP connector, Managed Agents.

The real gaps are the ones any single-vendor path has:

1. No non-Claude models at all, so Platos cannot consolidate onto this single upstream.
2. Caching is per-model, which puts Platos's own model-routing and fallback logic in direct tension with cache economics.
3. Caching is per-workspace, which caps cache reuse across Platos tenants if tenants map to workspaces or separate keys.
4. No fully implicit caching. Platos must actively emit `cache_control`; a naive passthrough gets zero cache benefit and pays full input price. This is precisely the Walle failure.
5. Max 4 breakpoints and a 20-block lookback are hard ceilings that agent loops can and do exceed.

#### Migration effort

Platos already speaks the Anthropic Messages API, so routing Claude traffic here is not a protocol migration. The work is entirely in making caching fire and in keeping the routing layer from destroying it.

**Low effort, high return.**

1. Emit `cache_control` at all. The cheapest correct move is top-level automatic caching, which auto-places the breakpoint on the last cacheable block and advances it as the thread grows, with no breakpoint bookkeeping in Platos.
2. Log the full usage triple, not `input_tokens`. `monitoring_cost_*` rollups must read `cache_read_input_tokens`, `cache_creation_input_tokens`, `input_tokens` and (when TTLs are mixed) the `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` breakdown, priced at 0.1x, 1.25x or 2.0x, and 1.0x respectively.
3. Add a dated price table entry for Sonnet 5 (USD 2.00 / USD 10.00 per 1M tokens through 2026-08-31, USD 3.00 / USD 15.00 from 2026-09-01) rather than a constant.

**Medium effort, architectural, and this is the real work.**

4. Freeze the prefix. Platos's known invalidator classes map exactly onto the documented `cache_miss_reason` types: any timestamp, session id or user name interpolated into the system prompt is `system_changed`; non-deterministic tool serialization or a per-agent varying tool set is `tools_changed`; rewriting, truncating or re-serializing history and `tool_result` blocks is `messages_changed`. Concretely: serialize tool schemas with sorted keys and a stable order, keep the system prompt byte-stable, and move dynamic context after the last breakpoint. Section 4 enumerates 10 live violations.
5. Reconcile caching with model routing. Caches are per-model and `model_changed` explicitly names "a router, A/B test, or fallback selected a different model" as a cause. Either pin the model for the life of a cached thread and spawn a separate call for cheaper sub-work, or accept cold writes on reroute and stop attributing that cost to the model itself.
6. Fix the fork path. Memory extraction, summarization and sub-agent spawns build their own requests; unless they copy the parent's `model`, `system` and `tools` verbatim they miss the parent's cache entirely and pay a full cold write.
7. Handle the 20-block lookback in agent loops. Mitigation is an intermediate breakpoint roughly every 15 blocks in long turns, but there are only 4 breakpoints total, so this is a budget to allocate deliberately rather than a free knob.
8. Decide the cache-tenancy model explicitly. Caches never cross organizations and, on the Claude API, never cross workspaces.
9. Pick TTLs per workload. The 5-minute default suits chat turns arriving inside 5 minutes (breakeven after one read). The 1-hour TTL at 2.0x write only pays after two reads, so it is worth it for bursty or scheduled workloads with gaps longer than 5 minutes; Trigger.dev-driven cron and agent runs are exactly that shape. If mixing, the 1h breakpoint must precede any 5m breakpoint.
10. Fan-out ordering. Because an entry is only readable after the first response begins, `agent_batch` and spawn fan-out should lead with one request and release the rest after first byte.

**Optional but valuable.**

11. Adopt cache diagnostics in staging or behind a flag. It turns "cache_read is zero and we do not know why" into a typed answer, and it is ZDR-eligible. Beta caveat: field names may change before GA, and it is Claude API only.
12. Pre-warm long shared prefixes with `max_tokens: 0` at worker boot or post-deploy. Worth it only where first-request latency is user-visible and there is a quiet moment before traffic.
13. Use the two cache-preserving escape hatches instead of rebuilding the prefix. Appending `{"role": "system", ...}` to `messages[]` covers mid-thread operator instructions (Opus 5, Opus 4.8, Fable 5, Mythos 5, NOT Sonnet 5; catch the HTTP 400 and fall back to a user-turn reminder). `tool_addition` and `tool_removal` blocks cover changing the tool set mid-thread. Both map directly onto Platos's dynamic prompt-blocks and per-entity tool ACL behaviour, which today each force a full cache rebuild (see section 4, findings 6, 7 and 10).
14. Re-baseline token counts with `count_tokens` per model.

---

### 2.2 Claude on Google Vertex AI (docs now branded "Gemini Enterprise Agent Platform")

Vertex is a near drop-in second Claude path. The Messages API wire format is identical except that `model` moves out of the body into the URL and `anthropic_version: "vertex-2023-10-16"` goes into the body. `cache_control` passes through byte-identical with identical multipliers, which is the single biggest argument for Vertex being a low-risk second Claude leg.

Note on URLs: `cloud.google.com/vertex-ai/...` now 301-redirects to `docs.cloud.google.com/gemini-enterprise-agent-platform/...`. Both forms appear below because both were fetched.

#### Models offered

Claude on Vertex is on the "partner models" track and is GA and healthy, unaffected by the open-model retirement described in section 2.3.

Anthropic's published Vertex ID table ([platform.claude.com/docs/en/api/claude-on-vertex-ai](https://platform.claude.com/docs/en/api/claude-on-vertex-ai)): `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-sonnet-4-5@20250929`, `claude-sonnet-4@20250514` (deprecated), `claude-3-7-sonnet@20250219` (retired), `claude-opus-4-5@20251101`, `claude-opus-4-1@20250805` (deprecated), `claude-opus-4@20250514` (deprecated), `claude-haiku-4-5@20251001`, `claude-3-5-haiku@20241022` (deprecated).

Google's own request-predictions page ([docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/use-claude](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/use-claude)) lists the same models **without** the `@date` suffix. The two docs disagree on the 4.5-era forms, so encode the mapping per model rather than deriving it, and verify against a live call.

Claude Opus 4, Sonnet 4 and Haiku 3.5 are retired on the first-party API but explicitly still live on Google Cloud. Lifecycle dates on Vertex are set by Google, not Anthropic; Claude Sonnet 5's retirement on Vertex is stated as "Not sooner than December 24, 2026". Only `claude-3-haiku` is deprecated on the partner track (deprecated 2026-02-23, shutdown 2026-08-23, existing customers only).

Context windows: 1M tokens for Fable 5, Opus 5, Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 5 and Sonnet 4.6; 200k tokens for everything else. Sonnet 5 max output is 128,000 tokens. Request payloads are capped at 30 MB regardless of token limits. Claude Mythos Preview is a research preview on Vertex, invited customers only.

Strategically relevant: the same GCP credential also reaches GLM, Kimi, DeepSeek, Qwen, Llama, MiniMax, Grok, gpt-oss and Mistral as Model Garden MaaS models. That looks like one-credential consolidation, and section 2.3 explains why it is not.

#### Caching mechanics

Supported, with the identical wire format. Source: [docs.cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/prompt-caching](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/prompt-caching) (last updated 2026-07-29).

Mechanism, verbatim: "Caching automatically occurs when subsequent requests contain the identical text, images, and cache_control parameter as the first request. All requests must also include the cache_control parameter in the same blocks." So you send exactly the breakpoints you would send to api.anthropic.com. There is no Vertex-specific caching field and no separate cache-create call.

TTL, verbatim: "By default, the cache has a five-minute lifetime or time to live (TTL). You can extend the TTL to one hour by setting "ttl": "1h" within the cache_control object. The cache lifetime is refreshed each time the cached content is accessed." Note that Google states the refresh-on-access semantics more explicitly than Anthropic's own page does. The 1h TTL is unsupported on four legacy models only: Claude 3.7 Sonnet, Claude 3.5 Sonnet v2, Claude 3.5 Sonnet, Claude 3 Opus. Every current model supports it.

Multipliers, verbatim: "Cache write tokens with a five-minute lifetime are 25% more expensive than base input tokens. Cache write tokens with a one-hour lifetime are 100% more expensive than base input tokens. Cache read tokens are 90% cheaper than base input tokens." That is 1.25x, 2.0x and 0.1x, numerically identical to Anthropic direct, and the absolute per-MTok cache prices on the global endpoint are identical too.

Vertex-specific semantics worth logging:

- Cache locality is per GCP project: "Caches are unique to your Google Cloud project and cannot be used by other projects." A multi-tenant Platos deployment sharing one GCP project therefore shares one cache namespace, which is a different tenancy shape from Anthropic's per-workspace isolation.
- Cache keys are hashes: "Claude computes the hashes (fingerprints) of requests for caching keys. These hashes are only computed for requests that have caching enabled." Google classifies these as "User Metadata" / customer "Service Data" under the Google Cloud Privacy Notice, NOT "Customer Data" under the Cloud Data Processing Addendum, and states that "additional protections for 'Customer Data' don't apply to these hashes."
- Caching can be hard-disabled per project by contacting Google support; after that, "requests from the project with prompt caching enabled are rejected." So a customer whose own GCP project has it disabled produces rejections, not silent degradation.
- Quota interaction: input tokens-per-minute quota for current models counts "uncached and cache write" tokens only. Cache-read tokens do not burn input TPM, so heavy caching buys rate-limit headroom as well as cost.
- Provisioned Throughput burndown honours the same multipliers: 1 input token counts as 1 token, 1 output token as 5 tokens, 1 five-minute cache-write token as 1.25 tokens, 1 one-hour cache-write token as 2 tokens, 1 cache-hit token as 0.1 tokens.

**NOT CONFIRMED FROM DOCS:** the per-model minimum cacheable token counts on Vertex, and whether the Vertex response returns the same `cache_creation_input_tokens` and `cache_read_input_tokens` usage field names. Google's page defers both to Anthropic's own prompt-caching page. Verify the usage field names empirically before wiring cost accounting; getting this wrong silently mis-prices every cached turn.

#### Pricing

All figures USD per 1M tokens, from [cloud.google.com/vertex-ai/generative-ai/pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing) and [cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing), cross-checked against Anthropic's pricing page.

**Global endpoint, at exact parity with Anthropic direct on every model and every cache column:**

| Model (global endpoint) | Input | 5m write | 1h write | Cache hit | Output | Batch in / out |
|---|---|---|---|---|---|---|
| Claude Sonnet 5, through 2026-08-31 | 2.00 | 2.50 | 4.00 | 0.20 | 10.00 | 1.00 / 5.00 |
| Claude Sonnet 5, from 2026-09-01 | 3.00 | 3.75 | 6.00 | 0.30 | 15.00 | 1.50 / 7.50 |
| Claude Sonnet 4.6 | 3.00 | 3.75 | 6.00 | 0.30 | 15.00 | 1.50 / 7.50 |
| Claude Sonnet 4.5, prompts up to 200k tokens | 3.00 | 3.75 | 6.00 | 0.30 | 15.00 | 1.50 / 7.50 |
| Claude Sonnet 4.5, prompts over 200k tokens | 6.00 | 7.50 | 12.00 | 0.60 | 22.50 | not listed |
| Claude Opus 5 / 4.8 / 4.7 / 4.6 / 4.5 | 5.00 | 6.25 | 10.00 | 0.50 | 25.00 | 2.50 / 12.50 |
| Claude Fable 5 | 10.00 | 12.50 | 20.00 | 1.00 | 50.00 | 5.00 / 25.00 |
| Claude Haiku 4.5 | 1.00 | 1.25 | 2.00 | 0.10 | 5.00 | 0.50 / 2.50 |
| Claude Opus 4.1 / Opus 4 (deprecated) | 15.00 | not listed | not listed | not listed | 75.00 | not listed |

Batch cache columns are published for some models: Sonnet 4.6 batch 5m write USD 1.88, batch 1h write USD 3.00, batch hit USD 0.15 per 1M tokens; Opus 5 batch 5m write USD 3.125, batch 1h write USD 5.00, batch hit USD 0.25 per 1M tokens. Claude web search tool on Vertex is USD 10.00 per 1,000 searches, the same as direct.

Note that Sonnet 4.5 carries a long-context premium above 200k tokens on Vertex, while Sonnet 5 and Opus 5 have no such premium.

**Regional and multi-region premium is exactly 1.1x global, applied to every token category including cache reads and writes.** US Multi-Region (`us`) and EU Multi-Region (`eu`) are priced identically to each other. Sonnet 5 promotional: USD 2.20 input / USD 11.00 output, 5m write USD 2.75, 1h write USD 4.40, hit USD 0.22, batch USD 1.10 / USD 5.50 per 1M tokens. Sonnet 5 standard: USD 3.30 / USD 16.50, 5m write USD 4.125, 1h write USD 6.60, hit USD 0.33. Opus 5 / 4.8 / 4.7: USD 5.50 / USD 27.50, 5m write USD 6.875, 1h write USD 11.00, hit USD 0.55. Fable 5: USD 11.00 / USD 55.00, 5m write USD 13.75, 1h write USD 22.00, hit USD 1.10. Anthropic's doc states this as "Regional and multi-region endpoints include a 10% pricing premium over global endpoints" scoped to "Claude Sonnet 4.5, Haiku 4.5, Opus 4.5, and all future models"; earlier models keep legacy pricing. Anthropic's own `inference_geo: "us"` 1.1x is a first-party, AWS and Foundry mechanism; on Vertex the equivalent is choosing the `us` multi-region endpoint, and Anthropic notes "Partner-operated platforms (Bedrock and Google Cloud) have independent regional pricing."

**Non-Claude models on the same Vertex billing path** (see section 2.3 for why these are a dead end): GLM-5 at USD 1.00 input / USD 3.20 output / USD 0.10 cache hit; GLM-4.7 at USD 0.60 / USD 2.20 with no cache-hit rate published; Kimi-K2-Thinking at USD 0.60 / USD 2.50 / USD 0.06 hit; DeepSeek-V3.2 at USD 0.56 / USD 1.68 / USD 0.056 hit; DeepSeek-V3.1 at USD 0.60 / USD 1.70 / USD 0.06 hit; DeepSeek-R1 (0528) at USD 1.35 / USD 5.40; DeepSeek-OCR at USD 0.30 / USD 1.20; Qwen3-Coder-480B-A35B-Instruct at USD 0.22 / USD 1.80 / USD 0.022 hit; Qwen3-235B-A22B-Instruct-2507 at USD 0.22 / USD 0.88; Qwen3-Next-80B Instruct and Thinking at USD 0.15 / USD 1.20; MiniMax-M2 at USD 0.30 / USD 1.20 / USD 0.03 hit; Llama 3.3 70B at USD 0.72 / USD 0.72; Llama 4 Scout at USD 0.25 / USD 0.70; Llama 4 Maverick at USD 0.35 / USD 1.15; gpt-oss-120b at USD 0.09 / USD 0.36; gpt-oss-20b at USD 0.07 / USD 0.25 / USD 0.007 hit; Mistral Medium 3 at USD 0.40 / USD 2.00; Mistral Small 3.1 at USD 0.10 / USD 0.30; Codestral 2 at USD 0.30 / USD 0.90; Grok 4.3 and 4.20 at USD 1.25 / USD 2.50 / USD 0.20 hit up to 200k tokens input and USD 2.50 / USD 5.00 / USD 0.40 hit above; Grok 4.1 Fast at USD 0.20 / USD 0.50 / USD 0.05 hit. All per 1M tokens.

**Provisioned Throughput for Claude** is sold as a fixed-term subscription (1 week, 1 month, 3 months, 1 year). Throughput per GSU in tokens per second, input plus output combined: Sonnet 5 350 tokens/s per GSU with a 25 GSU minimum and increment 1; Opus 5 210 tokens/s per GSU, minimum 1 GSU; Fable 5 105 tokens/s per GSU, minimum 1; Opus 4.8 / 4.7 / 4.6 / 4.5 210 tokens/s per GSU, minimum 35; Sonnet 4.6 / 4.5 350 tokens/s per GSU, minimum 25; Haiku 4.5 1,050 tokens/s per GSU, minimum 8; Opus 4.1 / Opus 4 70 tokens/s per GSU, minimum 35. The GSU dollar price for Claude is not published: "To order Provisioned Throughput for Anthropic models, contact your Google Cloud account representative."

#### Auth, regions, latency

**Auth.** Google OAuth2 bearer tokens, not Anthropic API keys. Requests carry `Authorization: Bearer $(gcloud auth print-access-token)`. Locally that is Application Default Credentials; in server infra it is a service account whose credentials the Google auth library exchanges for short-lived access tokens. The official SDKs (`anthropic[vertex]`, `@anthropic-ai/vertex-sdk`, `github.com/anthropics/anthropic-sdk-go/vertex`) wrap this via the standard google-auth-library flow. Practical consequence: this is not a static-secret provider. The credential is a service-account JSON blob plus a token minter, not a key string.

Onboarding gates beyond credentials: `aiplatform.googleapis.com` must be enabled (requires `serviceusage.services.enable`, via Owner or `roles/serviceusage.serviceUsageAdmin`), and each Claude model must be explicitly enabled by clicking Enable on its Model Garden card and accepting Terms of Service. Two hard blockers to know about: "Anthropic enforces policies that prohibit certain resellers from reselling their products. If your Google Cloud billing account is managed by a prohibited reseller, you will be unable to accept the Terms of Service or enable Claude models." And inside an Assured Workloads boundary you may need exceptions for `cloudcommerceconsumerprocurement.googleapis.com` and `commerceagreement.googleapis.com`.

**Endpoints**, three types with different hostnames:

- Global: `https://aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/global/publishers/anthropic/models/{MODEL}:rawPredict`. Dynamic routing to whatever region has capacity, no pricing premium, pay-as-you-go only.
- Multi-region: `https://aiplatform.us.rep.googleapis.com` or `https://aiplatform.eu.rep.googleapis.com`, with location `us` or `eu`. 1.1x price. Data residency within the geography.
- Regional: `https://{LOCATION}-aiplatform.googleapis.com`, e.g. `us-east5`, `europe-west1`, `asia-southeast1`. 1.1x price.

Critical region constraint: the newest models have no single-region endpoints. Anthropic states "Specific regional endpoints support Claude Sonnet 4.6 and earlier; newer models use the global or multi-region endpoints", and Google's Sonnet 5 page confirms availability only on US Multi-region, Europe Multi-region and the global endpoint. Sonnet 4.6, Opus 4.6/4.5 and Haiku 4.5 do have `us-east5`, `europe-west1` and `asia-southeast1` regional endpoints.

Streaming works via `:streamRawPredict` with `"stream": true` in the body; `:rawPredict` is the unary form.

**Latency.** No published latency numbers, percentiles or SLOs exist in any doc fetched, so quantitative latency is **NOT CONFIRMED FROM DOCS**. What the docs do establish structurally matters, though: the global endpoint provides "maximum availability and uptime" by dynamically routing "to regions with available capacity", and Sonnet 5's ML processing locations are US Multi-region, Europe Multi-region and Asia Pacific `asia-southeast1`. A US-origin request on the global endpoint can therefore legitimately be served from Europe or Singapore, which is a real tail-latency risk for interactive chat turns. Pinning `us` multi-region removes that risk but costs 1.1x on every token category including cache reads, so a caching-heavy workload pays the premium on its cheapest tokens too. Geographic containment is guaranteed only for geo-scoped endpoints: "ML processing for all available Anthropic models occurs within the US when requests are made to regionally-available APIs in the US, or within the EU when requests are made to regionally-available APIs in Europe."

One extra hop exists that Anthropic direct does not have: every call needs a valid Google access token, so a cold path may include a token mint before the model call. Cache the token; this is exactly the shape of the previously logged inline-embedding latency incident, where an un-timeboxed pre-LLM await stalled every turn.

**Quotas.** Two systems split by launch date. Models launched after 2026-05-26 use shared model-lineage quotas: "A single quota limit is shared across all model versions in a model lineage for a given location", with buckets `anthropic-claude-opus`, `anthropic-claude-sonnet`, `anthropic-claude-haiku`, `anthropic-claude-fable`, and metrics `global_online_prediction_requests_per_base_model`, `global_online_prediction_input_tokens_per_minute_per_base_model`, `global_online_prediction_output_tokens_per_minute_per_base_model` plus `{LOCATION}_multi_region_...` variants. Global and each multi-region are independent buckets: "Usage on the global endpoint doesn't consume quota on a multi-region endpoint." Upside: "Adding a new version of a lineage doesn't require a new quota request." Downside: Opus 5 and Opus 4.8 contend for one bucket.

Default limits from Google's quota table ([docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/quotas](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/quotas)): Sonnet 5 global 2,500 queries per minute, 25,000,000 input tokens per minute (uncached and cache write), 2,500,000 output tokens per minute; Sonnet 5 per multi-region 1,250 QPM / 12.5M input TPM / 1.25M output TPM; Opus 5 global 2,000 QPM / 20M / 2M; Fable 5 global 2,000 QPM / 20M / 2M; Opus 4.8 global 2,000 QPM / 20M / 2M; Opus 4.7 global 800 QPM / 8M / 800k; Sonnet 4.6 global 1,500 QPM / 1.5M / 150k (us-east5 1,500 QPM, europe-west1 1,800 QPM); Haiku 4.5 global 2,500 QPM / 2.5M / 250k; Opus 4.5 global 400 QPM / 4M / 400k; legacy Opus 4 and 4.1 are 25 QPM / 60k input TPM. For current models these defaults are considerably more generous than typical first-party tiers.

Two operational gotchas: input TPM counts only uncached plus cache-write tokens, and "the token usage reported on the Quota page in the Google Cloud console might be inaccurate" because of "a complex token estimation and refund system", so use the count-tokens API or `token_count` metrics in Metrics Explorer for real accounting.

**Discrepancy to flag.** Anthropic's doc says provisioned throughput "requires regional endpoints" and that global and multi-region "Only supports pay-as-you-go traffic", but Google's Sonnet 5 model page lists Provisioned Throughput as supported with model availability "(Includes fixed quota & Provisioned Throughput)" for US multi-region, Europe multi-region and the global endpoint. The two docs conflict. Confirm with a Google representative before designing around PT.

#### Feature gaps

From Anthropic's official "Features not supported" list for Google Cloud:

- Input sources: URL sources for images and documents, and the Files API, are unavailable. Content must be inlined as base64.
- Server-side tools: code execution, web fetch and advisor are unavailable. Web search **is** supported.
- Agent infrastructure: Agent Skills, MCP connector and programmatic tool calling are unavailable. Relevant for Platos: if any logic relies on Anthropic's server-side MCP connector, it must stay client-side on Vertex. Platos runs its own MCP gateway, so this is likely already fine, but it needs confirming.
- API endpoints: Message Batches, Models (model listing), Admin, Compliance, and Usage & Cost are unavailable. No `/v1/models` discovery and no Anthropic-side usage or cost reporting.
- Claude Managed Agents: unavailable.
- Server-side fallback (the `fallbacks` parameter): unavailable; Anthropic directs you to the client-side fallback pattern.
- Fast mode: "available on the Claude API (first-party) only; it is not available on Claude Platform on AWS or partner-operated cloud platforms."

Supported with no gap: Messages API, prompt caching including 1h TTL, extended thinking, tool use including Bash / Computer use / Memory / Text editor tools, web search tool, citations, structured outputs, streaming.

Google-native substitutes exist for two of the missing endpoints, with a different wire shape, so they are adapter work rather than true gaps:

- Token counting: `POST https://{LOCATION}-aiplatform.googleapis.com/v1/projects/{PROJECT_ID}/locations/{LOCATION}/publishers/anthropic/models/count-tokens:rawPredict`, with `model` inside the JSON body, returning `{ "input_tokens": 14 }`. "There is no cost for using the count-tokens endpoint." Default quota 2,000 requests per minute. Supported regions `global`, `us`, `eu`, `asia-southeast1`. Different path and body from Anthropic's `/v1/messages/count_tokens`.
- Batch: Google's `batchPredictionJobs` API, input from a BigQuery table or a JSONL file in Cloud Storage, records shaped `{"custom_id": "...", "request": {"messages": [...], "anthropic_version": "vertex-2023-10-16", "max_tokens": 50}}`. The 50% batch discount is published per model. Limits: "By default, the number of concurrent batch requests that you can make in a single project is 4", the batch job and table must be in the same region, and "The global endpoint for partner models isn't supported" for Cloud Storage batch input. Reserved output columns `response(JSON)` and `status`. Materially heavier than Anthropic's Message Batches API.

#### Migration effort

Small to moderate for the request path, concentrated almost entirely in credentials rather than message translation.

1. **Request shaping (small).** Reuse the existing Anthropic message builder verbatim, then apply two transforms: delete `model` from the body and interpolate it into the URL path; add `anthropic_version: "vertex-2023-10-16"` to the body. Or drop in `@anthropic-ai/vertex-sdk`'s `AnthropicVertex` client, which takes `{ projectId, region }` and handles all of it.
2. **Credentials (the real work).** Platos's BYOK model stores provider API key strings; Vertex needs a GCP service-account JSON key or workload identity plus token exchange via google-auth-library, producing access tokens that expire and must be cached and refreshed. That is a new credential **kind** in the provider/keys schema, not another row in the existing API-key table, plus a per-scope token cache so a token is not minted per turn. `projectId` and `location` also become first-class provider config fields.
3. **Model-ID mapping table (small but mandatory).** Current models are clean (`claude-sonnet-5`, `claude-opus-5`) while 4.5-era models are `claude-sonnet-4-5@20250929` per Anthropic and `claude-sonnet-4-5` per Google. Encode per model; verify the 4.5-era forms against a live call.
4. **Endpoint and region policy (small).** `global` is the right default for cost and availability given Platos runs US infra; `us` becomes an opt-in for customers with residency requirements, at 1.1x on every token category including cache reads.
5. **Feature-gap guards (moderate, depends on current usage).** Audit for Files API or URL image/document sources, server-side web fetch or code execution, Anthropic's MCP connector, Agent Skills, the `fallbacks` parameter, fast mode, and `/v1/models` discovery. Each needs a client-side substitute or a capability flag that disables it on the Vertex route.
6. **Batch and token counting (moderate if used).** Any use of Anthropic Message Batches would be rewritten onto `batchPredictionJobs` with BigQuery or GCS input/output, 4 concurrent jobs per project, region-pinned, no global endpoint. `count_tokens` swaps to `count-tokens:rawPredict`.
7. **Cost accounting (small, but verify first).** Add Vertex-specific rate entries for the 1.1x regional premium and the Sonnet 4.5 above-200k tier. Before trusting the ledger, empirically confirm the `usage` field names on the Vertex path.
8. **What comes free.** `cache_control` passes through byte-identical with identical multipliers, so the entire Platos caching strategy is portable with zero changes. Tool use, thinking, citations, structured outputs and streaming all carry over.

**NOT CONFIRMED FROM DOCS:** whether an existing Anthropic-direct organization discount or rate-limit tier carries to Vertex. It does not appear to; Google invoices you and Anthropic's doc says "Data handling for this offering is governed by Google Cloud."

---

### 2.3 Vertex AI Model-as-a-Service (Model Garden partner and open models: GLM, Kimi, DeepSeek, Qwen, Llama)

All five families are currently offered as fully managed pay-per-token MaaS endpoints on Vertex, callable through one OpenAI-compatible `/chat/completions` path. The decisive fact is a hard stop.

#### Hard blocker: the open-model MaaS lineup is being withdrawn

On **2026-07-21**, nine days before this research, Google deprecated the entire open-model MaaS lineup, with **retirement on 2026-10-21**, after which "API requests calling a retired model ID will fail." Source: [docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/open-models](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/open-models).

That retirement list includes `glm-5-maas`, `glm-4.7-maas`, `kimi-k2-thinking-maas`, all four DeepSeek IDs, all four Qwen3 IDs, `llama-3.3-70b-instruct-maas`, `minimax-m2-maas`, `gpt-oss-20b-maas`, and both `multilingual-e5-*` embedding models.

Google's own definition of the deprecation state Platos would be entering: "During the deprecation period, the model endpoint remains functional for existing workloads so that you can plan and implement migrations, but no new features or updates are added and new use of the endpoint may be restricted." Platos is not an existing workload. Onboarding GLM or Kimi here may be blocked outright, and is guaranteed to break on 2026-10-21. No feature or price comparison outranks this.

The only documented forward paths are self-deploying each model on Model Garden (renting GPUs, abandoning pay-per-token, adding capacity planning and idle cost) or "migrate your workloads to alternative managed endpoints."

Claude on Vertex is a **separate** partner-models track and is not affected. See section 2.2.

#### Models offered

- **GLM** (publisher `zai-org`, branded "GLM's models"): offered as fully managed MaaS, deprecated. `glm-5-maas` (GA, released 2026-02-10; 200,000 tokens context, 128,000 tokens max output; function calling supported, structured output supported, **thinking NOT supported**) and `glm-4.7-maas` (GA, released 2026-01-06; same context and output limits; function calling and structured output supported, thinking not supported). Both carry the banner: "As of July 21, 2026, the glm-5-maas endpoint is deprecated and will be retired on October 21, 2026." Docs: [docs.cloud.google.com/vertex-ai/generative-ai/docs/maas/zaiorg/glm-5](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/maas/zaiorg/glm-5) and [docs.cloud.google.com/gemini-enterprise-agent-platform/models/maas/zaiorg/glm-47](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/maas/zaiorg/glm-47).
- **Kimi** (publisher `moonshotai`): `kimi-k2-thinking-maas` (GA, released 2025-11-13; 262,144 tokens context and 262,144 tokens max output; function calling supported, structured output supported, thinking supported). Same deprecation banner. The page also documents a self-deploy path, so Kimi survives on Vertex after October only as self-hosted GPU. Doc: [docs.cloud.google.com/vertex-ai/generative-ai/docs/maas/kimi/kimi-k2-thinking](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/maas/kimi/kimi-k2-thinking).
- **DeepSeek**: `deepseek-v3.2-maas`, `deepseek-v3.1-maas`, `deepseek-r1-0528-maas`, `deepseek-ocr-maas`. All four deprecated 2026-07-21, retired 2026-10-21.
- **Qwen**: `qwen3-235b-a22b-instruct-2507-maas`, `qwen3-coder-480b-a35b-instruct-maas`, `qwen3-next-80b-a3b-instruct-maas`, `qwen3-next-80b-a3b-thinking-maas`. All deprecated 2026-07-21, retired 2026-10-21.
- **Llama**: the one family partially surviving. The Llama page ([docs.cloud.google.com/vertex-ai/generative-ai/docs/partner-models/llama](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/partner-models/llama)) states "Llama models offer fully managed and serverless models as APIs... there's no need to provision or manage infrastructure" and lists Llama 4 Maverick 17B-128E, Llama 4 Scout 17B-16E and Llama 3.3. Confirmed IDs in the page: `llama-4-maverick-17b-128e-instruct-maas` and `llama-3.3-70b-instruct-maas`; a Scout MaaS ID string was not found on the page (**NOT CONFIRMED FROM DOCS**). Only `llama-3.3-70b-instruct-maas` appears in the deprecation table; the two Llama 4 models are not in it and are still priced, so Llama 4 Maverick and Scout MaaS appear to survive past October. Llama-specific caveats: maximum 3 images per request, "The MaaS endpoint doesn't use Llama Guard", and "Batch predictions aren't supported" for Llama 4.
- Also on the managed open-model list: Gemma 4 26B A4B IT, gpt-oss 120B, gpt-oss 20B, MiniMax M2, plus embedding models `multilingual-e5-small` and `multilingual-e5-large`.

#### Caching mechanics

Caching exists on the open-model MaaS path but is implicit only, in Preview, and does not cover GLM. Source: [docs.cloud.google.com/gemini-enterprise-agent-platform/models/maas/use-open-models](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/maas/use-open-models), section "Context caching / Preview".

- Type: implicit only. "automatic caching that's enabled in all Google Cloud projects by default"; "you don't define and call the caches explicitly. Instead, our backend pulls from these caches once repeated context is detected." No explicit cache-create API, no `cache_control`-style markers, no configurable TTL published for open models.
- Discount: "a 90% discount on cached tokens compared to standard input tokens when cache hits occur", i.e. cached input at 0.1x standard input.
- Minimum: "Caching requests must contain a minimum of 4096 tokens (this minimum is subject to change during Preview)."
- Response field to log: `cachedContentTokenCount` in the response metadata "indicates the number of tokens in the cached part of your input."
- Traffic-type restriction: "enabled while using pay-as-you-go traffic only, and doesn't support other traffic types, such as Provisioned Throughput and Batch." Caching and Provisioned Throughput are mutually exclusive, and so are caching and Batch.
- No guarantee: "Cache hits aren't guaranteed and are dependent on requests sent and other factors." Recommended tactics: "Place large and common contents at the beginning of your prompt" and "Send requests with a similar prefix in a short amount of time."
- **Supported model list, verbatim, 7 models:** `qwen3-coder-480b-a35b-instruct-maas`, `kimi-k2-thinking-maas`, `minimax-m2-maas`, `gpt-oss-20b-maas`, `deepseek-v3.1-maas`, `deepseek-v3.2-maas`, `gemma-4-26b-a4b-it-maas`.

So **Kimi is covered and GLM is not.** Neither `glm-5-maas` nor `glm-4.7-maas` appears on the supported list.

**Documented discrepancy, flagged rather than resolved:** the pricing page publishes "Cache Hit: $0.1 / million tokens" for GLM-5 against USD 1.00 per 1M input tokens, which is exactly the 90% discount, even though `glm-5-maas` is absent from the caching doc's supported-models list. GLM-4.7 has no cache-hit line on the pricing page at all, consistent with no caching. The two pages contradict each other. Treat GLM-5 caching as **NOT CONFIRMED FROM DOCS** and GLM-4.7 as no caching.

#### Pricing

All figures USD per 1M tokens, from [cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing). Open models are single-priced with no global-versus-regional split.

| Model | Input | Output | Cache hit | Batch in / out |
|---|---|---|---|---|
| GLM-4.7 | 0.60 | 2.20 | none published | none published |
| GLM-5 | 1.00 | 3.20 | 0.10 (contradicts caching doc) | none published |
| Kimi-K2-Thinking | 0.60 | 2.50 | 0.06 | not supported |
| DeepSeek-V3.1 | 0.60 | 1.70 | 0.06 | 0.30 / 0.85 |
| DeepSeek-V3.2 | 0.56 | 1.68 | 0.056 | 0.28 / 0.84 |
| DeepSeek-R1 (0528) | 1.35 | 5.40 | none published | 0.675 / 2.70 |
| DeepSeek-OCR | 0.30 (or USD 0.0003 per page) | 1.20 (or USD 0.00012 per page) | none published | none published |
| Qwen3-Next-80B Instruct | 0.15 | 1.20 | none published | none published |
| Qwen3-Next-80B Thinking | 0.15 | 1.20 | none published | none published |
| Qwen3-Coder-480B-A35B-Instruct | 0.22 | 1.80 | 0.022 | 0.11 / 0.90 |
| Qwen3-235B-A22B-Instruct-2507 | 0.22 | 0.88 | none published | 0.11 / 0.44 |
| Llama 3.3 70B | 0.72 | 0.72 | none published | 0.36 / 0.36 |
| Llama 4 Scout | 0.25 | 0.70 | none published | 0.125 / 0.35 |
| Llama 4 Maverick | 0.35 | 1.15 | none published | 0.175 / 0.575 |
| MiniMax-M2 | 0.30 | 1.20 | 0.03 | none published |
| gpt-oss-20b | 0.07 | 0.25 | 0.007 | none published |
| gpt-oss-120b | 0.09 | 0.36 | none published | none published |

The GLM-5 row carries an unexplained asterisk footnote marker whose footnote text was not found on the page (**NOT CONFIRMED FROM DOCS**).

**Price versus Together.ai, for the same families.** Vertex is materially cheaper per token on the versions it carries. Kimi-K2-Thinking on Vertex (USD 0.60 input / USD 2.50 output / USD 0.06 cached per 1M tokens) undercuts Together's nearest Kimi, K2.6 (USD 1.20 / USD 4.50 / USD 0.20), by roughly 2x on input, 1.8x on output and 3.3x on cached input. GLM-5 on Vertex (USD 1.00 / USD 3.20) undercuts Together's GLM-5.1 and GLM-5.2 (USD 1.40 / USD 4.40) by roughly 29% on input and 27% on output; GLM-4.7 on Vertex (USD 0.60 / USD 2.20) is cheaper still. Vertex's 90% cached discount is also deeper than Together's (approximately 81% on GLM-5.x, approximately 83% on Kimi K2.6).

But the catalogs do not line up version for version, so this is not apples to apples: Vertex carries GLM-5 / GLM-4.7 / Kimi-K2-Thinking while Together's serverless catalog has moved on to GLM-5.2, Kimi K2.7-Code, Kimi K2.6 and Kimi K3. Vertex is cheaper on older versions with a hard 2026-10-21 shutoff. **The cheaper token here is on a three-month fuse.**

#### Auth, regions, latency

**Auth** is the real integration cost, and it is the same as section 2.2: Google OAuth2 access tokens, not a static API key. `Authorization: Bearer $(gcloud auth print-access-token)`, with Application Default Credentials for programmatic use. For Platos on Render that means shipping a Google service-account credential and a token-minting and refresh layer (service-account JSON, then signed JWT, then approximately 1-hour access token, cached and refreshed), plus enabling `aiplatform.googleapis.com`. On top of that, each individual model must be explicitly enabled: "Go to the Model Garden model card for the model you want to use, then click Enable to enable the model for use in your project", a manual console gate per model, plus a separate IAM step to grant user access to open models. This is materially heavier than Together's bearer-key model and cannot be driven purely from a dashboard-stored secret the way Platos handles other OpenAI-compatible providers.

**Endpoint shape.** The base URL is project- and location-scoped, not a fixed host: `POST https://LOCATION-aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/LOCATION/endpoints/openapi/chat/completions`. The Python path is the stock OpenAI SDK pointed at it via `OPENAI_BASE_URL`. Platos's provider config therefore needs `project_id` and `location` as first-class fields, not just `base_url` plus key.

**Regions and data processing.** GLM and Kimi are both published as: model availability "Global: global", ML processing "Multi-region: us". Open-model MaaS is effectively US-processed only, reached via the global endpoint. Vertex states "Your data is stored at rest within the selected region or multi-region for open models... but the regionalization of data processing may vary", and "Customer prompts and model responses are not shared with third parties when using the Gemini Enterprise API, including open models." Claude has broader reach: global plus `us` and `eu` multi-region plus `asia-southeast1`.

**Latency from Platos's US footprint** is structurally favourable: Render and Trigger.dev Cloud are US-hosted and GLM/Kimi ML processing is pinned to the US multi-region, so there is no cross-ocean hop. Two caveats. First, the OAuth2 token mint is an extra network dependency on the critical path unless tokens are cached aggressively; refresh must be background and time-boxed, never inline-awaited per request. Second, caching is best-effort and prefix-order-sensitive, so any per-turn variance (timestamps, reshuffled memory injections, reordered tool lists) silently destroys the 90% discount with no error surfaced. No latency percentiles or SLOs are published (**NOT CONFIRMED FROM DOCS**).

**Quotas.** For GLM and Kimi the model cards publish only context and output ceilings under "Quotas", not requests per minute or tokens per minute: `glm-5-maas` and `glm-4.7-maas` "global: 128,000 maximum output, 200,000 context length"; `kimi-k2-thinking-maas` "global: 262,144 maximum output, 262,144 context length". Both say "Fixed quota: Not supported" and "Pay-as-you-go: Standard PayGo Supported". Numeric RPM and TPM limits for GLM and Kimi MaaS are **NOT CONFIRMED FROM DOCS**; there is no open-model equivalent of the Claude quotas page. That makes capacity planning for `agent_batch` and `spawn_agent` fan-out un-plannable from docs on this path.

#### Feature gaps

- **Lifecycle** is the gap that dominates everything else. See the hard blocker above.
- **Batch:** not available for GLM or Kimi. Both model cards state "Batch inference: Not supported." DeepSeek V3.1/V3.2/R1, Qwen3-Coder, Qwen3-235B and the Llama models do have published batch prices at roughly 50% of interactive.
- **Token counting:** the free `count-tokens` endpoint is Claude-only on Vertex. There is no equivalent token-counting endpoint documented for open models, so Platos would have to estimate GLM and Kimi tokens client-side or rely on post-hoc usage fields. Tokenizer differences across GLM / Kimi / DeepSeek / Qwen make client-side approximation error family-specific.
- **Tool use:** fine. Function calling and structured output are both supported on `glm-5-maas`, `glm-4.7-maas` and `kimi-k2-thinking-maas`.
- **Thinking:** asymmetric. `kimi-k2-thinking-maas` supports thinking. Both GLM models do not, which is notable given GLM-5 is pitched for "long-horizon agentic tasks". If Platos wants GLM reasoning traces, this endpoint does not expose them.
- **Streaming:** fine. SSE via `stream: true`, standard `chat.completion.chunk` objects carrying a usage block with `prompt_tokens` / `completion_tokens` / `total_tokens`.
- **Caching control:** weaker than Anthropic direct. Implicit only, Preview, no `cache_control`, no TTL selection, no documented cache-lifetime refresh, a 4,096-token floor, and mutually exclusive with Provisioned Throughput and Batch.
- **Provisioned Throughput:** supported on GLM and Kimi MaaS, and it is the one capability arguably better than Together serverless. But it cancels caching, and it is moot given the October retirement. PT for open models is explicitly Preview, under Pre-GA Offerings Terms, "available 'as is' and might have limited support".

#### Migration effort

Shared plumbing that is new work and not covered by the existing OpenAI-compatible adapter (the one proven by the Sakana Fugu integration):

1. Google ADC / service-account credential type in the provider-key model, plus a token-minting service with in-process caching and background refresh well before the approximately 1-hour expiry, non-blocking on the request path.
2. Provider config gains `project_id` and `location`; the base URL becomes templated rather than a static host.
3. Per-model enablement is a manual console click per model per project. That is an operator runbook step and does not fit the self-serve BYOK dashboard flow.
4. Model-ID rewriting: open models are addressed `publisher/model-maas`, e.g. `deepseek-ai/deepseek-v3.1-maas`, and by the same convention `moonshotai/kimi-k2-thinking-maas` and `zai-org/glm-5-maas`. The `zai-org` and `moonshotai` publisher prefixes are inferred from Model Garden console URLs rather than stated in the calling doc, so **verify against a live call before shipping**.
5. Cost catalog entries per model plus a distinct cached-input rate, and usage parsing that reads `cachedContentTokenCount`. Note this is a **third** field name, different from Anthropic's `cache_read_input_tokens` and from OpenAI's `prompt_tokens_details.cached_tokens`, so Platos needs a third mapping. Getting it wrong silently overbills cached traffic by 10x.

For GLM and Kimi specifically, that effort is largely wasted: the endpoints retire 2026-10-21 and new use during the deprecation window "may be restricted". Any adapter built now has an approximately three-month payback window and then needs a second migration.

Note also that supporting both open models and Claude on Vertex means **two adapters sharing only the auth layer**: Claude on Vertex uses the Anthropic message format with `cache_control` via `rawPredict` / `streamRawPredict`, while open models use OpenAI `chat/completions`.

---

### 2.4 Gemini context caching (Gemini API direct and Vertex / Gemini Enterprise Agent Platform)

Gemini's caching model is structurally different from Anthropic's and mostly better for the default case, with one billing dimension Platos's cost model cannot currently express.

#### Models offered

**Gemini API direct** (`generativelanguage.googleapis.com`, AI Studio billing): Gemini only. No Claude, GLM, Kimi, DeepSeek, Qwen or Llama. This path is not a multi-vendor gateway.

**Vertex / Agent Platform:** multi-vendor, with three different caching contracts on one auth surface.

- **Claude** is served as a Vertex partner model with Anthropic-native prompt caching, not Gemini caching: "The Anthropic Claude models offer prompt caching... For details about how to structure your prompts, see the Anthropic Prompt caching documentation." So `cache_control` breakpoint semantics, the 1.25x / 2.0x write multipliers and 0.1x reads all carry over, and Gemini's implicit/explicit model does not apply. See section 2.2.
- **GLM** is served (GLM 4.7 "designed for core or vibe coding, tool use, and complex reasoning"; GLM 5 "targeting complex systems engineering and long-horizon agentic tasks") but is **absent from the open-model caching supported list**. Routing GLM through Vertex gets zero prompt caching.
- **Kimi** `kimi-k2-thinking-maas` is on the caching list: implicit only, 90% off cached tokens, 4,096-token minimum, Preview, pay-as-you-go traffic only.
- **DeepSeek** `deepseek-v3.1-maas` and `deepseek-v3.2-maas` are on the caching list; DeepSeek R1 (0528) and DeepSeek-OCR are served but not cached.
- **Qwen** `qwen3-coder-480b-a35b-instruct-maas` is on the caching list; Qwen3 235B and both Qwen3-Next-80B variants are served but not cached.
- **Llama** is filed under partner models rather than MaaS open models; whether it supports caching is **NOT CONFIRMED FROM DOCS**.

Gemini SKUs referenced below, from the pricing pages: Gemini 3.6 Flash (`gemini-3.6-flash`), Gemini 3.5 Flash (`gemini-3.5-flash`), Gemini 3.5 Flash-Lite (`gemini-3.5-flash-lite`), Gemini 3.1 Flash-Lite, Gemini 3.1 Pro Preview (`gemini-3.1-pro-preview`), Gemini 3 Flash Preview, Gemini 2.5 Pro (`gemini-2.5-pro`), Gemini 2.5 Flash (`gemini-2.5-flash`), Gemini 2.5 Flash-Lite (`gemini-2.5-flash-lite`). There is no Gemini 3 Pro GA and no Gemini 3.5 Pro on the Gemini API pricing page; the only Pro-class Gemini 3 SKU there is 3.1 Pro Preview. The Vertex cache-storage table does list a "Gemini 3 Pro" row, whose input and output pricing was **NOT CONFIRMED FROM DOCS**.

#### Caching mechanics

**1. Implicit caching (automatic).** Source: [ai.google.dev/gemini-api/docs/caching](https://ai.google.dev/gemini-api/docs/caching). Invocation: none. "Implicit caching is enabled by default for all Gemini 2.5 and newer models... There is nothing you need to do in order to enable this." Vertex: "All Google Cloud projects have implicit caching enabled by default." Discount: 90% off cached tokens versus standard input, appearing on the pricing page as the per-model "Context caching price" line at exactly 10% of the input rate. Storage cost: none. Verbatim: "There are no storage costs for implicit caching." Guarantee: none; the generateContent doc labels it "no cost saving guarantee".

Implicit-cache TTL on the Gemini API path is **NOT CONFIRMED FROM DOCS**. The closest documented figure describes the underlying in-memory cache on Vertex's zero-data-retention page: "This data is stored only in-memory (not at-rest), is isolated at the project level, and has a 24-hour TTL." Do not treat that as a hit-window guarantee. Implicit caching can be disabled on Vertex only, via `PATCH https://us-central1-aiplatform.googleapis.com/v1/projects/PROJECT_ID/cacheConfig` with `{"disableCache": true}`; no equivalent is documented for the Gemini API direct path.

**2. Request-shape discipline for implicit hits.** Advisory rather than API-enforced, and identical on both paths: "Try putting large and common contents at the beginning of your prompt" and "Try to send requests with similar prefix in a short amount of time." The mechanism is confirmed prefix-based by the explicit-caching considerations section: "The model doesn't make any distinction between cached tokens and regular input tokens. Cached content is a prefix to the prompt." Practical consequence for Platos: anything injected early in the prompt that varies per request (timestamps, recalled memories, per-turn user identity, reordered tool definitions) destroys the prefix and silently costs the 90%. There is no error, no warning and no field that reports a broken prefix, only a lower cached-token count.

Minimum tokens to be cacheable, implicit, from two doc sources that disagree in scope:

| Source and model | Minimum |
|---|---|
| Gemini API docs: Gemini 3.5 Flash | 4,096 tokens |
| Gemini API docs: Gemini 3.1 Pro Preview | 4,096 tokens |
| Gemini API docs: Gemini 2.5 Flash | 2,048 tokens |
| Gemini API docs: Gemini 2.5 Pro | 2,048 tokens |
| Vertex limits table: Gemini 3 family | 4,096 tokens |
| Vertex limits table: Gemini 3.0 Flash Preview and 3.1 Pro Preview (implicit only) | 6,144 tokens |
| Vertex limits table: Gemini 2 family | 2,048 tokens |
| Vertex MaaS open models (Kimi, DeepSeek, Qwen, MiniMax, gpt-oss, Gemma) | 4,096 tokens, "subject to change during Preview" |

Below the minimum nothing caches. A 2,000-token system prompt on a Gemini 3 model caches nothing at all.

**3. Explicit caching (the `cachedContents` API).** `cachedContents.create` (POST), `.list`, `.get`, `.patch`, `.delete`. Resource fields: `model` (required, immutable, format `models/{model}`), `contents[]`, `systemInstruction` ("Developer set system instruction. Currently text only"), `tools[]`, `toolConfig`, `displayName` (max 128 Unicode chars), `ttl` (input-only duration string, e.g. `"300s"`), `expireTime` (RFC3339 UTC). PATCH can only update expiration ("expiration only updatable"); to change cached content you delete and recreate.

Notable versus Anthropic: `tools[]` and `toolConfig` can be baked into the cache object as first-class fields. Anthropic has no equivalent; there you place a `cache_control` breakpoint after the tools block. For a Platos agent with a large tool catalog this is genuinely attractive.

Use: pass the cache resource name in the request; via the OpenAI-compatible shim, `extra_body: {"cached_content": "<cache name>"}` on `chat/completions`.

TTL default is 1 hour if unset ("If not set, the TTL defaults to 1 hour"; Vertex: "The default expiration time of a context cache is 60 minutes after it's created"). TTL bounds contradict between docs: the Gemini API says "There are no minimum or maximum bounds on the TTL", while the Vertex limits table says "Minimum time before a cache expires after it's created: 1 minute" and "Maximum time before a cache expires after it's created: There isn't a maximum cache duration." Treat 1 minute as the safe floor on Vertex.

Read discount: 90% on Gemini 2.5 or later, 75% on Gemini 2.0 models. Size limit: "Maximum size of content you can cache using a blob or text: 10 MB"; above that you must pass a Cloud Storage URI on Vertex, with the warning that "Updates to Cloud Storage objects can cause the associated cached contents to be unusable." Rate limits: "There are no special rate or usage limits on context caching; the standard rate limits for GenerateContent apply, and token limits include cached tokens." No aggregate cache-storage quota was found on the rate-limits page (**NOT CONFIRMED FROM DOCS**).

Interaction with implicit caching: "Explicit caches interact with implicit caching, potentially leading to additional caching beyond the specified contents when creating a cache. To prevent cache data retention, disable implicit caching and avoid creating explicit caches."

**4. Explicit-caching billing, which is where Gemini diverges from Anthropic.** Three components: "Cache token count: The number of input tokens cached, billed at a reduced rate when included in subsequent prompts"; "Storage duration: The amount of time cached tokens are stored (TTL), billed based on the TTL duration of cached token count"; "Other factors: Other charges apply, such as for non-cached input tokens and output tokens." And from Vertex: "For both implicit and explicit caching, you're billed for the input tokens used to create the cache at the standard input token price."

So the shape is: **no write multiplier** (creation at 1.0x standard input, versus Anthropic's 1.25x for 5 minutes and 2.0x for 1 hour), reads at 0.1x, plus a per-token-hour rent that Anthropic has no analogue for. Rent accrues on the TTL you booked whether or not you ever read the cache. Whether early deletion refunds unused storage is **NOT CONFIRMED FROM DOCS**; the wording says billing is based on the TTL duration.

**5. How cache hits are reported.** On `generateContent` and REST, `GenerateContentResponse.UsageMetadata` carries `cachedContentTokenCount` ("Number of tokens in the cached part of the prompt (the cached content)"; Vertex confirms it covers both modes), plus `promptTokenCount`, `cacheTokensDetails[]` (per-modality breakdown), `candidatesTokenCount`, `thoughtsTokenCount`, `toolUsePromptTokenCount`, `totalTokenCount`, `promptTokensDetails[]`, `candidatesTokensDetails[]`, `toolUsePromptTokensDetails[]` and `serviceTier`.

**The double-count trap.** `promptTokenCount` is documented as: "Number of tokens in the prompt. When cachedContent is set, this is still the total effective prompt size meaning this includes the number of tokens in the cached content." Unlike Anthropic, where `input_tokens` **excludes** `cache_read_input_tokens`, Gemini's `promptTokenCount` **includes** `cachedContentTokenCount`. Any cost calculator that adds them is wrong. See the migration-effort subsection for the concrete instance of this in the Platos repo.

On the new Interactions API the field is different again: `usage.total_cached_tokens`. Log both. Cache-object metadata from create/get/list returns `usageMetadata` with `totalTokenCount`, plus on Vertex `imageCount` / `textCount` / `audioDurationSeconds` / `videoDurationSeconds`.

**6. The big structural gotcha.** Verbatim from [ai.google.dev/gemini-api/docs/caching](https://ai.google.dev/gemini-api/docs/caching): "This version of the page covers the Interactions API, which only supports implicit caching. Explicit caching (manually creating and managing cache objects) is not supported in the Interactions API." Google is steering everyone to the Interactions API ("The Interactions API is now generally available. We recommend using this API for access to all the latest features and models") and `generateContent` is now labelled "(Legacy)". The explicit-cache lever therefore lives only on the API Google is deprecating in spirit. If Platos standardises on Interactions, implicit caching is the only caching available.

#### Pricing

All figures USD per 1M tokens, paid tier, standard (non-batch, non-priority) service, from [ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing). "Cached read" is the "Context caching price" line. "Storage" is explicit caching only, in USD per 1M tokens per hour.

| Model (Gemini API direct) | Input | Output | Cached read | Storage (per 1M tok per hour) |
|---|---|---|---|---|
| Gemini 3.6 Flash | 1.50 | 7.50 (incl. thinking) | 0.15 | 1.00 |
| Gemini 3.5 Flash | 1.50 | 9.00 | 0.15 | 1.00 |
| Gemini 3.5 Flash-Lite | 0.30 (text/image/video/audio) | 2.50 | 0.03 | 1.00 |
| Gemini 3.1 Flash-Lite | 0.25 (text/image/video), 0.50 (audio) | 1.50 | 0.025 / 0.05 | 1.00 |
| Gemini 3.1 Pro Preview, prompts up to 200k tokens | 2.00 | 12.00 | 0.20 | 4.50 |
| Gemini 3.1 Pro Preview, prompts over 200k tokens | 4.00 | 18.00 | 0.40 | 4.50 |
| Gemini 3 Flash Preview | 0.50 | 3.00 | 0.05 | not listed |
| Gemini 2.5 Pro, prompts up to 200k tokens | 1.25 | 10.00 | 0.125 | 4.50 |
| Gemini 2.5 Pro, prompts over 200k tokens | 2.50 | 15.00 | 0.25 | 4.50 |
| Gemini 2.5 Flash | 0.30 (text/image/video), 1.00 (audio) | 2.50 | 0.03 / 0.10 | 1.00 |
| Gemini 2.5 Flash-Lite | 0.10 (text/image/video), 0.30 (audio) | 0.40 | 0.01 / 0.03 | 1.00 |

Batch and Flex are exactly 50% of standard on every line (Gemini 3.6 Flash batch: USD 0.75 input / USD 3.75 output / USD 0.075 cached per 1M tokens). Free tier: input, output and caching are free of charge on Gemini 3.6 Flash and Gemini 3.5 Flash, but context caching is "Not available" on Gemini 2.5 Pro, 2.5 Flash, 2.5 Flash-Lite and 3.5 Flash-Lite.

**Vertex** ([cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)) uses the same base numbers with three service tiers plus a regional surcharge. Standard: 3.1 Pro Preview USD 2.00 in / USD 12.00 out / USD 0.20 cached; 3.6 Flash USD 1.50 / USD 7.50 / USD 0.15; 3.5 Flash USD 1.50 global or USD 1.65 non-global in, USD 9.00 global or USD 9.90 non-global out, USD 0.15 global or USD 0.165 non-global cached; 3.5 Flash-Lite USD 0.30 global or USD 0.33 non-global in, USD 2.50 out, USD 0.03 cached; 2.5 Pro USD 1.25 in up to 200k tokens or USD 2.50 above, USD 10.00 out up to 200k tokens or USD 15.00 above, USD 0.13 or USD 0.25 cached; 2.5 Flash USD 0.30 / USD 2.50 / USD 0.03; 2.5 Flash-Lite USD 0.10 / USD 0.40 / USD 0.01. Priority tier is approximately 1.8x standard (3.6 Flash: USD 2.70 in / USD 13.50 out / USD 0.27 cached). Batch tier is 0.5x standard. A footnote states non-global endpoint prices apply from 2026-07-01, so they are live now; pinning to a region costs approximately +10% on Flash and Flash-Lite, and the global endpoint is the cheap option.

Vertex "Context Cache Storage price for Explicit Caching" table, verbatim including units: Gemini 3.1 Pro "$4.5 (/M Tok/hr)"; Gemini 3 Pro "$4.5 (/M Tok/hr)"; Gemini 2.5 Pro "$4.5 (/M Tok/hr)"; Gemini 3 Flash "$1 (/M Tok/hr)"; Gemini 3.1 Flash Lite "$1 (/M Tok/hr)"; Gemini 2.5 Flash "$1 (/M Tok/hr)"; Gemini 2.5 Flash Lite "$1 (/M Tok/hr)". Storage price does not change above 200k tokens. Also: "You're charged only for requests that return a 200 response code. Requests returning any other response codes, such as 4xx and 5xx codes, aren't charged for the input or output."

**Explicit-cache break-even math**, derived from the numbers above. For a cached prefix held H hours and read N times, explicit caching beats no caching when `N > (input_price + storage_price x H) / (input_price - cached_price)`:

| Model | Break-even formula | At 1h TTL | At 24h TTL |
|---|---|---|---|
| Gemini 3.6 / 3.5 Flash | N > 1.11 + 0.74H | 2 requests | 19 requests |
| Gemini 3.1 Pro Preview | N > 1.11 + 2.50H | 4 requests | 62 requests |
| Gemini 2.5 Pro | N > 1.11 + 4.00H | 6 requests | 98 requests |
| Gemini 2.5 Flash | N > 1.11 + 3.70H | 5 requests | 90 requests |
| Gemini 2.5 Flash-Lite | N > 1.11 + 11.1H | 13 requests | 268 requests |

Intuition worth carrying into the decision: one hour of storage rent costs the equivalent of 2.25 full sends on Gemini 3.1 Pro, 3.6 full sends on Gemini 2.5 Pro, 0.67 on Gemini 3.6 / 3.5 Flash, 3.33 on Gemini 2.5 Flash and 10 on Gemini 2.5 Flash-Lite. Because rent is flat per tier (USD 1.00 or USD 4.50 per 1M tokens per hour) while input prices span roughly 15x to 20x, explicit caching gets economically **worse the cheaper the model**, and is only attractive on expensive-input models with dense reuse. For everything cheap, implicit caching (free storage, same 90% discount) is strictly better and needs no code.

Contrast for the routing decision: Anthropic is 1.25x write (5m) or 2.0x write (1h), 0.1x read, zero storage rent, so cost is purely a function of reuse count. Gemini explicit is 1.0x write, 0.1x read, plus rent, so cost is a function of reuse count **and** wall clock. Gemini implicit is 0x write premium, 0.1x read, zero rent, no guarantee.

#### Auth, regions, latency

**Gemini API direct:** API key only, header `x-goog-api-key` or `?key=` query param. OpenAI-compatible surface at base URL `https://generativelanguage.googleapis.com/v1beta/openai/`, which is where `extra_body.cached_content` is accepted. Single global hostname; no project, no region, no OAuth. This is the low-friction path and it slots into Platos's existing BYOK secret model directly.

**Vertex / Agent Platform:** GCP OAuth2 (service account or ADC) plus explicit `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`, and the Gen AI SDK now also wants `GOOGLE_GENAI_USE_ENTERPRISE=True`. Endpoints are region-qualified (e.g. `https://us-central1-aiplatform.googleapis.com/v1/projects/PROJECT_ID/...`). Heavier to operate: key rotation becomes service-account key or workload-identity management rather than a single secret.

**Regions.** The Gemini API direct path documents no region selection; one global endpoint. On Vertex, region matters in four ways relevant to Platos's US infra:

1. Explicit caches are **region-pinned**: "The cached content is stored in the region where you make the request to create the cache." A cache created via `us-central1` is not addressable from another region, so a worker fleet fanning out across regions must pin cache creation and cache reads to the same location or silently miss.
2. Context caching supports the global endpoint, but "CMEK isn't supported when using the global endpoint", so CMEK and global are mutually exclusive.
3. "Context caching isn't supported in the Sydney, Australia (australia-southeast1) region."
4. Non-global endpoints cost approximately +10% on Flash and Flash-Lite, live since 2026-07-01, so US-pinned regional traffic is measurably more expensive than global-endpoint traffic.

**Latency.** Google publishes no per-region latency figures for either path; any time-to-first-token or round-trip numbers would be **NOT CONFIRMED FROM DOCS**. Structurally: the Gemini API direct path has one global endpoint so US-origin traffic from Render has no region decision to get wrong; the Vertex path lets you co-locate in `us-central1` (though the cheapest US option is actually the global endpoint) but then inherits the cache-region-pinning constraint. Caching's latency benefit is asserted qualitatively only ("Context caching helps reduce the cost and latency of requests to Gemini that contain repeated content") with no quoted magnitude.

**Compliance surface, Vertex only:** explicit context caching supports CMEK, VPC Service Controls ("your cache cannot be exfiltrated beyond your service perimeter"; include your GCS bucket in the perimeter if you build caches from GCS) and Access Transparency. Implicit caching is in-memory, project-isolated, 24-hour TTL, "adheres to all Data Residency requirements for the selected location", and is disableable per project via the `cacheConfig` PATCH. None of this exists on the Gemini API direct path. Caching also works across traffic types on Vertex for Gemini models ("a cache created while using Provisioned Throughput also works with PayGo", both in Preview), but **not** for open models, where caching is pay-as-you-go only.

#### Feature gaps

1. **Explicit caching is absent from the Interactions API**, which is Google's own recommended GA surface. Anthropic has one API with one caching model.
2. **No cache-hit guarantee on the implicit path**, and no way to force one short of the explicit API. Anthropic's `cache_control` is deterministic.
3. **No cache-write visibility.** Anthropic reports `cache_creation_input_tokens` and `cache_read_input_tokens` separately, so you can see writes versus reads and attribute the write premium. Gemini reports only `cachedContentTokenCount` (hits); creation cost is folded into ordinary input tokens with no per-response field distinguishing "this call populated the cache."
4. **`promptTokenCount` includes cached tokens** where Anthropic's `input_tokens` excludes them. Easy way to get billing wrong.
5. **Storage rent has no Anthropic analogue** and no place in a per-token cost model.
6. **Contradictory published limits:** two minimum-token tables simultaneously, and TTL bounds stated as both "no minimum or maximum bounds" and "minimum 1 minute".
7. **Free tier:** context caching is "Not available" on Gemini 2.5 Pro, 2.5 Flash, 2.5 Flash-Lite and 3.5 Flash-Lite, so caching cannot be relied on in a free-tier posture.
8. **No documented aggregate cache-storage quota** (**NOT CONFIRMED FROM DOCS**).
9. **GLM has no caching path on Vertex at all**, so Vertex cannot be the one-provider answer for the Claude plus GLM plus Kimi trio without accepting an uncached GLM.

Not gaps: **Batch** is present and cheap (50% off on the Gemini API; a separate 0.5x service tier on Vertex, plus a priority tier at approximately 1.8x that Anthropic has no equivalent for), though on Vertex MaaS open models caching "doesn't support other traffic types, such as Provisioned Throughput and Batch", and whether batch and caching compose for Gemini models is **NOT CONFIRMED FROM DOCS**. **Tool use** is arguably ahead of Anthropic for caching purposes, since `tools[]` and `toolConfig` are first-class fields on the CachedContent resource. **Streaming** is supported and composes with caching on the OpenAI-compatible surface. **Token counting** exists but was not fetched as a dedicated reference page, so its exact signature and whether it accepts a `cachedContent` handle is **NOT CONFIRMED FROM DOCS**.

#### Migration effort

This was grounded against the actual repo rather than estimated, and it surfaced two concrete pre-existing issues.

**Found: stale cached-read price.** `/Users/tejassudarshan/winsenlabs/platos-oss/internal-packages/llm-model-catalog/src/defaultPrices.ts` at approximately line 2211 has `gemini-2.5-flash-lite` with `"cached_content_token_count": 2.5e-8`, i.e. USD 0.025 per 1M tokens. Current docs say USD 0.01 per 1M tokens for text/image/video and USD 0.03 per 1M tokens for audio. That is a 2.5x overcharge on the text path. The adjacent `gemini-2.5-flash` block is correct (input `3e-7` = USD 0.30 per 1M tokens, `cached_content_token_count` `3e-8` = USD 0.03 per 1M tokens, both matching docs).

**Found: double-count risk on Gemini cached tokens.** The Gemini price blocks in `defaultPrices.ts` price both `prompt_token_count` / `promptTokenCount` at the full input rate **and** `cached_content_token_count` at the discounted rate. `calculateCost` in `/Users/tejassudarshan/winsenlabs/platos-oss/internal-packages/llm-model-catalog/src/registry.ts` lines 150 to 156 sums every price entry whose `usageType` appears in `usageDetails`, with no subtraction:

```ts
for (const priceEntry of tier.prices) {
  const tokenCount = usageDetails[priceEntry.usageType] ?? 0;
  if (tokenCount === 0) continue;
  totalCost += tokenCount * priceEntry.price;
}
```

Because Google documents `promptTokenCount` as inclusive of cached content, if the Gemini adapter emits both keys then cached tokens are billed at the input rate **plus** the cached rate, i.e. caching makes the reported cost go up rather than down. This differs from Anthropic, where `input_tokens` excludes cache reads and additive summing is correct. Verify which usage keys the Google adapter actually emits before trusting any Gemini cost number. Note also that `input`, `prompt_token_count` and `promptTokenCount` are three same-priced aliases in the same tier, so the design already assumes exactly one alias arrives per call.

**Structural work to route Gemini here:**

1. **No storage-rent dimension exists.** Every price key in `defaultPrices.ts` is a per-token rate (`input`, `output`, `input_cache_read`, `input_cached_tokens`, `cache_creation_input_tokens`, `input_cache_creation_1h`, `output_reasoning`, and so on). The catalog already models Anthropic's 1-hour write multiplier via `input_cache_creation_1h`, but there is no token-hours concept anywhere. Gemini explicit caching bills USD 1.00 or USD 4.50 per 1M tokens per hour against a cache object's lifetime, which is not attributable to any single request. Supporting it requires a new cost dimension keyed to the cache resource plus elapsed TTL. This is the single largest piece of work and it is a schema change, not a config change.
2. **Cache-object lifecycle.** Explicit caching needs create/get/patch/delete plumbing, persistence for cache resource names, TTL policy, and on Vertex region pinning so reads hit the region that created the cache. Anthropic needs none of this. Platos has nothing to reuse here.
3. **Usage-metadata mapping.** Two field names depending on API surface: `cachedContentTokenCount` on `generateContent`, `usage.total_cached_tokens` on the Interactions API. Log both. The catalog already carries `cached_content_token_count` / `prompt_token_count` / `candidates_token_count` / `thoughts_token_count` keys across 10 Gemini blocks, so the `generateContent` shape is partly wired; the Interactions shape is not.
4. **Long-context tier gates.** Gemini 2.5 Pro and 3.1 Pro Preview change input, output **and** cached-read price above 200k prompt tokens. The catalog has a conditions/pricingTiers mechanism (`_matchPricingTier`) so this is expressible, but it must be keyed off effective prompt size **including** cached tokens, and the above-200k cached rate must be wired separately.
5. **Prompt-assembly discipline is the cheap, high-leverage change.** To earn implicit caching, Platos must stabilise the prompt prefix: system prompt and tool definitions first and byte-identical across turns, with per-turn volatile content moved to the end. Two known Platos behaviours work directly against this (memory injection prepending recalled memories, and unresolved or reordered promptVars), and both would silently zero the discount. Zero API work, but a real refactor of prompt assembly order, and section 4 shows it is the same refactor Anthropic caching needs.
6. **API-surface choice is a fork in the road.** Adopting the Interactions API permanently forecloses explicit caching; staying on `generateContent` keeps it but is now labelled Legacy. Given the break-even math, the defensible call is: take Interactions plus implicit caching only, do the prefix-stability work in item 5, skip the cache-object lifecycle in item 2 and the token-hours schema change in item 1, and revisit explicit caching only if a specific workload shows a huge static prefix read many times per hour on a Pro-tier model.

---

### 2.5 Together.ai (together.ai / api.together.ai)

Together does automatic prefix caching on serverless inference today, and it is a real price discount rather than a latency-only win. The tradeoff is that the discount is best-effort with no TTL guarantee, and Together sells no Claude and no Gemini at all.

#### Models offered

From [docs.together.ai/docs/serverless/models](https://docs.together.ai/docs/serverless/models), cross-checked against [www.together.ai/pricing](https://www.together.ai/pricing). The serverless chat catalog is 19 models (marketing claims "200+ models" across text, image, video, code and audio).

Offered: GLM (`zai-org/GLM-5.2`, plus `GLM-5.1` per the marketing page), Kimi (`moonshotai/Kimi-K3`, `moonshotai/Kimi-K2.7-Code`, `moonshotai/Kimi-K2.6`), DeepSeek (`deepseek-ai/DeepSeek-V4-Pro` only), Qwen (`Qwen/Qwen3.7-Max`, `Qwen/Qwen3.7-Plus`, `Qwen/Qwen3.6-Plus`, `Qwen/Qwen3.5-9B`, `Qwen/Qwen2.5-7B-Instruct-Turbo`), Llama (`meta-llama/Llama-3.3-70B-Instruct-Turbo`), plus `MiniMaxAI/MiniMax-M3` and `openai/gpt-oss-120b` / `gpt-oss-20b`.

**Not offered: Claude.** No Anthropic model appears in the serverless catalog, on the pricing page, or in the quickstart; confirmed absent across three fetched pages. **Not offered: Gemini**, likewise absent. Together publishes [docs.together.ai/docs/how-to-use-togetherlink](https://docs.together.ai/docs/how-to-use-togetherlink) (configuring Claude Code, Codex or ChatGPT to run against Together models) and [docs.together.ai/docs/how-to-implement-contextual-rag-from-anthropic](https://docs.together.ai/docs/how-to-implement-contextual-rag-from-anthropic) (implementing an Anthropic-published technique), both of which are easy to misread as Claude availability. They are not. Together is an open-weights host; frontier closed models are structurally out of scope.

**Model-string drift warning.** The strings absent from the live catalog (`zai-org/GLM-4.5`, `GLM-4.5-Air`, `GLM-4.6`, `deepseek-ai/DeepSeek-V3`, `deepseek-ai/DeepSeek-R1`, `moonshotai/Kimi-K2-Instruct`) are exactly the generation of names an older Platos provider route table would hold. The catalog page carries no deprecation notice, so failures will be opaque. Budget for a model-string remap, not just a base-URL swap.

#### Caching mechanics

Exists on serverless, and it is a billing discount. [docs.together.ai/docs/inference/pricing](https://docs.together.ai/docs/inference/pricing) states verbatim: "Select serverless chat models bill cached input tokens at a steep discount." Every supported model has its own published "Cached input pricing" column value, and cached tokens are billed at that rate instead of the standard input rate.

Fully automatic. Verbatim from [docs.together.ai/docs/serverless/overview](https://docs.together.ai/docs/serverless/overview): "Automatic: There is no header, parameter, or account toggle to enable it. Send the same prompt prefix again and any portion that's still warm in the shared cache is billed at the cached rate." No `cache_control` breakpoints, no beta header, nothing to author in the request. There is also **no documented cache-write surcharge**; input tokens on a miss bill at the plain input rate.

Constraints:

- Prefix-based, longest-match only: "Only the longest matching prefix of your input counts as cached. Tokens after the first difference are billed at the standard input rate." Same prefix-stability discipline as Anthropic.
- Best-effort and short-lived: "The serverless cache is shared across the fleet and entries are evicted as traffic shifts, so cache hits aren't guaranteed and there's no configurable retention window."
- TTL: no number published (**NOT CONFIRMED FROM DOCS**). There is no equivalent of Anthropic's 5-minute versus 1-hour tiers.
- Minimum prefix length: **NOT CONFIRMED FROM DOCS**. No minimum token count, cache block size or KV-block granularity is stated anywhere on docs.together.ai or support.together.ai.
- Per-model gating: "Only models with a value in the Cached input pricing column on Chat models support cached input billing." In the current catalog that means Kimi K3 / K2.7-Code / K2.6, GLM-5.2, DeepSeek-V4-Pro and MiniMax-M3, and not the Qwen rows or Llama 3.3 70B.
- No multipliers to model: a single flat cached-input rate per model. The only "multiplier" is cached rate divided by input rate.

**Response fields, with a shape trap.** Per [docs.together.ai/docs/inference/openai-compatibility](https://docs.together.ai/docs/inference/openai-compatibility): reasoning models (explicitly naming `zai-org/GLM-5.2`, `deepseek-ai/DeepSeek-V4-Pro`, `Qwen/Qwen3.6-Plus`) follow the OpenAI nested shape, with cached prompt tokens under `usage.prompt_tokens_details.cached_tokens` and reasoning tokens under `usage.completion_tokens_details.reasoning_tokens`. Some non-reasoning models (explicitly `meta-llama/Llama-3.3-70B-Instruct-Turbo`) "return cached_tokens flat at the top level of usage, with no *_details objects." The docs give the fallback verbatim: `(usage.prompt_tokens_details or {}).get("cached_tokens") or usage.get("cached_tokens", 0)`, with the explicit warning "A client configured for only one shape will return 0 for all others (with no error message)." That is a silent-zero cost-accounting bug waiting to happen.

Caveat: the formal API reference schema at [docs.together.ai/reference/chat-completions-1](https://docs.together.ai/reference/chat-completions-1) documents `UsageData` as only `prompt_tokens` / `completion_tokens` / `total_tokens`, with no cache fields at all. The reference schema lags the prose docs. Treat the fields as real, but do not expect schema or SDK types to declare them.

**Dedicated endpoints invert the economics.** On dedicated, prompt caching is enabled by default, cannot be disabled, and is "scoped to your own replicas", i.e. a private cache with a predictable hit rate and no fleet eviction. The `--no-prompt-cache` CLI flag and `disable_prompt_cache` API field are deprecated with removal stated for February 2026 (snippet-confirmed from docs.together.ai search over the dedicated-endpoints pages rather than page-confirmed; treat the date accordingly). But dedicated bills per GPU-minute ("DMI bills per-GPU-minute, which is cheaper at high utilization than serverless models"), so there is no per-token cached discount to capture there; caching becomes purely a throughput and latency benefit. Net: the cached-token **price** discount exists only on serverless, and cache **reliability** exists only on dedicated. You cannot have both.

#### Pricing

All figures USD per 1M tokens, serverless pay-per-token.

| Model | Input | Cached input | Output | Context | Cached / input ratio |
|---|---|---|---|---|---|
| `moonshotai/Kimi-K3` | 3.00 | 0.30 | 15.00 | 1,000,000 tokens | 0.10x (90% off) |
| `moonshotai/Kimi-K2.7-Code` | 0.95 | 0.19 | 4.00 | 262,144 tokens | 0.20x (80% off) |
| `moonshotai/Kimi-K2.6` | 1.20 | 0.20 | 4.50 | 262,144 tokens | 0.167x (83% off) |
| `zai-org/GLM-5.2` | 1.40 | 0.26 | 4.40 | 262,144 tokens | 0.186x (81% off) |
| `zai-org/GLM-5.1` (marketing page only) | 1.40 | 0.26 | 4.40 | not listed | 0.186x |
| `deepseek-ai/DeepSeek-V4-Pro` | 1.74 | 0.20 | 3.48 | 512,000 tokens | 0.115x (88.5% off) |
| `MiniMaxAI/MiniMax-M3` | 0.30 | 0.06 | 1.20 | 524,288 tokens | 0.20x (80% off) |
| `Qwen/Qwen3.7-Max` | 1.25 | none in docs catalog | 3.75 | not listed | n/a |
| `Qwen/Qwen3.7-Plus` | 0.32 | none | 1.28 | 1,000,000 tokens | n/a |
| `Qwen/Qwen3.6-Plus` | 0.50 | none | 3.00 | 1,000,000 tokens | n/a |
| `Qwen/Qwen3.5-9B` | 0.17 | none | 0.25 | 262,144 tokens | n/a |
| `Qwen/Qwen2.5-7B-Instruct-Turbo` | 0.30 | none | 0.30 | 32,768 tokens | n/a |
| `meta-llama/Llama-3.3-70B-Instruct-Turbo` | 1.04 | none in catalog column | 1.04 | 131,072 tokens | n/a |
| `openai/gpt-oss-120b` | 0.15 | none | 0.60 | 128,000 tokens | n/a |
| `openai/gpt-oss-20b` | 0.05 | none | 0.20 | 128,000 tokens | n/a |

GLM-5.2 pricing is confirmed twice: [docs.together.ai/docs/glm-5.2-quickstart](https://docs.together.ai/docs/glm-5.2-quickstart) states "Pricing is $1.40 per 1M input tokens, $4.40 per 1M output tokens, and $0.26 per 1M cached input tokens", and lists up to 128k output tokens, FP4 precision, thinking on by default with reasoning effort `high` or `max`, tool calling, streaming tool calls and structured outputs.

Two inconsistencies to verify live rather than assume: `zai-org/GLM-5.1` appears on the marketing pricing table but not in the docs serverless catalog fetch, so target GLM-5.2; and `Qwen/Qwen3.6-Plus` is named in the OpenAI-compatibility doc as a reasoning model returning nested `cached_tokens` while its catalog row shows no cached-pricing value, so its cached support is **NOT CONFIRMED FROM DOCS**. The marketing pricing page also showed a USD 0.13 per 1M tokens cached figure for Qwen3.7-Max that the docs catalog row does not carry; treat as unsupported until verified.

**Batch:** "Run asynchronous workloads at up to 50% lower cost"; models "discounted up to 50% when run with batch workloads". Selected serverless models only; the discount does **not** apply to dedicated model inference usage.

**Dedicated hardware**, per GPU per hour, on-demand: NVIDIA HGX H100 USD 5.49, NVIDIA HGX B200 USD 8.99. GPU Clusters on-demand: H100 USD 3.99 per GPU per hour, B200 USD 8.19 per GPU per hour. Docs state DMI bills per GPU-minute.

Billing units, verbatim: "Chat, language, embedding, and rerank: Per input and output token."

#### Auth, regions, latency

**Auth:** simple bearer API key. `Authorization: Bearer $TOGETHER_API_KEY`; SDKs read `TOGETHER_API_KEY` from the environment. No OAuth, no SigV4, no per-project service accounts documented for inference. This slots into Platos's existing scopedEnv / BYOK secret model exactly like the Sakana Fugu integration: one org-level or scope-level secret, no credential-exchange dance.

**Base URL:** `https://api.together.ai/v1`, OpenAI-compatible. Python SDK `together`, TypeScript SDK `together-ai`, or point the OpenAI SDK at the base URL, or raw REST.

**Regions:** serverless does not expose region selection. [docs.together.ai/docs/privacy-and-security](https://docs.together.ai/docs/privacy-and-security) references "Together's secure North America data centers"; no region list, no EU or APAC serverless region, and no region parameter on the inference API. Region control is a dedicated-tier feature only.

**Latency from Platos infra (Render US plus Trigger.dev US)** is structurally favourable: North-America-hosted serverless means same-continent egress from both, so added network round-trip should be comparable to calling Anthropic direct from the same boxes. Materially better than the Sakana Fugu geo situation. **NOT CONFIRMED FROM DOCS:** the specific NA regions, any published p50 or p99 latency or time-to-first-token, and whether there is any anycast or edge routing. Together publishes no latency SLO for serverless; [docs.together.ai/docs/rate-limits](https://docs.together.ai/docs/rate-limits) points at dedicated endpoints as the path to "predictable SLAs", which implies serverless has none.

**Caching and latency interaction, relevant to Platos specifically:** because the serverless cache is fleet-shared and evicts on traffic shifts, prefill latency for a long agent system prompt is variable run to run and cannot be warmed. Platos's long-context agent turns (large system prompt plus tool definitions plus memory injection) will see bimodal time-to-first-token. That is the same class of problem as the known inline-embedding stall and will show up as unexplained `agent.task` to `OUTBOUND` gaps, so instrument the `cached_tokens` field from day one rather than diagnosing it later.

**Data retention:** zero data retention by default, with the explicit qualifier that "temporary caching may be used to improve performance unless otherwise configured." Prefix caching is literally that temporary cache, so ZDR-by-default and prefix caching are in tension; read the DPA before promising ZDR to a Platos customer while relying on cache discounts. Private networking and VPC-based deployments are available for residency and regulatory requirements, contact-sales only.

#### Feature gaps

- **Batches:** Together has a batch API at up to 50% discount, but it is Together-shaped, not OpenAI-shaped. The OpenAI-compatibility doc explicitly lists "OpenAI-shaped Batch and Files APIs" as not implemented. Platos cannot reuse an OpenAI batch client; it needs a Together-specific batch adapter. There is no Anthropic-Message-Batches-shaped API either.
- **Token counting:** no dedicated pre-flight token-counting endpoint found (**NOT CONFIRMED FROM DOCS**; no `/tokenize` or `count_tokens` equivalent located). Token counts arrive only post-hoc in `usage`. A real gap versus Anthropic direct. Budget pre-checks and context-window guards relying on server-side counting would need local tokenizer approximation, with error that differs per model family.
- **Tool use:** supported and reasonably mature. `tools` and `tool_choice` function calling, streaming tool calls (GLM-5.2 documented as emitting "tool call parameters incrementally"), tool calling "with reasoning interleaved between each step", and structured outputs via `response_format`. No equivalent of Anthropic's server-side tool ecosystem (no native web search tool, no code execution tool, no computer use, no server-side MCP connector), which is acceptable for Platos since it already owns the tool loop and the MCP gateway.
- **Streaming:** supported on chat completions including streaming tool calls, in OpenAI SSE chunk shape, so the AI-SDK-v7 OpenAI-compatible transport should handle it. No fine-grained parity with Anthropic's `content_block` deltas.
- **Usage-shape inconsistency** is the sharpest practical gap: `cached_tokens` appears in two different places depending on model, the API reference schema documents neither, and reading the wrong one silently returns 0 with no error. Combined with `completion_tokens_details.reasoning_tokens` existing only on reasoning models, Platos's cost catalog needs a per-model normalizer, not a single usage parser. Given the JSON-column shape-bug class already burned this codebase, coerce-at-boundary is the right pattern.
- **No SLO:** no published latency or availability SLO on serverless, and no published RPM or TPM numbers anywhere, which makes capacity planning for `agent_batch` and `spawn_agent` fan-out un-plannable on serverless.
- Also supported and not gaps: vision image inputs, logprobs (richer shape than OpenAI), embeddings, image generation, TTS, STT. Not implemented: Assistants / Threads / Runs, and the Moderations endpoint (use Llama Guard via chat completions instead).

#### Migration effort

Small for the happy path, because Together is OpenAI-compatible and Platos already has a proven OpenAI-compatible provider seam.

1. **Provider registration:** add a Together provider with base URL `https://api.together.ai/v1` and a `TOGETHER_API_KEY` secret in the scopedEnv / BYOK path, reusing the Fugu shape. Known gotcha: `scopedEnv.get()` is dashboard-only with no `process.env` fallback, so the key must be set as a scope secret, not an env var on the box.
2. **Model-string remap:** this is the real work, not the base URL. Any route pointing at `zai-org/GLM-4.5`, `GLM-4.6`, `deepseek-ai/DeepSeek-V3`, `DeepSeek-R1` or `moonshotai/Kimi-K2-Instruct` must be remapped to GLM-5.2, DeepSeek-V4-Pro and Kimi-K3 / K2.7-Code / K2.6. Update `providers_set_routes` and re-run `providers_test_credentials`.
3. **Cost catalog:** add cached-input as a third rate per model alongside input and output, then write a per-model usage normalizer reading both `usage.prompt_tokens_details.cached_tokens` and flat `usage.cached_tokens`, plus `completion_tokens_details.reasoning_tokens` for reasoning models. Coerce at the boundary; a missing field must be 0. Note the prior cost-catalog HTTP 413 body-limit incident if bulk-uploading a new rate table.
4. **Router policy:** Claude cannot route here. The router needs a hard constraint that Anthropic models never resolve to the Together provider, otherwise a fallback chain will try to send Opus or Sonnet to a provider that has no such model and fail confusingly rather than degrading.
5. **Prefix discipline:** to earn the 80% to 90% cached discount, the turn assembler must emit a byte-stable prefix (system prompt, then tool definitions, then dynamicBlocks / promptBlocks, then memory injection, then volatile user content last). The known unresolved-promptVars bug is directly cache-hostile and should be fixed before measuring cache economics.
6. **Telemetry first:** log `cached_tokens` on every Together turn and surface a cache-hit-ratio metric before making any cost projection. Because the cache is fleet-shared and best-effort with no TTL guarantee, the achievable hit rate is an empirical question that cannot be answered from docs. Do not put a cached-rate assumption into a margin model until there is a week of measured ratio.
7. **Batch adapter (optional, later):** the 50% batch discount needs a Together-shaped batch client. Worth it only for offline workloads such as memory-extraction sweeps or eval regression sweeps, not for chat turns.
8. **Decide serverless versus dedicated explicitly:** they are economically opposite. Serverless gives the cached-token price discount with unpredictable hit rate, no region control, dynamic rate limits and no SLO. Dedicated gives private always-on caching, region pinning, fixed known limits and predictable SLAs, but bills per GPU-minute so the cached discount disappears, and the batch discount does not apply. For Platos's current bursty multi-tenant agent traffic, serverless is right; dedicated only pencils at sustained high utilization on one model.

Not required: no auth rework, no SDK replacement, no streaming-transport rewrite, no tool-loop changes.

---

## 3. Comparison table

Short cells; detail lives in the sections above. All prices USD per 1M tokens unless stated.

| Provider path | Models | Caching mechanics | Representative price | Latency / regions | Migration effort |
|---|---|---|---|---|---|
| **Anthropic API direct** | Claude only (Opus 5, Sonnet 5, Fable 5, Haiku 4.5, legacy 4.x). No GLM/Kimi/Gemini. | Explicit `cache_control`, max 4 breakpoints, 5m and 1h TTL, plus automatic mode and beta cache diagnostics. Per-model, per-workspace. 20-block lookback. | Sonnet 5: 2.00 in / 0.20 hit / 10.00 out (to 2026-08-31), then 3.00 / 0.30 / 15.00. Opus 5: 5.00 / 0.50 / 25.00. Writes 1.25x (5m) or 2.0x (1h). | Global endpoint only; `inference_geo:"us"` at 1.1x. No published latency. US infra, no extra hop. | Lowest. Already wired. Work is emitting breakpoints, logging the usage triple, freezing the prefix. |
| **Claude on Vertex AI** | Same Claude lineup (some IDs `@date`-suffixed). Legacy Opus 4 / Sonnet 4 / Haiku 3.5 still live here. | Identical `cache_control`, identical 1.25x / 2.0x / 0.1x multipliers, 1h TTL on all current models. Cache scoped per GCP project. Refresh-on-access stated explicitly. | Global endpoint at exact parity with direct. `us` / `eu` multi-region at 1.1x on every category including cache reads. | Global, `us`/`eu` multi-region, some regional. Global may serve from EU or Singapore. Token mint adds a hop. No published latency. | Moderate. Two body transforms, but a new credential kind (GCP service account plus token cache), model-ID map, and loss of Batches / Models API / MCP connector / automatic caching / diagnostics. |
| **Vertex MaaS (Model Garden open models)** | GLM-5, GLM-4.7, Kimi-K2-Thinking, DeepSeek, Qwen3, Llama, MiniMax, gpt-oss. **All deprecated 2026-07-21, retired 2026-10-21** (Llama 4 excepted). | Implicit only, Preview, 90% off cached, 4,096-token minimum, `cachedContentTokenCount`. Pay-as-you-go only (no PT, no Batch). **Kimi supported; GLM absent from the list** (pricing page contradicts). | GLM-5 1.00 / 3.20 (hit 0.10, contradicted). GLM-4.7 0.60 / 2.20, no hit. Kimi-K2-Thinking 0.60 / 2.50 / 0.06 hit. | ML processing pinned US multi-region; reached via global endpoint. Good for US infra. No RPM/TPM published. | Wasted. Full GCP auth build plus per-model console enablement, then a second migration by 2026-10-21. No batch for GLM/Kimi, no token counting for open models. |
| **Gemini context caching** | Gemini only on the direct API. On Vertex, Gemini plus Claude plus open models with three different caching contracts. | Implicit on by default for 2.5+, 90% off, zero storage cost, no guarantee. Explicit `cachedContents` API: 1.0x write, 0.1x read, **plus storage rent**. Explicit is absent from the Interactions API. | 3.6 Flash 1.50 / 0.15 / 7.50. 3.1 Pro Preview 2.00 / 0.20 / 12.00 (doubles above 200k tokens). Storage 1.00 (Flash) or 4.50 (Pro) per 1M tokens per hour. | Direct: one global endpoint, API key. Vertex: region-qualified, and **explicit caches are region-pinned**. No published latency. | Implicit only: small (prefix discipline). Explicit: large, needs a token-hours cost dimension the catalog lacks plus cache-object lifecycle. Two repo bugs found (see 2.4). |
| **Together.ai** | GLM-5.2, Kimi K3 / K2.7-Code / K2.6, DeepSeek-V4-Pro, Qwen3.x, Llama 3.3, MiniMax-M3, gpt-oss. **No Claude, no Gemini.** | Automatic prefix caching, real price discount, no write premium, no toggle. Best-effort, fleet-shared, no TTL and no minimum published. Per-model gated. Dedicated gives private cache but no token discount. | GLM-5.2 1.40 / 0.26 / 4.40. Kimi K3 3.00 / 0.30 / 15.00. Kimi K2.6 1.20 / 0.20 / 4.50. DeepSeek-V4-Pro 1.74 / 0.20 / 3.48. | North America data centers, no region selection on serverless, no SLO, no RPM/TPM published. Same-continent from Render and Trigger. | Smallest for a new provider. Bearer key into existing BYOK seam. Real work is the model-string remap, a third cached rate, and a per-model usage normalizer (two `cached_tokens` locations). |

---

## 4. Cache-prefix stability audit

*The section below is reproduced verbatim from the Workstream A audit input, because it is what determines whether any of the provider choices above actually deliver a cache hit.*

## Cache-prefix stability audit

*Audited at `e5c5bbe` ("feat(caching): cache the message history, not just the system prompt"). Anthropic's cache key is the exact bytes of `tools → system → messages` up to each `cache_control` marker, so everything below is judged as "does this byte change between two requests that should share a prefix".*

**Verdict summary**

| # | Finding | Class |
|---|---|---|
| 1 | `prepareStep` re-marking **accumulates** breakpoints; provider silently drops the newest once >4 | **CACHE-FATAL** (from step 2 of every multi-step turn) |
| 2 | Layer‑1 Redis prompt-cache HIT **double-appends** 3 system blocks | **CROSS-TURN-FATAL** (once per 10‑min TTL cycle) |
| 3 | Skill tools + skill prompt block are **skipped entirely** on a Layer‑1 cache hit | **CROSS-TURN-FATAL** + functional bug |
| 4 | `{{user.current_time}}` auto-injected then substituted **into the system prompt** | **CROSS-TURN-FATAL** (ms-precision timestamp) |
| 5 | `assembleAsync` bakes the datetime block + `current_date` into the system prompt for retrieval-block agents | **CROSS-TURN-FATAL** |
| 6 | CTX.6 arg-expectations block ordered by in-memory registry **Map iteration order**, appended after the Layer‑1 write | **CROSS-TURN-FATAL** under registry churn / multi-replica |
| 7 | `## Available tool categories` embeds live **counts** in the system prompt | **CROSS-TURN-FATAL** (summary/hybrid modes) |
| 8 | `find_tools` description embeds `Available entities: …` from per-turn sessionContext | **CROSS-TURN-FATAL** (if `entity_ids` varies) |
| 9 | Skill tools appended to the `tools` object from an **unordered** `findMany` | **CROSS-TURN-FATAL** (probabilistic) |
| 10 | MCP discovery cron **guarantees** a mid-thread toolset refresh every ~5 min, with delete+re-add reordering | **CROSS-TURN-FATAL**, unavoidable today |
| 11 | `run()` (batch / tasks / run-once) sets **no breakpoint at all**; Vertex/Bedrock Claude excluded | missed optimization, 100% loss |
| 12 | `__datetime` / `__memory` / `__user_profile` / `__compacted_summary` land post-breakpoint in the `<context>` wrap | **SAFE** (correctly done) |
| 13 | Meta-tool key insertion order; `delegate_to_sub_agent` / sub-agent `execute_tools` counts; canary `Math.random` | **SAFE** |

---

### 1. Message-array breakpoints accumulate across steps and the newest one gets dropped — CACHE-FATAL

`agent.service.ts:6015-6021` re-applies breakpoints on every internal step:

```ts
prepareStep: ({ messages: stepMessages }: any) => ({
  messages: withAnthropicCacheBreakpoints(stepMessages as unknown as CacheableMessage[]) as any,
}),
```

Three facts collide:

1. `withAnthropicCacheBreakpoints` is **additive only** — `anthropic-cache-breakpoints.ts:127` returns non-selected messages untouched (`if (!targets.has(i)) return m;`), so any `cacheControl` a message already carries survives.
2. The AI SDK **carries the override forward**. `apps/agent/node_modules/ai/dist/index.js:8845`:
   `stepMessagesForNextStep = [...currentStepMessages, ...stepResponseMessages]` where `currentStepMessages` *is* the `prepareStep` return (`index.js:9270`). So step N+1's input already contains step N's markers.
3. `selectBreakpointIndices` (`anthropic-cache-breakpoints.ts:85-110`) walks **backwards from the new tail**, so step N+1 picks *different* indices than step N.

Net: step 0 → 3 message marks + 1 system = 4 (at budget). Step 1 → up to 6 message marks + system = 7. The Anthropic provider does not error; it **counts in document order and drops the overflow** (`@ai-sdk/anthropic/dist/index.js:1214-1248`, `MAX_CACHE_BREAKPOINTS = 4`, "This breakpoint will be ignored"), and `convertToAnthropicPrompt` runs *before* `prepareTools` (`index.js:3691` then `3957`), i.e. system first, then messages ascending. The four surviving markers are therefore the system message plus the three **oldest/deepest** message marks — the trailing head breakpoint, the only one that matters for the next step's read, is exactly the one discarded.

So WORKSTREAM A is a no-op from step 2 onward and reproduces the 1.68M-token trace it was written to fix, while also burning cache *writes* at stale positions.

**Fix:** make `withAnthropicCacheBreakpoints` authoritative — strip `providerOptions.anthropic.cacheControl` from every non-system message before applying the new selection (delete the key entirely when the resulting `anthropic` object is empty, to keep bytes clean). Add a unit test asserting `countMarkers(apply(apply(msgs)))` stays ≤ 3 after simulating 5 appended steps. Also assert `<= 4` total including system.

### 2. Layer-1 prompt-cache hits double-append three system blocks — CROSS-TURN-FATAL

The Redis Layer‑1 cache stores the prompt **after** the three trailing splices, then a hit re-runs them:

- read: `agent.service.ts:5058-5067` → `systemPrompt = cached`
- `## Available tool categories` splice: `5346-5350` (unconditional)
- `renderMemoryGuidanceBlock`: `5357-5366` (unconditional)
- `contextEnvelopeHint`: `5371-5381` (**always** non-empty)
- write, miss-only: `5385-5393`

Turn 1 (miss) system prompt = `…X`. Turn 2..N (hit) = `…X + X`. The `## How to read <context> blocks` block, the memory/profile guidance, and the category summary are all duplicated verbatim in the prompt on every cache-hit turn, and turn 1's prefix never matches turn 2's. With `TTL_SEC = 600` (`prompt-cache.service.ts:20`) this forces one full `cache_creation` every 10 minutes on top of the wasted tokens.

**Fix:** move the three splices *above* the `promptCache.get`, or gate each on `!promptCacheHit` (matching the skill block at `5263`). The cleanest version is to make the Layer‑1 cache hold the *fully assembled* stable prefix and have every splice site live inside the `if (!promptCacheHit)` branch.

### 3. Skill tools are silently dropped on every cache-hit turn — CROSS-TURN-FATAL

`agent.service.ts:5263`:

```ts
if (!promptCacheHit && this.skillRuntime && scope.agentId) {
```

That single gate wraps both the prompt-block composition *and* the live tool registration loop (`tools[pt.name] = {…}` at `5297`) plus `skillToolIndex.push` (`5316`). On a cache hit the agent loses every skill-provided tool from the `tools` object and `find_tools` can no longer see them — for the whole 10-minute TTL window. The `run()` path does this **unconditionally** (`6480-6486`), so the two paths disagree.

Cache impact: the `tools` block membership flips between the first turn after a miss and all subsequent turns → whole-prefix invalidation. Functional impact is worse than the cache one.

**Fix:** split the block — prompt composition may be skipped on a hit, tool registration must not. Hoist the `loadForAgent` call out of the gate and only guard the `composeSystemPrompt` line.

### 4. `{{user.current_time}}` puts a millisecond timestamp in the system prompt — CROSS-TURN-FATAL

`agent.service.ts:4723` unconditionally injects into `sessionContext`:

```ts
current_time: ctx?.["user.current_time"] ?? new Date().toISOString(),
```

and `5541-5548` substitutes into the system prompt via `substitutePromptVars`, which — with no `promptVars` allowlist configured — resolves **any** dotted key present in the bag (`context-resolver.ts:216-228`: `allow = … : null`). The comment at `4705` actively advertises `{{user.current_time}}` as a supported prompt variable.

Critically, the Layer‑1 cache does **not** mask this: the cached value is stored pre-substitution (`5382-5384` "Written BEFORE substitutePromptVars so the cached value is template-like"), so the timestamp is re-rendered fresh on every turn including cache hits.

Any agent whose prompt blocks, dynamic blocks, or skill prompt blocks contain `{{user.current_time}}` gets a brand-new system prefix every turn → zero cross-turn cache, forever.

**Fix:** (a) exclude volatile keys from prompt-var substitution — keep a denylist (`user.current_time`, anything time-shaped) enforced inside `substitutePromptVars`, and (b) route the value to `dynamicContext.__datetime` instead so it lands after the breakpoint. Optionally truncate to minute precision if it must stay, which at least caps invalidation to once/minute.

### 5. `renderDateTimeBlockText` lands correctly — but `assembleAsync` does not

**SAFE path (the intended one):** `agent.service.ts:5565-5587` renders the datetime block and writes it to `dynamicContext.__datetime`; `5594-5601` orders it first in the `<context>` wrap; `5619-5621` prepends the wrap to the **current user message only**. That is after the system breakpoint, and the wrap is never persisted (`agent-task.service.ts:581-583` stores raw `content: message`), so it never pollutes replayed history either. Correctly done, and the design comment at `5559-5564` is accurate.

**CROSS-TURN-FATAL path:** for agents with an enabled `retrieval` block, `5095-5149` re-assembles the whole prompt through `promptBuilder.assembleAsync`, which:
- pushes a **live** datetime block straight into the prompt parts (`prompt-builder.service.ts:325-328` → `renderDateTimeBlock` → `199-207`, second-precision `toISOString()`), and
- seeds `current_date: new Date().toISOString().slice(0,10)` into the variable bag (`prompt-builder.service.ts:305`) so `{{current_date}}` renders inline (invalidates at UTC midnight).

Same hazard in the `run()` path at `6426`.

Adjacent bug worth fixing in the same change: the Layer‑1 **write** at `5385` has no `hasRetrievalBlock` guard despite the comment at `5052` claiming retrieval agents skip the cache. A retrieval agent therefore stores message‑A's retrieved chunks in Redis and serves them for 10 minutes to unrelated messages (`5099-5100` also skips re-retrieval on a hit). Byte-stable, semantically wrong.

**Fix:** have `assembleAsync` skip `datetime` blocks entirely (they are the runtime's job now) and drop `current_date` from its default vars; add `&& !hasRetrievalBlock` to both the Layer‑1 read and write gates.

### 6. CTX.6 arg-expectations block is ordered by in-memory Map iteration — CROSS-TURN-FATAL under churn

`agent.service.ts:5497-5515` builds the block from `toolRegistry.getScopedTools(...)` and appends it to `systemPrompt` at `5531` — **after** the Layer‑1 cache write (`5385`), so it is recomputed from live state on every single turn, hit or miss.

Two volatility sources:

1. **Order.** `getScopedTools` → `collectScopedEntries` (`tool-registry.service.ts:524-538`) iterates `this.scopedToolCache.entries()` and `bucket.values()` — JS `Map` insertion order. Buckets are seeded by `rebuildIndex` with `platosEntityToolMapping.findMany({...})` and **no `orderBy`** (`tool-registry.service.ts:139-142`), so the order is whatever Postgres returns and differs per process. Two agent replicas serving the same thread therefore emit different byte orders → every replica switch is a full invalidation. Within a process, `reconcileEntityTools` can `bucket.delete(...)` and `scopedToolCache.delete(key)` (`tool-registry.service.ts:496-497`) and a subsequent `registerTools` re-inserts at the **end** of the Map → order flips mid-thread.
2. **Membership.** The auto-match tier only resolves to `session` when the key is *present in this turn's* sessionContext (`context-automap.service.ts:333`: `resolvePath(sessionContext, declared) !== undefined`). A key present on turn 1 and absent on turn 2 flips that param from injected→LLM-fill, which **adds a bullet line** to the block (`context-automap.service.ts:439-449`). The docblock at `context-automap.service.ts:429-431` claims "value changes don't shift the block" — true for values, false for key presence.

The same block is spliced into the sub-agent system prompt via `subAgentArgHintHolder` (`4373-4375`), so sub-agent prefixes inherit the instability.

**Fix:** sort deterministically before rendering — `scopedTools.sort((a,b) => a.toolName.localeCompare(b.toolName))` at `5507`, and add `orderBy: [{ tool: { name: "asc" } }]` to `rebuildIndex`'s `findMany`. For the membership flip, resolve auto-match against `declaredKeys` alone (config, stable) rather than live key presence, and let `applyResolutions` fail open at dispatch time as it already does (`context-automap.service.ts:417-419`).

### 7. Category-summary counts are live numbers in the system prompt — CROSS-TURN-FATAL (summary/hybrid)

`categoryCounts` is derived from the live registry (`agent.service.ts:4262-4285`), rendered as `- **email** (12 tools) — …` (`prompt-builder.service.ts:585-596`), and spliced into `systemPrompt` at `5346-5350`. Any entity registering/pruning one tool changes a digit and wipes the whole prefix. Partially masked by the Layer‑1 cache (the block is stored, per §2) which means the count is *also* stale for up to 10 minutes — wrong either way.

**Fix:** drop the numeric count (the category name + description carries the useful signal), or bucket it (`"a dozen+ tools"`). If the count must stay, compute it once per (agent, versionId) and cache it alongside the prompt so it changes only when the prompt does.

### 8. `find_tools` description embeds per-turn entity IDs — CROSS-TURN-FATAL if `entity_ids` varies

`agent.service.ts:1678-1679` → `1713`:

```ts
const _entityHint = _findToolsEntityIds.length > 0
  ? ` Available entities: ${_findToolsEntityIds.map((e) => `"${e}"`).join(", ")}. Pass source to restrict to one entity.`
  : "";
```

`_findToolsEntityIds` is read from this turn's `sessionContext[entity_ids]` (`1670-1675`). Tools are the *first* thing in the Anthropic prefix, so any change here invalidates system + everything. Membership changes are semantically intended; **order** changes are not — a caller that builds `entity_ids` from a `Set`, an object's keys, or a DB query without `ORDER BY` will hand Platos a different permutation per turn and pay full price every time, invisibly.

**Fix:** `[..._findToolsEntityIds].sort()` before rendering the hint. Also consider moving the hint out of the tool description into the `<context>` wrap, which makes it free.

### 9. Skill-tool insertion order is non-deterministic — CROSS-TURN-FATAL (probabilistic)

Meta-tool key order itself is **SAFE**: `buildMetaTools` assigns keys in a fixed source-order sequence gated only by config booleans (`agent.service.ts:1659` init, `1711`, `1841`, `1978`, `2029`, … `4058`), and the `delete tools.execute_tools` / discretionary strips (`4154`, `4200`) and the `find_tools` re-wrap (`4301`, which reassigns an existing key and so preserves its position) do not perturb the order of surviving keys. Same config → same order, every turn, every step.

Skill tools break it. They are appended after the meta-tools in `payload.providedTools` order (`agent.service.ts:5297`), which traces back to `platosAgentSkill.findMany({...})` with **no `orderBy`** (`skill-registry.service.ts:320-328`). Postgres heap order changes when a row is updated (e.g. toggling `enabled`), so two consecutive turns can emit `{…, tool_b, tool_a}` vs `{…, tool_a, tool_b}` — same tools, different bytes, full invalidation. The same unordered list also determines skill prompt-block order inside `## Enabled Skills` (`skill-runtime.service.ts:80-106`).

**Fix:** `orderBy: [{ skill: { skillId: "asc" } }]` in `listForAgent`, and sort `providedTools` by `name` in `merge()`.

### 10. Mid-thread toolset refresh is guaranteed, not hypothetical

`entity-mcp-discovery-scheduler.service.ts:44` runs `@Cron(CronExpression.EVERY_MINUTE)` and re-discovers any MCP entity whose `lastDiscoveryAt` is older than `PLATOS_MCP_DISCOVERY_INTERVAL_SEC` (**default 300s**, line 73). Each pass calls `registerTools` + `reconcileEntityTools` per env (`entity-mcp-discovery.service.ts:147`, `167`), and reconcile does `bucket.delete(...)` / `scopedToolCache.delete(key)` (`tool-registry.service.ts:496-497`).

So for any org with an MCP-kind entity, the registry mutates roughly every 5 minutes — the same order of magnitude as Anthropic's 5-minute cache window. What it costs today:

- The `tools` block itself is **not** affected (entity tools are not first-class `CoreTool`s; they live behind `execute_tools`) — good.
- The **system prompt** is: the category-count block (§7) and the CTX.6 block (§6) both re-derive from the registry, and a delete+re-add reorders the CTX.6 block.
- A wire-entity WS reconnect, `entities_set_tool_acl` / `setToolEnabled`, or a `linkedAgentIds` flip via `syncEntityLinkedAgents` (`tool-registry.service.ts:403-415`) does the same on demand.
- Skill enable/disable changes `tools` membership → true whole-prefix invalidation (this one does correctly bust Layer‑1: `skills.controller.ts:175`, `200`).

Cost of one invalidation: the entire `tools + system` prefix is re-billed at the 1.25× cache-write rate instead of the 0.1× read rate — a **12.5× multiple on the prefix** for that request. For a Walle-sized prefix this is the single largest recurring waste after §1.

**Mitigation:** the fixes in §6/§7 remove the registry from the prefix almost entirely — that is the real answer. Beyond that, make the refresh a no-op when nothing changed: `registerTools` already computes `schemaHash`, so compare the full scoped-matrix hash and skip cache mutation when it is unchanged, and never `delete`+re-`set` a bucket key that is being re-registered with the same hash.

### 11. `run()` has no breakpoint at all; Vertex/Bedrock Claude excluded

- `agent.service.ts:6688` passes `instructions: systemPrompt` to `generateText` with **no** `providerOptions` anywhere on the call. Every non-streaming turn — `agent_batch` per-item turns, run-once, cron/task handlers, admin summaries — pays full price for the entire prompt, on every item. For a batch of N items over one agent this is the highest-leverage single-line fix in the file.
- The breakpoint gate is `provider === "anthropic"` (`5447`, from `agentConfig.model.split(":")[0]` at `5040`). `anthropic-cache-breakpoints.ts:140-147` exports `isAnthropicCacheablePath` — which correctly accepts `vertex:claude-…` — and it is **never imported by production code** (only by its own test). Claude served through Vertex/Bedrock gets zero caching despite an identical `cache_control` wire format.

**Fix:** in `run()`, move the system prompt into a `messages[]` entry with `providerOptions.anthropic.cacheControl` (mirroring `5675-5688`) and pass `allowSystemInMessages: true`; replace both provider gates with `isAnthropicCacheablePath(agentConfig.model)`.

### 12. Post-breakpoint injections — SAFE (and the design is right)

- `__memory` → `agent.service.ts:5258` writes into `dynamicContext`, not `systemPrompt`. The comment at `5246-5256` documents exactly why. Correct.
- `__user_profile` → `agent-task.service.ts:655`, `__compacted_summary` → `agent-task.service.ts:601`. Both post-breakpoint.
- Ordering of the wrap is explicitly stabilised: `agent.service.ts:5594-5599` fixes `__datetime, __compacted_summary, __user_profile, __memory` then sorts the caller-supplied keys alphabetically. Deterministic. (Minor unrelated note: any *new* `__`-prefixed key not in that literal list is silently dropped by the `.filter`.)
- Compaction does **not** mutate history — it only appends to `thread.compactedSummary` (`agent-task.service.ts:1614-1632`); messages keep `status: "active"`. So a compaction run changes only the tail of the current user message.
- `renderMemoryGuidanceBlock` (`5357-5366`) and `contextEnvelopeHint` (`5371-5381`) are pure functions of config/constants — stable bytes (their only problem is the duplication in §2).

### 13. Per-step randomization — none reaches the prefix

Scanning `stream()` for volatile sources yields only: `4723` (`user.current_time`, → §4), `5063`/`5075` (latency logging), `5742` and `6221` (`timestamp` on `trace_request` / `trace_step`, both *yielded events*, never in the prompt). No `uuid`, `nonce`, or `Math.random` reaches `tools`, `system`, or early messages.

Canary routing does use `Math.random()` (`1219`) but only on the **first** turn of a thread, then persists `lockedVersionId` (`1262-1266`) with a race-loser re-read (`1273-1291`) — so `versionIdUsed`, and therefore the entire prompt, is pinned for the life of the thread. Correct by design.

`hardenToolResults` (`5989`) stamps `__platosResultHardened` onto each tool object, but the Anthropic provider serialises only `name` / `description` / `input_schema` (`@ai-sdk/anthropic/dist/index.js:1607-1611`), so the marker never reaches the wire. Also idempotent, so re-running it per turn does not double-wrap.

Counts embedded in descriptions that are **config**-derived, not registry-derived, are safe: `delegate_to_sub_agent`'s `${enabledTools.length}` (`4125`) and the sub-agent's `Execute one of the ${args.enabledTools.length} available tools.` (`4391`) both read `toolsBlockConfig.enabledTools` (`4123`), a stored array.

### 14. History re-derivation — SAFE for the system breakpoint, but the message-array cache can only ever work intra-turn

`loadHistory` (`memory/conversation.service.ts:1435-1455`) is a sliding window: `orderBy: { createdAt: "desc" }, take: limit`, then `.reverse()`. Three structural consequences:

1. Once the thread exceeds `contextLimit`, the **oldest message drops each turn**, so `messages[1]` changes turn over turn. Harmless for the system breakpoint (it sits before history) but it means a breakpoint placed deep in history is unreusable across turns.
2. `status: "active"` filtering means **edit-and-rerun soft-deletes rewrite earlier history** — an intentional invalidation, but worth knowing it costs a full prefix rebuild.
3. `role: { in: ["user","assistant"] }` means **tool_use / tool_result blocks are never replayed**. Turn N's request (with 17 tool blocks) and turn N+1's history (text only) diverge structurally, and turn N's user message was sent `<context>`-wrapped while turn N+1 replays it raw (`agent-task.service.ts:583` persists raw). So the byte-identical prefix shared between two turns ends at the last assistant message *before* the current turn.

Combined with the ~20-block lookback, the message-array breakpoints added in `e5c5bbe` deliver value **within** a turn (which is where the 1.68M-token incident lived) and essentially none across turns. That is fine — but it makes §1 the whole ballgame: if the trailing breakpoint is being dropped from step 2 onward, the feature currently delivers nothing at all.

Sub-thread replies add a fourth wrinkle: `loadHistory:1486-1494` injects a `[Sub-thread context: …"${parentContent}"…]` framing message *mid-array*, so a thread that alternates main-thread and sub-thread turns has a different history shape per turn by construction.

---

### Recommended fix order (by expected saving per unit of work)

1. **§1** strip-before-apply in `withAnthropicCacheBreakpoints` — one function, restores the entire multi-step fix.
2. **§2 + §3** move the three splices inside the `!promptCacheHit` branch and ungate skill-tool registration — one small refactor, fixes a cache break *and* a live functional bug.
3. **§11** add a `cacheControl` breakpoint to `run()` and switch both gates to `isAnthropicCacheablePath` — two lines, unlocks caching for every batch/task turn.
4. **§4** deny volatile keys in `substitutePromptVars` and route `current_time` to `__datetime`.
5. **§6 + §9 + §8** deterministic sorting: `scopedTools` by name, `platosAgentSkill.findMany` `orderBy`, `entity_ids` sort, `rebuildIndex` `orderBy`.
6. **§7 + §5** remove live counts from the prompt; make `assembleAsync` stop rendering datetime/`current_date`; add `hasRetrievalBlock` to both Layer‑1 gates.
7. **§10** hash-compare the scoped matrix in the discovery sweep so an unchanged refresh mutates nothing.

---

## 5. Recommendation

Three questions, three committed answers.

### 5.1 Where should CLAUDE be served?

**Verdict: Anthropic API direct stays the primary. Claude on Vertex AI becomes a documented secondary that Platos builds only when a customer requires it.**

Reasoning:

- **Price parity means Vertex buys nothing on cost.** On the global endpoint, Vertex matches Anthropic direct to the cent on every Claude model and every cache column, and the `us` or `eu` multi-region endpoints cost exactly 1.1x, including on cache reads. There is no arbitrage. If Platos moves Claude to Vertex it pays the same or 10% more.
- **Anthropic direct has strictly more caching surface.** Automatic caching (a single top-level `cache_control`, breakpoint auto-advancing as the thread grows) and cache diagnostics (typed `cache_miss_reason`) are both Claude-API-only and both absent on Google Cloud. Given that section 4 lists 10 distinct prefix-instability defects, a typed answer to "why did this miss" is worth more to Platos right now than any other single feature on any path. Anthropic direct also has Message Batches (50% off, stacking with caching), the Models API, mid-conversation system messages and mid-conversation tool changes; the last two map directly onto Platos's dynamic prompt-blocks and per-entity tool ACLs, which today force a full cache rebuild.
- **Vertex's cost is credential complexity.** A GCP service-account credential kind plus a token minter and cache, `projectId` and `location` as provider config, a per-model console enablement step that does not fit self-serve BYOK, and a model-ID mapping table where Anthropic and Google publish different suffix conventions for the 4.5-era models.
- **The tradeoff, stated honestly.** Vertex is genuinely worth keeping documented for three reasons: `cache_control` is byte-identical so the whole caching strategy is portable at zero change; Vertex's default quotas for current models (Sonnet 5 at 2,500 QPM and 25M input TPM on the global endpoint) are far more generous than typical first-party tiers; and Vertex still serves Claude Opus 4, Sonnet 4 and Haiku 3.5, which are retired on the first-party API. If Platos hits a first-party rate ceiling or a customer demands GCP billing or EU residency, Vertex is the answer, and it is a two-body-field transform plus an auth build, not a rewrite.
- **Caching Platos gets on the chosen path:** explicit `cache_control` with up to 4 breakpoints, 5-minute and 1-hour TTLs, 1.25x / 2.0x write and 0.1x read multipliers, plus automatic mode and beta cache diagnostics. That is the best caching contract available anywhere in this document.

Actions on this path, in priority order: fix section 4 finding 1 (nothing else matters until the trailing breakpoint stops being dropped); then findings 2, 3 and 11; then adopt automatic caching or keep explicit breakpoints deliberately budgeted against the 4-breakpoint ceiling and the 20-block lookback; then wire cache diagnostics behind a flag.

**Operator decisions needed.** (a) **Sonnet 5 price step:** the introductory USD 2.00 / USD 10.00 per 1M tokens rate ends 2026-08-31 and becomes USD 3.00 / USD 15.00 on 2026-09-01. The cost catalog needs a dated entry now, and any margin model keyed to USD 2.00 is wrong in 32 days. Walle runs on Sonnet 5. (b) **Cache tenancy:** caches never cross Anthropic organizations and never cross workspaces on the Claude API. Decide explicitly whether Platos tenants share one workspace (shared cache pools, cheaper, weaker isolation) or get per-tenant workspaces or keys (N cold writes for the same shared system prompt, stronger isolation). This intersects the existing scope-tuple and operator-tier boundary work and is a security decision, not an engineering one. (c) **Model pinning versus routing:** `model_changed` is a first-class cache-miss reason that explicitly names routers and fallbacks. Either pin the model for the life of a cached thread or accept cold writes on every reroute; pick one and stop attributing the cost to the model.

### 5.2 Where should GLM be served?

**Verdict: Together.ai, on `zai-org/GLM-5.2`. Do not route GLM to Vertex.**

Reasoning:

- **Vertex GLM is being withdrawn.** GLM-5 and GLM-4.7 MaaS were deprecated on 2026-07-21 and retire on 2026-10-21, after which "API requests calling a retired model ID will fail." Google further states that during the deprecation window "new use of the endpoint may be restricted", and Platos is not an existing workload, so onboarding may be blocked outright. Any adapter built now has an approximately three-month payback window followed by a second migration.
- **Vertex GLM has no confirmed caching anyway.** GLM is absent from the open-model context-caching supported-model list (which names only Qwen3-Coder, Kimi-K2-Thinking, MiniMax-M2, gpt-oss-20b, DeepSeek-V3.1, DeepSeek-V3.2 and Gemma 4). The pricing page publishes a USD 0.10 per 1M tokens cache-hit rate for GLM-5, which contradicts the caching doc; that contradiction is unresolved and is flagged as NOT CONFIRMED. GLM-4.7 has no cache-hit line at all. So the "cheaper" path is also probably the uncached path.
- **Vertex GLM also has no batch and no thinking.** Both GLM model cards state "Batch inference: Not supported" and both state thinking is not supported, which is notable for a model pitched at long-horizon agentic tasks.
- **Together carries the current version with caching and trivial auth.** GLM-5.2 at USD 1.40 input / USD 0.26 cached input / USD 4.40 output per 1M tokens, 262,144 tokens context, up to 128k output tokens, thinking on by default, tool calling plus streaming tool calls plus structured outputs. Auth is a bearer key into the existing scopedEnv / BYOK seam, i.e. the Sakana Fugu shape, with no OAuth build.
- **The tradeoff, stated honestly.** Together costs roughly 29% more on input and 27% more on output than Vertex's GLM-5 sticker price, and Together's cached discount (approximately 81%) is shallower than Vertex's claimed 90%. Together also publishes no TTL, no minimum prefix length, no RPM or TPM numbers and no serverless SLO, and its cache is fleet-shared and evicts as traffic shifts, so the achievable hit rate is an empirical question. That premium buys a live product instead of one with an 83-day fuse.
- **Caching Platos gets on the chosen path:** automatic prefix caching, longest-matching-prefix only, no write premium, no toggle, billed at USD 0.26 per 1M cached input tokens versus USD 1.40 standard. Best-effort with no TTL guarantee. Reported via `usage.prompt_tokens_details.cached_tokens` (GLM-5.2 is a reasoning model and uses the nested shape).

**Operator decisions needed.** (a) A Together.ai account and API key, stored as a scope secret (not a box env var; `scopedEnv.get()` has no `process.env` fallback). (b) Accept the price premium versus Vertex's expiring rate, explicitly, or self-host GLM on GPUs, which contradicts the serverless posture. (c) Model-string remap: `zai-org/GLM-4.5`, `GLM-4.5-Air` and `GLM-4.6` are absent from Together's live catalog with no deprecation notice, so any existing route table pointing at them fails opaquely. (d) Accept no serverless SLO and no published rate limits, which makes `agent_batch` and `spawn_agent` fan-out capacity un-plannable from docs; measure it.

### 5.3 Where should KIMI be served?

**Verdict: Together.ai, on `moonshotai/Kimi-K2.6` for general agent work and `moonshotai/Kimi-K2.7-Code` for code-shaped work. Reserve `Kimi-K3` for cases that need the 1M-token context, because it is 2.5x the input price of K2.6.**

This is the closer call of the two, and the honest version is that Vertex is genuinely cheaper and genuinely does cache Kimi, and we are still not choosing it.

Reasoning:

- **Vertex is cheaper and Kimi is actually on its caching list.** `kimi-k2-thinking-maas` at USD 0.60 input / USD 2.50 output / USD 0.06 cached input per 1M tokens, with 262,144 tokens context and output, thinking supported, and implicit caching at 90% off with a 4,096-token minimum. Against Together's Kimi K2.6 (USD 1.20 / USD 4.50 / USD 0.20) that is roughly 2x cheaper on input, 1.8x on output and 3.3x on cached input. Unlike GLM, this is a real caching offer on a real supported model.
- **It still retires on 2026-10-21.** Same deprecation, same restriction on new use, same requirement for a second migration inside three months. Kimi's only documented continuation on Vertex is self-deploying on Model Garden, which means renting GPUs and abandoning pay-per-token.
- **The consolidation argument fails.** The tempting shape is "one GCP credential for Claude plus GLM plus Kimi". It does not hold: Claude on Vertex uses the Anthropic message format via `rawPredict` while open models use OpenAI `chat/completions`, so that is two adapters sharing only an auth layer; GLM has no caching there; and the open-model half expires in October. You would build two adapters plus a GCP auth stack and keep one of them for 83 days.
- **Building the same adapter twice is the real cost.** Routing Kimi to Vertex means the full GCP build (service-account credential kind, token minter with background refresh, `project_id` and `location` provider fields, manual per-model console enablement, a third cached-token field name `cachedContentTokenCount` alongside Anthropic's `cache_read_input_tokens` and OpenAI's `prompt_tokens_details.cached_tokens`) for one model family, and then a migration to Together anyway. Keeping Kimi next to GLM on Together means one bearer key, one adapter, one usage normalizer, one telemetry surface.
- **The tradeoff, stated honestly.** This decision costs real money: approximately 2x on Kimi input tokens and approximately 3.3x on cached Kimi input tokens versus Vertex's rate, for as long as that Vertex rate exists. If Kimi becomes a high-volume lane for Platos before October and the measured spend delta is large, revisit it as a deliberate, dated, throwaway integration with a calendared removal on 2026-10-21, not as a permanent path. Also note Together's Kimi catalog has moved past `Kimi-K2-Thinking` entirely, so this is not even a like-for-like model comparison.
- **Caching Platos gets on the chosen path:** automatic prefix caching at USD 0.20 per 1M cached input tokens against USD 1.20 standard on K2.6 (approximately 83% off), and USD 0.19 against USD 0.95 on K2.7-Code (80% off), or USD 0.30 against USD 3.00 on K3 (90% off). No write premium, no toggle, best-effort, no TTL published.

**Operator decisions needed.** (a) Which Kimi version is the default: K2.6 (cheapest cached, 262,144 tokens context), K2.7-Code (cheapest input, code-oriented), or K3 (1M tokens context at USD 3.00 per 1M input tokens). This is a product-behaviour call, not a cost call. (b) Accept the approximately 2x input-token premium versus the expiring Vertex rate, or fund a deliberately temporary Vertex Kimi integration with a removal date. (c) `moonshotai/Kimi-K2-Instruct` is absent from Together's live catalog, so any route pinning it must be remapped.

### 5.4 What has to happen before any of this matters

The provider choice above is worth roughly a 10x reduction on the input leg of an agent turn, and section 4 says Platos currently captures approximately none of it.

**The single most important cache-prefix risk is section 4 finding 1.** `prepareStep` re-applies `withAnthropicCacheBreakpoints` on every internal step, that function is additive only, and the AI SDK carries the previous step's `cacheControl` markers forward into the next step's input. Markers therefore accumulate (4 at step 0, up to 7 at step 1), and the Anthropic provider does not error; it counts in document order and silently drops the overflow with "This breakpoint will be ignored". Because `convertToAnthropicPrompt` emits system first and then messages ascending, the four survivors are the system message plus the three oldest and deepest message marks. The trailing head breakpoint, the only one that can serve the next step's read, is exactly the one discarded.

Net effect: the message-history caching merged at `e5c5bbe` is a no-op from step 2 onward, it reproduces the 1.68M-token trace it was written to fix, and it additionally burns cache writes at stale positions. The fix is to make `withAnthropicCacheBreakpoints` authoritative by stripping `providerOptions.anthropic.cacheControl` from every non-system message before applying the new selection, deleting the `anthropic` key entirely when it ends up empty so the bytes stay clean, with a unit test asserting the marker count stays within budget across simulated appended steps.

Sequence for the whole program: fix finding 1 first, because no other change can be measured until the trailing breakpoint survives. Then findings 2 and 3 (the Layer-1 hit path double-appends three system blocks and silently drops every skill tool for the whole 10-minute TTL window, which is a functional bug as well as a cache break). Then finding 11 (`run()` sets no breakpoint at all, so every `agent_batch` item, run-once, cron and task turn pays full price; and `isAnthropicCacheablePath`, which already accepts `vertex:claude-*`, is exported but never imported by production code, so Claude on Vertex would get zero caching today even if we routed to it). Then finding 4, then the deterministic-sorting cluster (6, 9, 8), then 7 and 5, then 10.

Only after finding 1 lands is a measured cache-hit ratio meaningful, and only then should any cached-rate assumption enter a margin model, on any provider.

---

*End of Workstream B deliverable. Research date 2026-07-30. Audit anchored at commit `e5c5bbe`.*
