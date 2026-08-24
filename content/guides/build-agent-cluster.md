---
slug: build-agent-cluster
title: Build an agent cluster
description: Group a chat agent and a Job agent so they share user identity, memory, and threads.
category: recipes
order: 110
questions:
  - "Why would I cluster two agents instead of using one?"
  - "How do I add an agent to a cluster?"
  - "How does shared memory differ from per-agent memory?"
  - "Can a Job post into the chat agent's thread?"
  - "How is cross-cluster IDOR prevented?"
related:
  - extract-memory
  - spawn-job
---

# Build an agent cluster

Group two or more agents so they share user identity, memory, and threads. The classic case: a chat agent plus a Job agent that "feel like one" from the user's perspective.

## The goal

A cluster of agents whose memory writes are visible to every member, whose threads are shared, and whose messages carry attribution (`authorAgentId`) so the UI can show "Wally Chat said X, Wally Job said Y" within one conversation.

## Steps

1. **Create the agents separately.**

   Two agents: `wally-chat` (model: a fast chat model; tools: chat-friendly) and `wally-bgo` (model: a stronger reasoning model; tools: code-runner, scrapers).

2. **Open the clusters page.**

   Sidebar -> Agent clusters -> "New cluster".

3. **Configure.**

   - Name: `Wally`.
   - Slug: `wally`.
   - Members: pick `wally-chat` and `wally-bgo`. The dropdown only shows agents not already in another cluster.

   Save.

4. **Use the cluster from chat.**

   In a chat with `wally-chat`, prompt: "Render the slides into a PDF and reply when ready." The chat agent calls `spawn_job` targeting the `wally-bgo` member; the Job runs; its eventual message lands in the same thread, attributed to `wally-bgo`.

## Verify

- `recall` from `wally-bgo` returns memories written by `wally-chat` (cluster scope).
- The thread shows messages from both agents with their respective avatars.
- An agent in a different cluster cannot read this cluster's threads (IDOR check rejects).

## Memory before vs after the cluster

Memory written before a cluster was formed stays scoped to the original agent. Cluster scope kicks in on writes that happen after the link.

## Next steps

- [Extract long-term memory](/guides/extract-memory) using the cluster scope.
- [Spawn a Job](/guides/spawn-job) for the cross-member dispatch flow.
