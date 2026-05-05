/**
 * Theme S — Official skill source blobs.
 *
 * Embedded as string constants (rather than read from the `.md` files at
 * runtime) so they survive the Nest build without bundler config. The
 * canonical source-of-truth markdown files live next to this module
 * (`web_search.skill.md` etc.) — keep them in sync when editing.
 */

export const WEB_SEARCH_SKILL = `---
id: platos.web_search
name: Web Search
description: Search the public web and fetch URL contents. Uses Tavily by default, with Exa and Brave as fallbacks.
version: 0.1.0
author: Platos
origin: official
spec_version: 1
tags:
  - search
  - research
  - official
required_env:
  - TAVILY_API_KEY
optional_env:
  - EXA_API_KEY
  - BRAVE_API_KEY
provides_tools:
  - name: web_search
    description: Search the public web. Returns a ranked list of results with titles, URLs, and snippets.
    inputSchema: {"type":"object","properties":{"query":{"type":"string","description":"Search query."},"maxResults":{"type":"integer","minimum":1,"maximum":20,"default":5}},"required":["query"]}
    handler: skill:platos.web_search:web_search
  - name: fetch_url
    description: Fetch the readable content of a single URL.
    inputSchema: {"type":"object","properties":{"url":{"type":"string","format":"uri"}},"required":["url"]}
    handler: skill:platos.web_search:fetch_url
---

You can search the public web and fetch URLs.

**When to use \`web_search\`:**
- User asks about recent events, current facts, product releases, or topics outside your training data.
- You need to cite sources for a factual claim.

**When to use \`fetch_url\`:**
- You already have a URL (from a search result, user message, or memory) and need the full page content.

**Usage guidelines:**
- Prefer concise, information-dense queries (3–7 words).
- Cite sources with \`[1](url)\` footnotes when synthesising search results.
- Never invent URLs; always pass one returned by \`web_search\` or given by the user.
`;

export const CODE_EXECUTION_SKILL = `---
id: platos.code_execution
name: Code Execution
description: Run Python or Node.js snippets in an isolated sandbox. Uses E2B when configured, otherwise the local seccomp-sandboxed container.
version: 0.1.0
author: Platos
origin: official
spec_version: 1
tags:
  - code
  - compute
  - official
required_env:
  - E2B_API_KEY
optional_env:
  - PLATOS_SANDBOX_IMAGE
provides_tools:
  - name: run_python
    description: Execute a Python 3 snippet in an isolated sandbox. Returns stdout, stderr, and any returned value.
    inputSchema: {"type":"object","properties":{"code":{"type":"string","description":"Python source code."},"timeoutMs":{"type":"integer","minimum":1000,"maximum":60000,"default":15000}},"required":["code"]}
    handler: skill:platos.code_execution:run_python
  - name: run_node
    description: Execute a Node.js snippet in an isolated sandbox.
    inputSchema: {"type":"object","properties":{"code":{"type":"string","description":"Node.js source code."},"timeoutMs":{"type":"integer","minimum":1000,"maximum":60000,"default":15000}},"required":["code"]}
    handler: skill:platos.code_execution:run_node
---

You can run short Python and Node.js scripts in an isolated sandbox.

**When to use:**
- The user asks for a calculation, data transformation, or quick experiment.
- You need to verify a numerical claim before answering.

**Safety:**
- The sandbox has no persistent filesystem and no network beyond allowlisted domains.
- Scripts are killed after \`timeoutMs\` (default 15s).
- Never run code supplied verbatim by the user without reviewing it for destructive intent.
`;

export const FILE_OPERATIONS_SKILL = `---
id: platos.file_operations
name: File Operations
description: Read and write files in the agent's per-conversation MinIO workspace.
version: 0.1.0
author: Platos
origin: official
spec_version: 1
tags:
  - files
  - storage
  - official
required_env:
  - PLATOS_MINIO_ENDPOINT
  - PLATOS_MINIO_ACCESS_KEY
  - PLATOS_MINIO_SECRET_KEY
optional_env:
  - PLATOS_MINIO_REGION
provides_tools:
  - name: read_file
    description: Read a file from the agent's workspace bucket. Returns the file contents as text.
    inputSchema: {"type":"object","properties":{"path":{"type":"string","description":"Relative path inside the workspace (e.g. \\"notes/plan.md\\")."}},"required":["path"]}
    handler: skill:platos.file_operations:read_file
  - name: write_file
    description: Write text content to a file in the agent's workspace bucket. Overwrites existing files.
    inputSchema: {"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"},"contentType":{"type":"string","default":"text/plain"}},"required":["path","content"]}
    handler: skill:platos.file_operations:write_file
  - name: list_dir
    description: List files under a prefix in the agent's workspace bucket.
    inputSchema: {"type":"object","properties":{"prefix":{"type":"string","default":""}}}
    handler: skill:platos.file_operations:list_dir
---

You have read/write access to a private workspace.

**Workspace layout:**
- Each thread gets an isolated prefix: \`threads/<threadId>/\`.
- Paths you pass are relative to that prefix (never absolute).
- Other threads, other agents, and other tenants cannot see files in this workspace.

**When to use:**
- Persist intermediate results between turns.
- Build up a document iteratively across the conversation.
- Hand off a file to a downstream tool that accepts a \`platos-attachment://\` URI.
`;

