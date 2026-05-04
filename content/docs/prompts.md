---
slug: prompts
title: Prompts
description: How Platos assembles a prompt, when it caches, and how prompt blocks compose.
category: platform
order: 130
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How does Platos assemble a prompt for a turn?"
  - "What are prompt blocks and how do I add one?"
  - "When is a prompt cached and what is the hit rate?"
  - "How do I write a prompt that caches well across turns?"
  - "How do I inspect the exact prompt that hit the model?"
  - "How does the retrieval block fit into the prompt?"
related:
  - agents
  - models
  - context
  - traces
source_files_referenced:
  - apps/agent/src/agent-runtime/prompt-builder.service.ts
  - apps/agent/src/agent-runtime/prompt-cache.service.ts
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.prompts._index/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.prompts.$promptSlug/route.tsx
---

# Prompts

A Platos prompt is composed of ordered blocks. Each block has a type, a name, and content; the runtime serialises them into a single system prompt at turn time, runs the result through two cache layers, and ships the cached prefix to the model. This is how a 200-tool agent stays cheap at scale.

## What it is

`PromptBlock`: `{ id, type, name, content, enabled, editable, order }`. Common block types:

- `role`: who the agent is.
- `format`: how the agent should reply.
- `tools`: the tools matrix description (auto-rendered from `toolsBlockConfig`).
- `context`: dynamic context inserted from the resolver.
- `retrieval`: the [platos-rag](/docs/official-skills) retrieval block, when the skill is enabled.
- `memory`: profile and knowledge blurbs the recall path produced.
- `custom`: free-form content you author.

`PromptBuilderService` orders the blocks (by `order`), serialises them into a system prompt, and emits a hash for the cache layer.

`PromptCacheService` runs two layers:

- **Layer 1 (process-local)**: keyed on `(agentVersionId, blocks-hash)`. Hot path; <1ms hit. Invalidated when an agent saves a new version.
- **Layer 2 (Redis)**: keyed on `(agentVersionId, blocks-hash, resolved-context-hash)`. Survives process restarts and shares across replicas. ~5-10ms hit.

For a stable agent, hot turns hit Layer 1. Cross-replica hits land Layer 2. Cold turns rebuild from blocks plus context.

## Why it matters

Long system prompts are the dominant per-turn cost on most agents. A 4k-token prompt at $0.003/1k cached vs $0.015/1k uncached is a 5x cost gap. Caching well-structured prompts means a fast feedback loop without paying full prompt cost on every turn.

The two-layer split is also what makes per-user personalisation cheap. The agent prefix (role, format, tools) is identical across users; the suffix (memory, retrieval, session context) varies. Layer 2 keys include the context hash, so user A and user B share zero cache, but turn-to-turn within user A's session reuses everything.

## How to use it

### Edit prompt blocks

In the agent detail view, the Prompt tab lists each block with an inline editor. Drag to reorder, toggle to disable, or click "Add block" to insert. Saving writes a new agent version and invalidates Layer 1.

### Use the prompt library

`/orgs/{org}/projects/{project}/env/{env}/prompts` lists named prompts that you can attach to multiple agents. A prompt in the library is `{ slug, name, blocks[] }`. Reference one from an agent with a "library" block; the runtime expands it at render time.

### Inspect the assembled prompt

Postman mode in the chat panel shows the assembled system prompt with per-block highlighting. Each block badge shows whether it was Layer-1, Layer-2, or rebuilt for this turn. Filter by status to find blocks that always rebuild (usually a sign that they reference a high-cardinality context value).

### Write cache-friendly prompts

- Keep the cacheable prefix (role, format, tools) at the top.
- Push high-variance blocks (retrieval results, memory) to the bottom.
- Avoid putting timestamps or random ids in cacheable blocks; they nuke Layer 1.
- Use `${user_id}` placeholders rather than inlining user content into prefix blocks.

## Common pitfalls

- Layer 2 keys on the resolved context hash, not the template. A user with a different `entity_ids` array gets a different cache slot. Audit `entity_ids` cardinality if you see Layer 2 hit rate sinking.
- Block reordering counts as a behaviour change; the agent version bumps on save. Reorder once, settle, and you'll see Layer 1 hit rate climb.
- A Layer-2 hit shaves ~50ms off a turn but adds Redis network cost. On hot agents, ensure Redis is co-located with the agent service or the gain is wasted.
- The cache hit rate is visible on the [Costs](/docs/costs) view (per-agent cache hit chart). A drop usually means a recent prompt edit or a context-mapping change.

## Related

- [Agents](/docs/agents): the agent record carries `promptBlocks`.
- [Models](/docs/models): each provider has its own cache pricing; the cost model in [Costs](/docs/costs) accounts for both.
- [Context](/docs/context): context resolution is the input to Layer 2's cache key.
- [Traces](/docs/traces): per-turn span timeline shows prompt-build vs cache-hit timing.
