---
slug: memory
title: Memory
description: Long-term, scoped, ratable memory that powers personalization without leaking across tenants.
category: platform
order: 80
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "What kinds of memory does Platos have (working, conversation, profile, knowledge)?"
  - "How is memory extracted from a conversation?"
  - "How do I rate or correct a memory?"
  - "How is memory scoped per user and per agent?"
  - "Can two agents share memory? When?"
  - "How do I delete memory for a specific user (GDPR)?"
  - "How does the memory scheduler decide when to extract?"
related:
  - memory-graph
  - conversations-and-threads
  - agent-clusters
  - safety-and-pii
source_files_referenced:
  - apps/agent/src/memory/memory.service.ts
  - apps/agent/src/memory/memory.controller.ts
  - apps/agent/src/memory/memory-extraction.service.ts
  - apps/agent/src/memory/memory-feedback.service.ts
  - apps/agent/src/memory/memory-scheduler.service.ts
  - apps/agent/src/memory/working-memory.service.ts
  - apps/agent/src/memory/profile-cache.service.ts
  - apps/agent/src/memory/embedding.service.ts
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.memories._index/route.tsx
  - docs/themes/THEME_L.md
  - docs/themes/THEME_O.md
---

# Memory

Memory in Platos is scoped, ratable, and tiered. Every fact the agent learns is stored as a `PlatosMemory` row keyed by user and agent (or cluster), embedded for vector recall, surfaced through `recall` and `list_memories` meta-tools, and updated through a feedback loop. Cross-tenant access is rejected at the auth layer; you cannot recall a memory you did not write.

## What it is

Four classes of memory, all in one table:

- **Working memory**: short-lived state for the current turn or run. Owned by `WorkingMemoryService`. Lives in Redis with a TTL.
- **Conversation memory**: messages and summaries on the active thread. Backed by `ConversationService` and (optionally) compaction.
- **Profile memory**: long-term facts about the user (preferences, identifiers, prior context). Owned by `ProfileCacheService` over a `PlatosMemory` row tagged `kind: "profile"`.
- **Knowledge memory**: agent-scoped facts and references. Same table, tagged `kind: "knowledge"`. The [Memory graph](/docs/memory-graph) layers entity nodes and edges over this set.

Each row carries `(scope, userId, agentId | clusterId, kind, content, embedding, rating, createdAt, updatedAt)`. The embedding column is pgvector; recall is HNSW cosine. Ratings flow through `MemoryFeedbackService` and reweight retrieval ranking.

Extraction runs after a turn ends, scheduled by `MemoryExtractionService` plus `MemoryScheduler`. The agent's `extractionPolicy` decides when to run (every turn, batched per N turns, or only on user feedback) and what shape the extraction prompt takes.

## Why it matters

A chat agent without long-term memory feels stateless: the user reintroduces themselves on every visit, repeats their preferences, and forgets the agent will forget. A naive solution (dump every message into a vector store) leaks private facts across tenants and explodes cost. Platos splits the problem into typed tiers, scopes each tier per `(scope, user, agent | cluster)`, and runs extraction asynchronously so chat latency never pays for memory writes.

The ratings loop is the differentiator. When a user thumbs-down a reply that hallucinated, the message rating cascades back into the memory rows the recall pulled from, downweighting them on the next query. Bad memories starve themselves out without manual cleanup.

## Setup — embedding provider is mandatory

Memory writes (manual `remember` calls, `update_user_profile`, AND the hourly extraction sweep) compute a 1536-dim embedding before insert. Without an embedding provider configured, the embed call throws and the memory never lands. **Symptom: agent feels stateless across sessions, the dashboard memory tab is empty even after multi-turn conversations, and the agent log shows `VOYAGE_API_KEY not configured` (or the OpenAI equivalent) on every failed extraction.**

Pick one provider on the agent container env:

```bash
# Recommended — Anthropic-recommended embedding provider
PLATOS_EMBEDDING_PROVIDER=voyage
VOYAGE_API_KEY=pa-...                  # https://www.voyageai.com or via the Anthropic console

# OR — reuse your OpenAI key (already needed if you use the OpenAI LLM)
PLATOS_EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

Default model on each provider is 1536-dim native (voyage-large-2 / text-embedding-3-small) so it slots straight into the existing pgvector column without a schema migration. If you set `PLATOS_EMBEDDING_MODEL` to a non-1536-dim model you'll need to widen the column first; see [Self-hosting § Required env vars](/docs/self-hosting#required-env-vars).

These can also be linked per-scope via the dashboard Providers UI, encrypted in Postgres — `EmbeddingService.resolveApiKey` checks the scope-bound store first and falls back to the container env. Profile-kind memory rows (`update_user_profile`) skip the embed step (key-value lookup) and don't require this; everything else does.

## How to use it

### From the agent's perspective

Three meta-tools cover the bulk of usage:

- `remember({ content, kind?: "profile" | "knowledge" })`: write a fact.
- `recall({ query, limit?: 5 })`: vector search over the agent's accessible memory.
- `forget({ memoryId })`: delete a specific memory.

Plus `list_memories({ kind?, query? })` for paged inspection and `relate({ from, to, label })` for the graph layer.

### Manual writes from the dashboard

`/orgs/{org}/projects/{project}/env/{env}/memories` lists every memory in scope, filterable by user, agent, kind, and rating. Inline edit, rate, or delete. Useful for forensic cleanup after a known bad turn.

### Extraction policy

Set per agent:

```json
{
  "mode": "post-turn",
  "minTurns": 3,
  "maxTokensPerExtraction": 2000,
  "extractionPrompt": null
}
```

`post-turn` extracts after each turn ends. `batched` extracts after `minTurns` turns or when the user rates a message. Custom prompts override the default extraction template.

### Scoping rules

- Default: `(userId, agentId)`. The agent only sees memory it wrote for that user.
- Cluster: `(userId, clusterId)`. All cluster members share the same memory pool.
- Project-shared: explicit `kind: "shared"` rows visible to every agent in the project. Use sparingly; this is the only place where one agent's writes leak to another.

### GDPR delete

`DELETE /agent/v1/memory?userId=...` runs the cascade: working memory, profile, knowledge, and any embedded copies. Returns the count of rows deleted. Per-user delete is also exposed through `messages.rate` with a delete intent and via the dashboard's user detail page.

## Common pitfalls

- Recall ranking blends cosine similarity with rating. A high-cosine row with `rating: -1` ranks lower than a moderate-cosine row with `rating: +1`. If you import memories without ratings, expect the first turn after import to feel more aggressive than steady-state.
- The scheduler runs in the same trigger.dev queue as extraction. A flood of post-turn extractions can backlog the queue. Consider `batched` mode for high-volume agents.
- Cluster scope is opt-in. Two agents created independently and later linked into a cluster do not retroactively share their existing memories. New writes flow to the cluster scope; old writes stay agent-scoped.
- `embedding.service.ts` calls the configured embedding model. If the provider key for that model is unlinked, extraction silently no-ops (logged at warn level). Watch the [Monitoring](/docs/monitoring) memory-extraction-health card.

## Related

- [Memory graph](/docs/memory-graph): the entity-and-relations view over knowledge memory.
- [Conversations and threads](/docs/conversations-and-threads): where extraction reads from.
- [Agent clusters](/docs/agent-clusters): cluster-scoped memory pools.
- [Safety and PII](/docs/safety-and-pii): PII filtering before a memory is written.