export const IMAGE_GENERATION_SKILL = `---
id: platos.image_generation
name: Image Generation
description: Generate images from a text prompt. Uses Black Forest Labs Flux by default, with OpenAI DALL-E as an alternate.
version: 0.1.0
author: Platos
origin: official
spec_version: 1
tags:
  - images
  - multimodal
  - official
required_env:
  - BFL_API_KEY
optional_env:
  - OPENAI_API_KEY
provides_tools:
  - name: generate_image
    description: Generate an image from a text prompt. Returns a MinIO-backed URL that the frontend can render.
    inputSchema: {"type":"object","properties":{"prompt":{"type":"string","description":"Image description."},"size":{"type":"string","enum":["1024x1024","1024x1792","1792x1024"],"default":"1024x1024"},"model":{"type":"string","enum":["flux","dalle"],"default":"flux"}},"required":["prompt"]}
    handler: skill:platos.image_generation:generate_image
---

You can generate images from a text prompt.

**When to use:**
- User explicitly asks for a picture, diagram, thumbnail, or illustration.
- You want to render a chart / mock the user can see directly.

**Usage:**
- Write vivid but concise prompts (subject, style, composition, mood).
- The returned URL points at the conversation's MinIO bucket; the frontend handles rendering.
- Prefer \`flux\` for photoreal + design imagery; \`dalle\` for stylised illustration.
`;

