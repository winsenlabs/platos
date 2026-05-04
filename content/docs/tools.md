---
slug: tools
title: Tools and tool routing
description: How Platos routes a tool call from the agent to a connected entity, a skill, or a meta-tool.
category: platform
order: 60
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "What are the four families of tools in Platos?"
  - "How does Platos pick which tool to expose to the model?"
  - "What is the tool router and when does BM25 ranking kick in?"
  - "How do tool schemas reach the LLM?"
  - "Where do tool-call results come back from?"
  - "How do I add a new tool category?"
  - "What is the early-message buffer in tool-sync-ws.service.ts?"
related:
  - skills
  - connected-entities
  - mcp-gateway
  - platos-tasks
source_files_referenced:
  - apps/agent/src/tool-gateway/tool-registry.service.ts
  - apps/agent/src/tool-gateway/tool-router.service.ts
  - apps/agent/src/tool-gateway/tool-executor.service.ts
  - apps/agent/src/tool-gateway/schema-injector.service.ts
  - apps/agent/src/tool-gateway/tool-sync-ws.service.ts
  - apps/agent/src/tool-gateway/bm25.ts
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-tools._index/route.tsx
---

# Tools and tool routing

Tools are how an agent interacts with the world. Platos federates four families behind a single registry and serves them to the model under a unified schema. The dashboard shows them all on the Tools tab; the runtime picks which subset to expose per turn based on the agent's `toolsBlockConfig`, the linked entities, and the active skills.

## What it is

Four tool families flow through `ToolRegistryService`:

1. **Entity tools**: pushed by [Connected entities](/docs/connected-entities) over WebSocket. The entity backend declares its tools with name, description, and JSON Schema; the registry mirrors them per scope.
2. **Skill tools**: contributed by [Skills](/docs/skills), official or imported.
3. **Meta-tools**: Platos primitives the agent uses to operate on itself. `find_tools`, `execute_tools`, `remember`, `recall`, `forget`, `list_memories`, `relate`, `memory_extract`, `generate_artifact`, `revise_artifact`, `spawn_bgo`, `spawn_task` (deprecated alias), `agent_batch`.
4. **Control-plane tools**: the MCP-exposed Platos surface (`agents.create`, `threads.list`, etc.). These are not exposed to the model; they are exposed to external MCP clients.

Per turn, the runtime resolves a matrix: for this `(agent, scope)`, which tools are visible? `ToolRouterService` filters by category, by the agent's `enabledTools` allowlist, and by display mode. `SchemaInjectorService` then renders the JSON Schemas the model sees.

## Why it matters

Without a unified registry, an agent that talks to Slack, runs a Python sandbox, and writes to memory ends up with three different schema formats, three different auth modes, and three different cost-tracking paths. The registry collapses them to one set of `(name, description, schema)` triples that the model sees and one tool-call dispatch path that the runtime walks.

The router is what makes 200-tool agents work. Exposing every tool's full schema each turn would blow context windows and shred prompt-cache hits. Display modes (`full`, `summary`, `meta-tool`, `hybrid`) let the agent expose only the essentials and reach the long tail through `find_tools` discovery.

## How to use it

### Pick a display mode

In the agent's Tools tab, set `displayMode`:

- `full`: every enabled tool's full JSON Schema visible. Good for small, fixed tool sets.
- `summary`: no tool schemas; the runtime injects a system-prompt addendum that lists categories and tool counts. The model uses `find_tools` and `execute_tools` to discover and call.
- `meta-tool`: only meta-tools, no category hint. Pure discovery mode.
- `hybrid`: union of pinned tools (full schemas), meta-tools, and the summary block. Best for "always-on essentials plus long tail".

### Route by category

Set `enabledCategories` to narrow the matrix to specific tool categories (e.g. `["email", "calendar"]`). Categories come from the entity backend or the skill manifest.

### Discover tools mid-turn

When the agent is in `summary` or `hybrid` mode, the model calls `find_tools({ query: "send an email" })`. The router runs BM25 over tool names, descriptions, and category descriptions, returns the top candidates with their schemas, and the model then calls `execute_tools({ name, args })` to actually invoke. BM25 is plain in-memory ranking via `bm25.ts`.

### Test a tool

The Tools tab has a "Test" button per tool. It invokes the tool through the same executor the runtime uses, scoped to the active environment. Useful for verifying entity-side wiring without spinning up an agent turn.

## Common pitfalls

- The early-message buffer in `tool-sync-ws.service.ts:130-135, 281-284` is load-bearing. The buffer listener is attached before the async auth handshake and swapped after auth completes; frames received during the gap are replayed. Removing the buffer drops tool registrations during the connect race. Do not violate this invariant.
- BM25 is in-memory and per-process. A multi-replica deployment needs each replica to keep the registry in sync via the WebSocket fan-out. Cold replicas pre-warm by replaying the registry from the gateway.
- Entity tools mirror what the entity backend declares. If the backend goes offline mid-turn, the matrix still shows the tool, but execution fails with `ENTITY_OFFLINE`. The retry policy is the entity's responsibility.
- `enabledTools` is an allowlist. An empty array means "no entity tools". Set to `null` to mean "all visible".

## Related

- [Skills](/docs/skills): how skill tools enter the registry.
- [Connected entities](/docs/connected-entities): how entity tools enter the registry over WebSocket.
- [MCP gateway](/docs/mcp-gateway): the federated surface external clients see.
- [Platos tasks](/docs/platos-tasks): `spawn_bgo` is the meta-tool agents use to dispatch background work.
