---
id: platos.parallel_web
name: Parallel Web Research
description: Deep web research powered by Parallel.ai — fast search with excerpts, URL→markdown extraction, long-running Task Runs, structured find-all datasets, and persistent web monitors.
version: 0.1.0
author: Platos
origin: official
spec_version: 1
tags:
  - research
  - search
  - official
required_env:
  - PARALLEL_API_KEY
provides_tools:
  - name: parallel_search
    description: Fast web research with LLM-optimized excerpts. Pass a natural-language `objective` plus up to 10 concrete `searchQueries`. Returns ranked URLs with titles, publish dates, and focused excerpts.
    inputSchema: {"type":"object","properties":{"objective":{"type":"string","description":"Natural-language research question driving the search."},"searchQueries":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":10,"description":"Concrete search queries derived from the objective."}},"required":["objective","searchQueries"]}
    handler: skill:platos.parallel_web:parallel_search
  - name: parallel_extract
    description: Extract clean markdown and objective-focused excerpts from up to 5 URLs. Handles JS-rendered pages and PDFs.
    inputSchema: {"type":"object","properties":{"urls":{"type":"array","items":{"type":"string","format":"uri"},"minItems":1,"maxItems":5},"objective":{"type":"string","description":"What to look for while extracting."}},"required":["urls","objective"]}
    handler: skill:platos.parallel_web:parallel_extract
  - name: parallel_deep_research
    description: Spawn a Parallel Task Run for deep, minutes-to-an-hour research. Returns the final structured result once the run completes. Prefer this over `parallel_search` when the question needs multi-step reasoning, cross-source synthesis, or a strict output schema.
    inputSchema: {"type":"object","properties":{"instructions":{"type":"string","description":"Detailed research instructions for the Parallel Task."},"outputSchema":{"description":"Either one of the string literals `markdown`|`text`|`auto`, or a JSON Schema object describing the desired output structure.","oneOf":[{"type":"string","enum":["markdown","text","auto"]},{"type":"object"}]},"processor":{"type":"string","enum":["lite","base","core","pro","ultra","ultra8x"],"default":"base","description":"Parallel processor tier. `lite` is fastest/cheapest; `ultra8x` is the deepest. Default `base`."}},"required":["instructions"]}
    handler: skill:platos.parallel_web:parallel_deep_research
  - name: parallel_deep_research_result
    description: Check the status/result of a previously started deep research run. Returns the full result when done, or `{ status: "running" }` if still in progress. Use when `parallel_deep_research` returned a `runId` with `status: "running"`.
    inputSchema: {"type":"object","properties":{"runId":{"type":"string","description":"The runId returned by parallel_deep_research."}},"required":["runId"]}
    handler: skill:platos.parallel_web:parallel_deep_research_result
  - name: parallel_findall
    description: Build a structured dataset of entities matching a natural-language criteria. Provide a per-row JSON Schema and get back rows.
    inputSchema: {"type":"object","properties":{"criteria":{"type":"string","description":"Natural-language description of the entities to find."},"schema":{"type":"object","description":"JSON Schema describing the shape of EACH row in the result set."}},"required":["criteria","schema"]}
    handler: skill:platos.parallel_web:parallel_findall
  - name: parallel_monitor_create
    description: Register a persistent web monitor. Parallel will periodically check the URL against the query and (optionally) POST updates to your webhook. Returns the monitor id for later management.
    inputSchema: {"type":"object","properties":{"url":{"type":"string","format":"uri","description":"Page URL to monitor."},"criteria":{"type":"string","description":"What to watch for on the page (sent to Parallel as `query`)."},"frequency":{"type":"string","description":"How often to check (e.g. `daily`, `hourly`). Optional — Parallel default applies if omitted."},"webhookUrl":{"type":"string","format":"uri","description":"Optional webhook that Parallel will POST to when the monitor fires."}},"required":["url","criteria"]}
    handler: skill:platos.parallel_web:parallel_monitor_create
---

You have access to Parallel.ai — a professional-grade web research stack. Pick the right tool for the job:

**`parallel_search`** — fast, LLM-optimized web search.
- Use for: recent events, fresh facts, quick lookups where a few ranked excerpts are enough.
- Pass an `objective` (the question driving the search) + up to 10 concrete `searchQueries`.

**`parallel_extract`** — URL → clean markdown + focused excerpts.
- Use when: you already have URLs (from `parallel_search` or the user) and need the full content, or the page is JS-rendered / a PDF.
- Up to 5 URLs per call.

**`parallel_deep_research`** — multi-minute research runs.
- Use when: the question requires multi-hop reasoning, cross-source synthesis, or a specific structured output.
- Waits up to 5 minutes inline. If still running, returns `{ runId, status: "running" }` — call `parallel_deep_research_result` with the runId to check back.
- Choose a processor: `lite` < `base` < `core` < `pro` < `ultra` < `ultra8x` (cost + depth scale up).

**`parallel_deep_research_result`** — poll an in-progress deep research run.
- Pass the `runId` from a previous `parallel_deep_research` call that returned `status: "running"`.
- Returns the full result when done; `{ status: "running" }` if still in progress.

**`parallel_findall`** — structured datasets.
- Use when: the user wants a list of entities (companies, products, papers…) matching criteria, with a consistent schema per row.
- Supply a JSON Schema describing one row; Parallel returns an array of rows matching it.

**`parallel_monitor_create`** — persistent web monitors.
- Use when: the user asks to be notified of changes on a page ("tell me when X launches", "watch this pricing page").
- Returns a monitor id. Optionally posts to a webhook when the monitor fires.

**Guidelines:**
- Always cite URLs returned by these tools with `[1](url)` footnotes — never fabricate citations.
- Prefer `parallel_search` for single-turn factual questions; escalate to `parallel_deep_research` only when the question genuinely needs it (latency + cost are higher).
- For `parallel_extract`, keep to URLs returned by `parallel_search` or explicitly given by the user.