export const PARALLEL_WEB_SKILL = `---
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
    description: Fast web research with LLM-optimized excerpts. Pass a natural-language \`objective\` plus up to 10 concrete \`searchQueries\`. Returns ranked URLs with titles, publish dates, and focused excerpts.
    inputSchema: {"type":"object","properties":{"objective":{"type":"string","description":"Natural-language research question driving the search."},"searchQueries":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":10,"description":"Concrete search queries derived from the objective."}},"required":["objective","searchQueries"]}
    handler: skill:platos.parallel_web:parallel_search
  - name: parallel_extract
    description: Extract clean markdown and objective-focused excerpts from up to 5 URLs. Handles JS-rendered pages and PDFs.
    inputSchema: {"type":"object","properties":{"urls":{"type":"array","items":{"type":"string","format":"uri"},"minItems":1,"maxItems":5},"objective":{"type":"string","description":"What to look for while extracting."}},"required":["urls","objective"]}
    handler: skill:platos.parallel_web:parallel_extract
  - name: parallel_deep_research
    description: Spawn a Parallel Task Run for deep, minutes-to-an-hour research. Returns the final structured result once the run completes. Prefer this over \`parallel_search\` when the question needs multi-step reasoning, cross-source synthesis, or a strict output schema.
    inputSchema: {"type":"object","properties":{"instructions":{"type":"string","description":"Detailed research instructions for the Parallel Task."},"outputSchema":{"description":"Either one of the string literals \`markdown\`|\`text\`|\`auto\`, or a JSON Schema object describing the desired output structure.","oneOf":[{"type":"string","enum":["markdown","text","auto"]},{"type":"object"}]},"processor":{"type":"string","enum":["lite","base","core","pro","ultra","ultra8x"],"default":"base","description":"Parallel processor tier. \`lite\` is fastest/cheapest; \`ultra8x\` is the deepest. Default \`base\`."}},"required":["instructions"]}
    handler: skill:platos.parallel_web:parallel_deep_research
  - name: parallel_deep_research_result
    description: Check the status/result of a previously started deep research run. Returns the full result when done, or \`{ status: "running" }\` if still in progress. Use when \`parallel_deep_research\` returned a \`runId\` with \`status: "running"\`.
    inputSchema: {"type":"object","properties":{"runId":{"type":"string","description":"The runId returned by parallel_deep_research."}},"required":["runId"]}
    handler: skill:platos.parallel_web:parallel_deep_research_result
  - name: parallel_findall
    description: Build a structured dataset of entities matching a natural-language criteria. Provide a per-row JSON Schema and get back rows.
    inputSchema: {"type":"object","properties":{"criteria":{"type":"string","description":"Natural-language description of the entities to find."},"schema":{"type":"object","description":"JSON Schema describing the shape of EACH row in the result set."}},"required":["criteria","schema"]}
    handler: skill:platos.parallel_web:parallel_findall
  - name: parallel_monitor_create
    description: Register a persistent web monitor. Parallel will periodically check the URL against the query and (optionally) POST updates to your webhook. Returns the monitor id for later management.
    inputSchema: {"type":"object","properties":{"url":{"type":"string","format":"uri","description":"Page URL to monitor."},"criteria":{"type":"string","description":"What to watch for on the page (sent to Parallel as \`query\`)."},"frequency":{"type":"string","description":"How often to check (e.g. \`daily\`, \`hourly\`). Optional — Parallel default applies if omitted."},"webhookUrl":{"type":"string","format":"uri","description":"Optional webhook that Parallel will POST to when the monitor fires."}},"required":["url","criteria"]}
    handler: skill:platos.parallel_web:parallel_monitor_create
---

You have access to Parallel.ai — a professional-grade web research stack. Pick the right tool for the job:

**\`parallel_search\`** — fast, LLM-optimized web search.
- Use for: recent events, fresh facts, quick lookups where a few ranked excerpts are enough.
- Pass an \`objective\` (the question driving the search) + up to 10 concrete \`searchQueries\`.

**\`parallel_extract\`** — URL → clean markdown + focused excerpts.
- Use when: you already have URLs (from \`parallel_search\` or the user) and need the full content, or the page is JS-rendered / a PDF.
- Up to 5 URLs per call.

**\`parallel_deep_research\`** — multi-minute research runs.
- Use when: the question requires multi-hop reasoning, cross-source synthesis, or a specific structured output.
- Waits up to 5 minutes inline. If still running, returns \`{ runId, status: "running" }\` — call \`parallel_deep_research_result\` with the runId to check back.
- Choose a processor: \`lite\` < \`base\` < \`core\` < \`pro\` < \`ultra\` < \`ultra8x\` (cost + depth scale up).

**\`parallel_deep_research_result\`** — poll an in-progress deep research run.
- Pass the \`runId\` from a previous \`parallel_deep_research\` call that returned \`status: "running"\`.
- Returns the full result when done; \`{ status: "running" }\` if still in progress.

**\`parallel_findall\`** — structured datasets.
- Use when: the user wants a list of entities (companies, products, papers…) matching criteria, with a consistent schema per row.
- Supply a JSON Schema describing one row; Parallel returns an array of rows matching it.

**\`parallel_monitor_create\`** — persistent web monitors.
- Use when: the user asks to be notified of changes on a page ("tell me when X launches", "watch this pricing page").
- Returns a monitor id. Optionally posts to a webhook when the monitor fires.

**Guidelines:**
- Always cite URLs returned by these tools with \`[1](url)\` footnotes — never fabricate citations.
- Prefer \`parallel_search\` for single-turn factual questions; escalate to \`parallel_deep_research\` only when the question genuinely needs it (latency + cost are higher).
- For \`parallel_extract\`, keep to URLs returned by \`parallel_search\` or explicitly given by the user.
`;

