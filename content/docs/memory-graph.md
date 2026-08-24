---
slug: memory-graph
title: Memory graph
description: Knowledge-graph view over memory, with entity nodes and relations extracted from conversations.
category: platform
order: 90
questions:
  - "What is the memory graph?"
  - "How are nodes and edges extracted?"
  - "How do I traverse the graph from an agent's prompt?"
  - "How is the graph different from vector memory?"
  - "Can I edit a node manually?"
  - "How do I see which memories link to a node?"
related:
  - memory
  - conversations-and-threads
---

# Memory graph

The Memory graph is an entities-and-relations view layered over knowledge Memory. Where vector recall answers "what facts look like this?", the graph answers "what is connected to what?". Both views read canonical `Memory` records; the graph adds typed nodes and labelled edges through the `KnowledgeGraphService`.

## What it is

Two derived structures:

- **Nodes**: entities the agent has talked about. People, projects, concepts. Each node is keyed by a stable id and a display label, with optional metadata.
- **Edges**: typed relations between nodes. `works_at`, `owns`, `mentioned_in`, `prefers`. Each edge carries a label, a confidence score, and the memory id that produced it.

Extraction runs alongside the standard memory pipeline. When a turn produces a new memory, the extraction prompt also asks the model to identify entities and relations, and the graph service upserts nodes and edges in the same transaction.

The dashboard renders this at `/orgs/{org}/projects/{project}/env/{env}/memories/graph`. Click a node to see its memories; click an edge to see the source turn.

## Why it matters

Vector recall returns "things that sound like the query". Graph traversal returns "things connected to a known entity". They answer different questions:

- "What did the user say about pricing?" -> vector recall.
- "What companies has the user mentioned, and which ones do they work at?" -> graph traversal from the user node.

Combining the two in retrieval (graph-first to find the entity, vector-second to expand its surrounding facts) is markedly better than either alone for personalisation use cases.

## How to use it

### Traverse from a prompt block

Add a graph block to the agent's prompt config:

```json
{ "type": "graph", "name": "User context", "content": "graph:user:${userId}" }
```

At turn time, the resolver walks two hops from the `user:${userId}` node and inlines the connected nodes into the prompt. Cache-friendly: the resolver hashes the subgraph and Layer-2 caches it.

### Manual edits

The dashboard graph view lets you click a node and edit its label, merge two nodes, or delete an edge. Manual edits are first-class; extraction will not auto-recreate a deleted edge unless the source memory is rewritten.

### Inspect the source

Every edge carries the `memoryId` that produced it. Click through to the memory row to see the original conversation turn. Useful for debugging "why does the agent think this person works at Acme?" questions.

## Common pitfalls

- Node ids are stable per scope. Two users named "Alice" in the same project produce two `user:alice-1` and `user:alice-2` nodes, not one merged node, unless you manually merge them.
- Edge confidence is set by the extraction model. Low-confidence edges are still stored; the dashboard renders them dimmed. Filter on confidence in retrieval if noise is a problem.
- The graph is project-scoped, not user-scoped. A user reading the graph view sees every node and edge in the project. Hide the page from non-admin members if needed.
- Extracted nodes do not auto-prune. A node referenced by zero memories sticks around. Use the cleanup script in the admin tools to garbage-collect orphaned nodes.

## Related

- [Memory](/docs/memory): the underlying memory table the graph reads from.
- [Conversations and threads](/docs/conversations-and-threads): the source of extraction inputs.
