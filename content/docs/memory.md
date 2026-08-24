---
slug: memory
title: Memory
description: Long-term, scoped, ratable memory that powers personalization without leaking across tenants.
category: platform
order: 80
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
---

# Memory

Memory in Platos is scoped, ratable, and tiered. Every retained fact is stored as a `Memory` record keyed by end user and Agent or AgentCluster, embedded for vector recall, surfaced through runtime tools such as `recall`, and updated through a feedback loop. Cross-tenant access is rejected before recall.

## What it is

Four classes of memory, all in one table:

- **Working memory**: short-lived state for the current Turn. Owned by `WorkingMemoryService`. Lives in Redis with a TTL.
- **Conversation memory**: messages and summaries on the active thread. Backed by `ConversationService` and (optionally) compaction — see [Compaction](#compaction) below.
- **Profile memory**: long-term facts about the user, stored as typed `Memory` records with profile keys.
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

Use the hard-erasure API for a subject-wide cascade across working memory, profile, knowledge, embeddings, and every other configured store. Delete one Memory with the generated `/api/v1/memory/{id}` contract.

## Compaction

Long threads eventually exceed what you want to send every turn. Compaction replaces the older stretch of a conversation with a model-written summary and keeps the recent messages verbatim.

Two properties make it safe to leave on:

**It is cursor-anchored, not a sliding window.** The thread stores a `compactedUpToMessageId`; history is assembled as *summary + everything after the cursor*. A sliding window would shift by one message every turn, changing the leading bytes of the prompt and missing the provider's prefix cache on every single turn — the compaction meant to save money would quietly multiply it. Because the cursor only moves when a compaction actually lands, the prefix stays byte-identical between compactions and keeps hitting cache.

**It happens off the turn.** Compaction runs as a background job. The turn that trips the threshold is served from existing history; the new summary is swapped in only once it is complete and written. Summary and cursor move together in one transaction, so a failed compaction leaves the thread exactly as it was rather than truncated against a summary that was never produced.

### Choosing a compaction model

Compaction is summarisation, not reasoning, and it runs on your longest contexts — the one place where paying frontier rates buys the least. Set a `compaction` route in the agent's model routes to point it at a cheaper model, with its own provider key if you want the traffic isolated. Unset, compaction uses the agent's main model.

## Common pitfalls

- Recall first overfetches candidates through the pgvector HNSW cosine index, then ranks them by `0.8 × cosine + 0.2 × confidence` (null confidence is neutral at `0.5`), with memory ID as the stable tie-break. Search hits keep `score` as cosine similarity (and `minScore` filters that cosine value) for backwards compatibility; `rankingScore` exposes the blended value used for ordering. Current source-turn ratings are aggregated deterministically: any negative quarantines the memory, while confidence is its pre-feedback baseline plus `0.1 × (ups - downs)`, clamped to `0..1`.
- Historical feedback quarantine is an operator migration concern, not a public Memory API. Recall remains fail-closed for undecryptable or quarantined records.
- The initial migration performs a content-free legacy rating preflight before its memory-feedback DDL. Platos product history defines only `1` (thumbs-up), `-1` (thumbs-down), and deletion (no feedback); it does not authorize a star-scale meaning for accidentally admitted values `2..5`. If preflight reports counts for unsupported source values, audit and deliberately correct or delete those rows, then recreate the disposable target database from the initial migration. The DDL never silently guesses their meaning.
- The scheduler runs in the same internal scheduler as extraction. A flood of post-turn extractions can backlog the scheduler. Consider `batched` mode for high-volume agents.
- Cluster scope is opt-in. Two agents created independently and later linked into a cluster do not retroactively share their existing memories. New writes flow to the cluster scope; old writes stay agent-scoped.
- `embedding.service.ts` calls the configured embedding model. If the provider key for that model is unlinked, extraction silently no-ops (logged at warn level). Watch the [Monitoring](/docs/monitoring) memory-extraction-health card.

## Related

- [Memory graph](/docs/memory-graph): the entity-and-relations view over knowledge memory.
- [Conversations and threads](/docs/conversations-and-threads): where extraction reads from.
- [Agent clusters](/docs/agent-clusters): cluster-scoped memory pools.
- [Safety and PII](/docs/safety-and-pii): PII filtering before a memory is written.