export const CSV_OPS_SKILL = `---
id: platos.csv_ops
name: CSV / Spreadsheet Operations
description: List sheets, read rows, read a single line, and write back to spreadsheets. Supports .csv / .tsv / xlsx / Google Sheets. Canonical partner for \`agent_batch\` when iterating row-by-row.
version: 0.1.0
author: Platos
origin: official
spec_version: 1
tags:
  - csv
  - spreadsheet
  - data
  - official
required_env:
  - GOOGLE_SHEETS_CREDENTIALS
provides_tools:
  - name: csv_list_sheets
    description: List sheet/tab names + row counts for a spreadsheet source. For plain CSV/TSV returns a single synthetic "Sheet1" entry. Supports http(s) CSV/TSV/XLSX URLs and Google Sheets (\`gsheet://<id>\` or \`https://docs.google.com/spreadsheets/d/<id>/...\`).
    inputSchema: {"type":"object","properties":{"source":{"type":"string","description":"Spreadsheet source. http(s) URL to .csv/.tsv/.xlsx, \`gsheet://<sheetId>\`, or full Google Sheets URL."}},"required":["source"]}
    handler: skill:platos.csv_ops:csv_list_sheets
  - name: csv_read_sheet
    description: Read rows from a spreadsheet as an array of objects keyed by header. Supports optional \`sheet\` (name) and \`range\` (A1 notation, e.g. "A2:D50"). Default maxRows=5000, hard cap 100000. Returns \`{headers, rows, totalRows, truncated}\`.
    inputSchema: {"type":"object","properties":{"source":{"type":"string"},"sheet":{"type":"string","description":"Sheet/tab name. Ignored for CSV/TSV."},"range":{"type":"string","description":"Optional A1 range like \\"A2:D50\\"."},"maxRows":{"type":"integer","minimum":1,"maximum":100000,"default":5000}},"required":["source"]}
    handler: skill:platos.csv_ops:csv_read_sheet
  - name: csv_read_line
    description: Fetch a single row by 1-indexed line number (1 = first data row after headers). Cheap, ideal for resumable per-row batches paired with \`agent_batch\`.
    inputSchema: {"type":"object","properties":{"source":{"type":"string"},"lineNumber":{"type":"integer","minimum":1,"description":"1-indexed data row (excludes header)."},"sheet":{"type":"string"}},"required":["source","lineNumber"]}
    handler: skill:platos.csv_ops:csv_read_line
  - name: csv_write_cell
    description: Write a single cell back to a Google Sheet. Requires \`GOOGLE_SHEETS_CREDENTIALS\` and a gsheet URL/gsheet:// source. Plain CSV/TSV are read-only and will return a clear error.
    inputSchema: {"type":"object","properties":{"source":{"type":"string","description":"Google Sheets URL or \`gsheet://<id>\`."},"sheet":{"type":"string","description":"Tab name."},"cell":{"type":"string","description":"A1 cell reference, e.g. \\"B3\\"."},"value":{"type":"string"}},"required":["source","sheet","cell","value"]}
    handler: skill:platos.csv_ops:csv_write_cell
---

You have access to a spreadsheet toolkit for reading and (optionally) writing CSV / TSV / XLSX / Google Sheets. The canonical pairing is **one call to \`csv_list_sheets\` + \`csv_read_sheet\` to plan, then \`agent_batch\` over \`csv_read_line\` for per-row work.**

**\`csv_list_sheets\`** — start here when you don't yet know the structure.
- Returns sheet/tab names with row counts.
- For CSV/TSV the result is a single synthetic \`Sheet1\` entry.

**\`csv_read_sheet\`** — bulk read as structured rows.
- Returns \`{ headers, rows, totalRows, truncated }\`.
- \`maxRows\` caps the payload (default 5000, hard limit 100k). \`truncated: true\` means the sheet has more rows than returned.
- Use \`range\` (A1 notation like \`A2:D50\`) for surgical subsets.

**\`csv_read_line\`** — single-row fetch.
- 1-indexed data row (line 1 = first row after the header).
- Prefer this inside an \`agent_batch\` body so each sub-agent processes exactly one row.

**\`csv_write_cell\`** — write back to Google Sheets.
- Works only when the source is a Google Sheets URL or \`gsheet://\` scheme AND \`GOOGLE_SHEETS_CREDENTIALS\` is linked.
- Plain CSV/TSV sources are read-only — the tool returns a clear error.

**Supported sources:**
- \`https://example.com/foo.csv\` / \`.tsv\` — public GET, no auth.
- \`https://example.com/foo.xlsx\` — XLSX read support is deferred in this release; list/read will return a clear "not yet supported" error (TODO W.2.1).
- \`gsheet://<sheetId>\` or \`https://docs.google.com/spreadsheets/d/<sheetId>/edit...\` — reads use the public CSV export; writes require \`GOOGLE_SHEETS_CREDENTIALS\` (TODO W.2.2 for live write path).
- \`s3://...\` — not supported yet. Will return an explicit error.

**Guidelines:**
- For spreadsheets larger than a few thousand rows, prefer \`agent_batch\` + \`csv_read_line\` over a single \`csv_read_sheet\` — memory and context win.
- Never invent column names; always read them via \`csv_list_sheets\` or the \`headers\` field on a read.
- Cite the \`source\` URL in your response when summarising spreadsheet data.
`;

