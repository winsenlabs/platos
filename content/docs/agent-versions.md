---
slug: agent-versions
title: Agent versions, canary, rollback
description: Version every change to an agent and roll back instantly without losing conversation history.
category: platform
order: 20
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How do I version an agent and roll back to a previous version?"
  - "What is a canary version and how do I promote it?"
  - "Which agent fields trigger a new version vs a live edit?"
  - "How do I diff two agent versions?"
  - "What is the difference between agent versions and engine deployments?"
  - "How do conversations behave when I roll back the agent?"
related:
  - agents
  - evals-ab
  - deployments
source_files_referenced:
  - apps/agent/src/agent-runtime/agent.service.ts
  - apps/agent/src/agent-runtime/agent.service-version-lock.test.ts
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.versions/route.tsx
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.canary/route.tsx
  - docs/themes/THEME_G.md
---

# Agent versions, canary, rollback

Every behaviour-changing edit to an agent writes an immutable `PlatosAgentVersion` snapshot. You can roll back to any past snapshot in one click, run a staged canary at any percentage, and diff two versions field by field. Conversations are not invalidated; they keep streaming against whichever version was current when the turn started.

## What it is

A `PlatosAgentVersion` is an append-only row keyed by `(agentId, versionNumber)`. The `snapshot` JSON column captures every user-editable field at save time: `model`, `modelRoutes`, `systemPrompt`, `promptBlocks`, `dynamicBlocks`, `maxSteps`, `contextLimit`, `historyMode`, `compactThreshold`, `enableUserProfiling`, `toolMode`, `toolsBlockConfig`, `subAgentConfig`, `memoryConfig`, `metaTools`, `featureFlags`, `outputSchema`, `extractionPolicy`, plus `enableThreading` and `threadingConfig`.

Identity fields (`name`, `slug`, scope) and lifecycle pointers (`currentVersionId`, `canaryVersionId`) are intentionally excluded. Rollback never renames an agent or moves it between scopes.

The agent row carries:

- `currentVersionId`: the version every turn defaults to.
- `canaryVersionId` plus `canaryPercent` (0-100): when a turn starts, the runtime hashes a stable key (user id or thread id) and routes that fraction of traffic at the canary snapshot.

## Why it matters

Prompt changes are the riskiest deploys in an agent stack. A one-line tweak can flip the regression rate of every conversation. Versioning lets you ship a tweak behind a 5% canary, watch costs and ratings on the canary tab for an hour, and either promote it or roll back without touching a deploy pipeline.

It also gives you a forensic record. When a customer asks "what changed last Tuesday at 4pm that broke X?", `versionNumber` plus the `note` you wrote at save time is the answer.

## How to use it

### Save a version

Edit any behaviour field in the agent detail page and hit save. A new snapshot row is written in a transaction and `currentVersionId` is updated atomically. Add a note in the dialog, e.g. "tighten reply tone, drop the overly chatty disclaimers".

From MCP:

```ts
await platos.agents.update({
  agentId,
  systemPrompt: "...",
  versionNote: "drop disclaimers",
});
```

### Promote to canary

`PATCH /agent/v1/agents/:agentId/canary` with `{ canaryVersionId, canaryPercent: 5 }` exposes that snapshot to 5% of traffic. The hash key is the thread id, so a single user's session lands consistently on one variant for that conversation.

```ts
await platos.agents.canary_set({ agentId, canaryVersionId, canaryPercent: 5 });
```

Watch the canary metrics tab. When you are ready, `agents.canary_promote` swaps `currentVersionId = canaryVersionId` and clears the canary fields.

### Rollback

From the versions tab, pick any past version and click "Rollback". The runtime copies the old snapshot back onto the live agent row in a transaction and writes a new version (the rollback itself is a version, with note `Rolled back to v{n}`). Conversations continue mid-stream against whichever snapshot they captured at turn start.

### Diff

`platos.platos_diff_agents({ agentId, fromVersion, toVersion })` returns a JSON Patch between the two snapshots. The dashboard renders the same diff in a side-by-side view.

## Common pitfalls

- A turn started against version A keeps using version A even if you ship version B mid-stream. Streaming consistency beats aggressive cutover. Long-running BGOs respect this for their full duration.
- Canary percent is a hashed split, not random. The same user lands on the same variant. To force a clean A/B, use [A/B evals](/docs/evals-ab) instead.
- Rollback restores behaviour, not data. Conversations created under v3 are still there; only the live config changes back.
- Version numbers are monotonic per agent; gaps mean concurrent saves were serialised. The transaction guarantees no two snapshots ever share the same number.

## Related

- [Agents](/docs/agents): the agent record itself, including the field split between versioned and live-edited.
- [A/B evals](/docs/evals-ab): structured comparison of two versions on a fixed input set.
- [Deployments](/docs/deployments): the engine-tier deployment concept; agent versions are unrelated to engine deployments and live in a different lifecycle.
