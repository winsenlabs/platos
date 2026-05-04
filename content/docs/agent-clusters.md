---
slug: agent-clusters
title: Agent clusters
description: Group agents that share memory, threads, and user identity so a chat agent and a background agent feel like one.
category: platform
order: 30
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "What is an agent cluster?"
  - "When should two agents share a cluster vs stay separate?"
  - "How is memory shared across agents in a cluster?"
  - "Can a BGO agent post into a chat agent's thread?"
  - "How is cross-cluster access prevented?"
  - "How do I see which cluster an agent belongs to from the agent detail page?"
related:
  - agents
  - memory
  - conversations-and-threads
  - platos-tasks
source_files_referenced:
  - apps/agent/src/agent-runtime/agent-cluster.service.ts
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-clusters._index/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-clusters.$clusterId/route.tsx
  - docs/pra/PRA_SPEC_AGENT_CLUSTER.md
---

# Agent clusters

An agent cluster groups two or more agents that share user identity, memory, and threads. The classic case is "Wally Chat" plus "Wally BGO": one runs the conversation, the other runs background work, and from the user's perspective they are one agent that picks up where the other left off.

## What it is

A `PlatosAgentCluster` row with N member agents. Members are linked through `PlatosAgentClusterMember`. The cluster owns:

- A `slug` and `name` for routing and display.
- Member agents (each member can belong to at most one cluster).
- Shared memory scope: memory writes by any member surface to all members on memory queries scoped to the cluster.
- Shared thread scope: threads created in cluster context are visible to every member; messages carry an `authorAgentId` so the UI can attribute who wrote what.

Cluster scope sits inside the project scope tuple. Cross-cluster reads are rejected at the auth layer; an agent in cluster A cannot read memory or threads owned by cluster B.

## Why it matters

Without clusters, a chat agent and a background worker that "do the same job" each grow their own memory store, their own threads, and their own user profile. The same user repeats themselves and the BGO has no idea what was promised in chat thirty seconds ago.

Clusters fix that by giving the two agents one identity to write into, while keeping their behaviour separate (different prompts, different tools, different models). The chat agent can hand off "summarise this PDF" to the BGO via `spawn_bgo`, and the BGO posts the summary back into the same thread.

## How to use it

### Build a cluster

From the dashboard, navigate to `/orgs/{org}/projects/{project}/env/{env}/agent-clusters`, click "New cluster", give it a name, and add members. Each member dropdown only lists agents not already in another cluster.

From MCP:

```ts
const cluster = await platos.platos_call("clusters.create", {
  name: "Wally",
  slug: "wally",
  agentIds: [chatAgentId, bgoAgentId],
});
```

### Spawn cross-agent work

A cluster member's `spawn_bgo` call can target a sibling agent in the same cluster:

```text
spawn_bgo({
  targetAgent: "wally-bgo",
  prompt: "Render the slides into a PDF and reply in the thread when ready",
  threadId: currentThread,
})
```

The BGO inherits the cluster's user identity and writes its messages to the same `threadId`. The chat panel renders them with the BGO's avatar and a sub-label.

### Memory and thread isolation

When the chat agent calls `recall`, the runtime scopes the lookup to `(clusterId, userId)`. The chat thread tab shows messages from every cluster member, attributed by `authorAgentId`. IDOR checks on `threads.get` reject any caller whose agent is not a member of the thread's owning cluster.

## Common pitfalls

- An agent can only belong to one cluster at a time. Moving between clusters drops shared memory access from the old cluster.
- Until the agent detail page surfaces a cluster tab (tracked in drift D-005), the cluster is only reachable from the top-level sidebar. Bookmark `/agent-clusters/{clusterId}` if you need fast access.
- Memory written before a cluster was formed stays scoped to the original agent. Cluster scope kicks in on writes that happen after the link.
- Cross-cluster `spawn_bgo` calls are rejected. If you need a cross-cluster handoff, run a tool call instead.

## Related

- [Agents](/docs/agents): the per-agent record; an agent does not need to belong to a cluster.
- [Memory](/docs/memory): scoping rules for cluster-shared memory queries.
- [Conversations and threads](/docs/conversations-and-threads): how `authorAgentId` attribution renders in the chat panel.
- [Platos tasks](/docs/platos-tasks): `spawn_bgo` is the most common cross-member dispatch primitive.
