---
slug: agents
title: Agents
description: Durable, versioned agents with their own prompt, tools, models, memory, and budgets.
category: platform
order: 10
questions:
  - "How do I create an agent?"
  - "What is the difference between a Platos agent and an external provider resource?"
  - "Where does an agent's prompt live and how is it edited?"
  - "How do I clone an existing agent into a new one?"
  - "Which fields on an agent are versioned vs live-edited?"
  - "How do I delete an agent and what happens to its conversations?"
  - "What does an agent record look like in the database?"
related:
  - agent-versions
  - skills
  - tools
  - models
  - providers
  - memory
  - prompts
---

# Agents

An agent in Platos is a durable, versioned configuration that pairs a system prompt with a set of tools, a model, a memory policy, and budget caps. You create one through the dashboard or the `agents.create` MCP tool, and from that point on every chat turn, every tool call, every memory write, and every cost row is attributed to it.

## What it is

An `Agent` row in Postgres. It owns:

- A `name`, a `slug` (unique within `(projectId, environmentId)`), and a `model` string like `anthropic:claude-opus-4-7`.
- A `systemPrompt` (free text) or a `promptBlocks` array (composable blocks that the runtime serialises into a system prompt at turn time).
- A `toolsBlockConfig` describing which tools are visible, which tool categories are enabled, and the `toolExposure` — `direct` (every enabled tool injected with its full schema) or `meta` (reached through the `find_tools`/`execute_tools` router). See [Tools](/docs/tools#pick-a-tool-exposure).
- A `metaTools` map listing which Platos runtime tools are exposed (`spawn_job`, `remember`, `recall`, `generate_artifact`, etc.). Despite the field name these are ordinary tools injected by name; the two actual meta-tools, `find_tools` and `execute_tools`, are governed by `toolExposure` rather than by this map.
- A `subAgentConfig` for sub-agent dispatch, a `memoryConfig` for memory tier policy, and `featureFlags` for opt-in runtime behaviours.
- An optional `outputSchema` (JSON Schema) that constrains the model's response, an `extractionPolicy` for memory extraction, and a `contextMapping` for the [Context](/docs/context) resolver.
- Lifecycle pointers: `currentVersionId` (the live config snapshot), `canaryVersionId` and `canaryPercent` for staged rollouts, plus the scope tuple `(organizationId, projectId, environmentId)`.

Behaviour-changing fields are versioned. Identity fields (`name`, `slug`, scope) are not. See [Agent versions](/docs/agent-versions) for the full split.

## Why it matters

An agent is the deployable unit in Platos. You ship a turn loop by writing a prompt and pointing it at a model; everything the agent then does (which provider key it spent against, which entities it called, which conversations it can see) flows from this one record.

Without it, every team would be wiring its own loop: managing retries, encrypting transcripts, attributing costs, gating tools behind approvals, versioning prompts. The agent record collapses that into one config you can clone, version, and roll back.

## How to use it

### Create from the dashboard

Navigate to `/orgs/{org}/projects/{project}/env/{env}/agents/new`. The wizard walks you through identity (name, slug), model + provider key, prompt blocks, tools, and a starter context mapping. Hit save and the runtime persists the agent and writes the first `AgentVersion` snapshot in the same transaction.

### Create through REST

```ts
const response = await fetch("https://platos.example.com/api/v1/agent/agents", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.PLATOS_PAT}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    name: "Wally Chat",
    slug: "wally-chat",
    model: "anthropic:claude-opus-4-7",
    systemPrompt: "You are Wally, a calendar assistant.",
  }),
});

if (!response.ok) throw new Error(`Agent creation failed: ${response.status}`);
const agent = await response.json();
```

Platform MCP clients may instead use the generated `agents.create` operation.

### Update vs version

`PATCH /api/v1/agent/agents/:agentId` updates the live row and writes a new version snapshot. Pass `versionNote` to label the snapshot. Identity fields (`name`, `slug`) live-edit without bumping the version. See [Agent versions](/docs/agent-versions).

### Delete

`DELETE /api/v1/agent/agents/:agentId` soft-deletes the agent. Conversations stay reachable for audit; new turns are rejected. Hard delete requires admin scope and runs the GDPR cascade for the user data the agent touched.

## Common pitfalls

- The model picker is scope-filtered. If a provider's `required_env` keys are not linked in the current environment, its models do not appear. Wire up keys in [Providers](/docs/providers) first.
- `spawn_job` defaults on for new agents and is the only authored background-work runtime tool name.
- An agent's slug is unique per `(projectId, environmentId)`. Cloning across environments works; cloning within the same env auto-suffixes with a base36 timestamp.
- Hard-deleting an agent before exporting its conversations loses the encrypted message history. Export first via `threads.list` + `messages.list`.

## Related

- [Agent versions](/docs/agent-versions): every behaviour change snapshots; rollback restores a snapshot atomically.
- [Skills](/docs/skills): reusable behaviours an agent enables in `toolsBlockConfig` or via meta-tools.
- [Tools](/docs/tools): the four families the runtime exposes, plus how the matrix is filtered per agent.
- [Models](/docs/models): the catalog the picker reads from, scoped by linked providers.
- [Providers](/docs/providers): BYOK provider keys; without one linked, the model picker is empty.
- [Memory](/docs/memory): how an agent's memory tier policy and extraction settings come from the agent record.
- [Prompts](/docs/prompts): how `promptBlocks` are assembled, cached, and rendered each turn.
