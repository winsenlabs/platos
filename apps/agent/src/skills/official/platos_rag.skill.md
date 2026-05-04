---
id: platos.platos_rag
name: Platos RAG
description: Ingest documents into the agent's long-term memory, then retrieve chunks semantically at turn-time. Five tools — ingest, retrieve, list, reindex, delete. Chunks are stored on the user's `PlatosMemory` rows with `kind="rag"` in metadata, so scope + user isolation comes for free.
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
    description: Chunk + embed + store one or more sources (URLs or `attachmentId:<id>` refs) into long-term memory. Small batches (≤5) run inline; larger batches fan out via `agent_batch` and return a batchRunId.
    inputSchema: {"type":"object","properties":{"source":{"oneOf":[{"type":"string"},{"type":"array","items":{"type":"string"}}],"description":"One URL, one `attachmentId:<id>` ref, or an array of either."},"tags":{"type":"array","items":{"type":"string"},"description":"Optional tags stored on every chunk — used by rag_retrieve.filterTags."},"chunkSize":{"type":"integer","minimum":200,"maximum":4000,"default":1000},"overlap":{"type":"integer","minimum":0,"maximum":1000,"default":200}},"required":["source"]}
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

You have a retrieval-augmented-generation (RAG) toolbelt backed by Platos long-term memory. Every chunk is scoped to `(org, project, env, user)` — other users and other scopes never see it.

**`rag_ingest_document`** — bring content into memory.
- `source` accepts a single URL, a single `attachmentId:<id>` ref, or an array.
- URLs are fetched via the built-in `fetch_url` path (or `parallel_extract` when `PARALLEL_API_KEY` is set).
- `attachmentId:*` pulls the bytes from the agent's MinIO workspace.
- Content is split sentence-aware into `chunkSize` blocks with `overlap` carried forward.
- If more than 5 sources are passed, the call is queued via `agent_batch` and returns `{ batchRunId }` immediately — check the batch progress stream for completion.

**`rag_retrieve`** — fetch the top matching chunks for a query.
- Returns `{ chunks: [{ content, sourceUrl, chunkIndex, score }], totalChunks, reranked }`.
- `filterTags` narrows to chunks that were ingested with at least one of the supplied tags.
- `rerank: true` is a no-op today (returns a warning) — the simple cosine search still runs.

**`rag_delete_source`** / **`rag_list_sources`** / **`rag_reindex`** — housekeeping.

**When to use:**
- The user asks a question that depends on specific documents ("given the handbook above…").
- You want to ground your answer in user-supplied material rather than the model's training data.

**Guidelines:**
- Cite every chunk you rely on with `[1](sourceUrl)` footnotes.
- Prefer `topK=8` for exploratory queries, drop to 3–5 for tight factual lookups.
- Use `filterTags` when the user has multiple document sets — keeps retrieval relevant.
