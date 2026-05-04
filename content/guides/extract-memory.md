---
slug: extract-memory
title: Extract long-term memory from a conversation
description: Configure the memory extractor to pull profile facts, preferences, and entities from a chat.
category: recipes
order: 30
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How do I enable memory extraction on an agent?"
  - "Which extractor model is used and how much does it cost?"
  - "How do I pin a specific fact?"
  - "How do I rate a memory good or bad?"
  - "How is the extractor scheduled?"
related:
  - create-first-agent
source_files_referenced:
  - apps/agent/src/memory/memory-extraction.service.ts
  - apps/agent/src/memory/memory-feedback.service.ts
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.memories._index/route.tsx
---

# Extract long-term memory from a conversation

Configure the extractor to pull profile facts, preferences, and entities from a chat into queryable memory.

## The goal

An agent that remembers user-shared facts (name, preferences, recurring requests) across sessions and uses them in retrieval next time.

## Steps

1. **Enable extraction.**

   On the agent, Memory tab -> Extraction policy:

   ```json
   {
     "mode": "post-turn",
     "minTurns": 1,
     "maxTokensPerExtraction": 2000
   }
   ```

   Save. Extraction runs after every turn ends.

2. **Pick the extraction model.**

   Memory tab -> Extraction model. Pick a small/cheap model (e.g. Claude Haiku, GPT-4o-mini). Extraction is a frequent operation; the cost matters.

3. **Chat with the agent.**

   Have a few turns where the user shares preferences. After each turn, the extractor runs in the background.

4. **Inspect the memories.**

   `/memories` -> filter by user. Each row is a fact with `kind`, `content`, `embedding`, `rating`, `createdAt`. Inline-edit, rate up/down, or delete.

5. **Confirm recall.**

   Open a fresh chat with the same user. The first turn's prompt should include relevant memories in the recall block (visible in Postman mode).

## Verify

- Memory rows appear in `/memories` after a chat ends.
- The next chat with the same user shows recalled memories in the assembled prompt.
- The extraction lane cost shows up on the [Costs](/docs/costs) page.

## Pin a fact manually

`/memories` -> "Add". Type the fact, set `kind: "profile"`, save. Manual writes never get extracted-out; the extractor only writes; rating-down is the way to remove.

## Rate a memory

Each memory row has thumbs. Up boosts retrieval ranking; down docks. Bad memories starve themselves out without manual cleanup.

## Next steps

- [Build an agent cluster](/guides/build-agent-cluster) so multiple agents share the same memory pool.
- [Filter PII](/guides/filter-pii) to redact sensitive bits before they land in memory.