export const PLATOS_RAG_SKILL = `---
id: platos.platos_rag
name: Platos RAG
description: Ingest documents into the agent's long-term memory, then retrieve chunks semantically at turn-time. Five tools — ingest, retrieve, list, reindex, delete. Chunks are stored on the user's \`PlatosMemory\` rows with \`kind="rag"\` in metadata, so scope + user isolation comes for free.
version: 0.1.0
author: Platos
origin: official
spec_version: 1
tags:
  - rag
  - retrieval
  - memory
  - official
required_env: []
optional_env:
  - PARALLEL_API_KEY
provides_tools:
  - name: rag_ingest_document
    description: Chunk + embed + store one or more sources (URLs or \`attachmentId:<id>\` refs) into long-term memory. Small batches (≤5) run inline; larger batches fan out via \`agent_batch\` and return a batchRunId.
    inputSchema: {"type":"object","properties":{"source":{"oneOf":[{"type":"string"},{"type":"array","items":{"type":"string"}}],"description":"One URL, one \`attachmentId:<id>\` ref, or an array of either."},"tags":{"type":"array","items":{"type":"string"},"description":"Optional tags stored on every chunk — used by rag_retrieve.filterTags."},"chunkSize":{"type":"integer","minimum":200,"maximum":4000,"default":1000},"overlap":{"type":"integer","minimum":0,"maximum":1000,"default":200}},"required":["source"]}
    handler: skill:platos.platos_rag:rag_ingest_document
  - name: rag_retrieve
    description: Semantic search over previously ingested chunks. Returns topK chunks with content + sourceUrl + chunkIndex + score.
    inputSchema: {"type":"object","properties":{"query":{"type":"string"},"topK":{"type":"integer","minimum":1,"maximum":50,"default":8},"filterTags":{"type":"array","items":{"type":"string"}},"rerank":{"type":"boolean","default":false,"description":"If true, returns a warning — reranker is a TODO."}},"required":["query"]}
    handler: skill:platos.platos_rag:rag_retrieve
  - name: rag_delete_source
    description: Delete every chunk ingested from a specific sourceUrl.
    inputSchema: {"type":"object","properties":{"sourceUrl":{"type":"string"}},"required":["sourceUrl"]}
    handler: skill:platos.platos_rag:rag_delete_source
  - name: rag_list_sources
    description: Enumerate ingested sources (grouped by sourceUrl) with chunk counts + tags.
    inputSchema: {"type":"object","properties":{}}
    handler: skill:platos.platos_rag:rag_list_sources
  - name: rag_reindex
    description: Re-run ingest for a previously ingested sourceUrl. Deletes existing chunks first, preserves tags.
    inputSchema: {"type":"object","properties":{"sourceUrl":{"type":"string"}},"required":["sourceUrl"]}
    handler: skill:platos.platos_rag:rag_reindex
---

You have a retrieval-augmented-generation (RAG) toolbelt backed by Platos long-term memory. Every chunk is scoped to \`(org, project, env, user)\` — other users and other scopes never see it.

**\`rag_ingest_document\`** — bring content into memory.
- \`source\` accepts a single URL, a single \`attachmentId:<id>\` ref, or an array.
- URLs are fetched via the built-in \`fetch_url\` path (or \`parallel_extract\` when \`PARALLEL_API_KEY\` is set).
- \`attachmentId:*\` pulls the bytes from the agent's MinIO workspace.
- Content is split sentence-aware into \`chunkSize\` blocks with \`overlap\` carried forward.
- If more than 5 sources are passed, the call is queued via \`agent_batch\` and returns \`{ batchRunId }\` immediately — check the batch progress stream for completion.

**\`rag_retrieve\`** — fetch the top matching chunks for a query.
- Returns \`{ chunks: [{ content, sourceUrl, chunkIndex, score }], totalChunks, reranked }\`.
- \`filterTags\` narrows to chunks that were ingested with at least one of the supplied tags.
- \`rerank: true\` is a no-op today (returns a warning) — the simple cosine search still runs.

**\`rag_delete_source\`** / **\`rag_list_sources\`** / **\`rag_reindex\`** — housekeeping.

**When to use:**
- The user asks a question that depends on specific documents ("given the handbook above…").
- You want to ground your answer in user-supplied material rather than the model's training data.

**Guidelines:**
- Cite every chunk you rely on with \`[1](sourceUrl)\` footnotes.
- Prefer \`topK=8\` for exploratory queries, drop to 3–5 for tight factual lookups.
- Use \`filterTags\` when the user has multiple document sets — keeps retrieval relevant.
`;

export const EMAIL_SEND_SKILL = `---
id: platos.email_send
name: Email Send
description: Send transactional emails through Resend. Supports HTML / plain-text bodies, reply-to, cc, bcc, and tags.
version: 0.1.0
author: Platos
origin: official
spec_version: 1
tags:
  - email
  - resend
  - transactional
  - official
required_env:
  - RESEND_API_KEY
optional_env:
  - RESEND_FROM_EMAIL
provides_tools:
  - name: send_email
    description: Send a transactional email via Resend. Provide either \`html\` or \`text\` (or both). The \`from\` address must be on a domain verified in Resend; defaults to RESEND_FROM_EMAIL when set.
    inputSchema: {"type":"object","properties":{"to":{"description":"Recipient email address(es). Single string or array of strings.","oneOf":[{"type":"string","format":"email"},{"type":"array","items":{"type":"string","format":"email"},"minItems":1,"maxItems":50}]},"subject":{"type":"string","minLength":1,"maxLength":200,"description":"Subject line."},"html":{"type":"string","description":"HTML body. At least one of html / text is required."},"text":{"type":"string","description":"Plain-text body. At least one of html / text is required."},"from":{"type":"string","format":"email","description":"Sender. Must be on a Resend-verified domain. Falls back to RESEND_FROM_EMAIL when omitted."},"replyTo":{"description":"Reply-to address(es).","oneOf":[{"type":"string","format":"email"},{"type":"array","items":{"type":"string","format":"email"}}]},"cc":{"type":"array","items":{"type":"string","format":"email"},"maxItems":50},"bcc":{"type":"array","items":{"type":"string","format":"email"},"maxItems":50},"tags":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},"value":{"type":"string"}},"required":["name","value"]},"description":"Resend tags for analytics / dashboard filtering."}},"required":["to","subject"]}
    handler: skill:platos.email_send:send_email
---

You can send transactional emails through Resend.

**When to use \`send_email\`:**
- The user explicitly asks you to send an email (confirmation, notification, follow-up).
- An operator-configured workflow requires email delivery (alerts, digests, escalations).

**Required arguments:**
- \`to\` — recipient email address (single string or array up to 50).
- \`subject\` — non-empty subject line.
- \`html\` and/or \`text\` — at least one body format. Prefer \`html\` for rich formatting; include \`text\` as a fallback when both audience reach and accessibility matter.

**Optional arguments:**
- \`from\` — sender address. Must be on a domain you've verified in [resend.com/domains](https://resend.com/domains). When omitted, falls back to \`RESEND_FROM_EMAIL\`. **The skill fails if neither is set** — Resend rejects unverified senders.
- \`replyTo\` — where replies go (defaults to \`from\`).
- \`cc\` / \`bcc\` — additional recipients.
- \`tags\` — \`[{name, value}]\` pairs for Resend's dashboard analytics (e.g. \`{name: "category", value: "billing"}\`).

**Guidelines:**
- Always confirm the recipient and subject with the user before sending unless an upstream workflow has authorised it.
- Prefer concise, well-formatted HTML (inline styles work; external CSS does not).
- Don't include the user's auth tokens, API keys, or other secrets in email bodies.
- For bulk sends to >5 recipients, prefer creating a Resend audience + broadcast in the dashboard rather than long \`to\` arrays — this skill is for transactional, not marketing, traffic.

**On error:**
The tool returns \`{ ok: false, error: "<reason>" }\` when Resend rejects the request. Common reasons: unverified \`from\` domain, malformed recipient, body missing, payload too large. Surface the reason to the user so they can correct it.
`;

export const OFFICIAL_SKILL_SOURCES: Array<{ id: string; source: string }> = [
  { id: "platos.web_search", source: WEB_SEARCH_SKILL },
  { id: "platos.code_execution", source: CODE_EXECUTION_SKILL },
  { id: "platos.file_operations", source: FILE_OPERATIONS_SKILL },
  { id: "platos.image_generation", source: IMAGE_GENERATION_SKILL },
  { id: "platos.parallel_web", source: PARALLEL_WEB_SKILL },
  { id: "platos.csv_ops", source: CSV_OPS_SKILL },
  { id: "platos.platos_rag", source: PLATOS_RAG_SKILL },
  { id: "platos.email_send", source: EMAIL_SEND_SKILL },
];
