---
slug: tools
title: Tools and tool routing
description: How Platos routes a tool call from the agent to a connected entity, a skill, or a meta-tool.
category: platform
order: 60
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "What are the five families of tools in Platos?"
  - "What is the difference between Direct and Meta tool exposure?"
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

Tools are how an agent interacts with the world. Platos federates five families behind a single registry and serves them to the model under a unified schema. The dashboard shows them all on the Tools tab; the runtime picks which subset to expose per turn based on the agent's `toolsBlockConfig`, the linked entities, and the active skills.

## What it is

Five tool families flow through `ToolRegistryService`:

1. **Entity tools**: pushed by [Connected entities](/docs/connected-entities) over WebSocket. The entity backend declares its tools with name, description, and JSON Schema; the registry mirrors them per scope.
2. **Skill tools**: contributed by [Skills](/docs/skills), official or imported.
3. **Meta-tools**: exactly two tools, `find_tools` and `execute_tools`. They carry no capability of their own — they are a *router* the model uses to reach entity and skill tools whose schemas were not injected this turn.
4. **Runtime tools**: Platos primitives the agent calls directly, always by their own name. `remember`, `recall`, `forget`, `list_memories`, `relate`, `memory_extract`, `generate_artifact`, `revise_artifact`, `spawn_bgo`, `spawn_task` (deprecated alias), `agent_batch`. These are **not** meta-tools and are never routed through `execute_tools`; turning meta-tools off does not remove them.
5. **Control-plane tools**: the MCP-exposed Platos surface (`agents.create`, `threads.list`, etc.). These are not exposed to the model; they are exposed to external MCP clients.

Per turn, the runtime resolves a matrix: for this `(agent, scope)`, which tools are visible? `ToolRouterService` filters by category and by the agent's `enabledTools` allowlist, then **tool exposure** decides whether the surviving tools are injected as schemas or reached through the router. `SchemaInjectorService` renders what the model sees.

## Why it matters

Without a unified registry, an agent that talks to Slack, runs a Python sandbox, and writes to memory ends up with three different schema formats, three different auth modes, and three different cost-tracking paths. The registry collapses them to one set of `(name, description, schema)` triples that the model sees and one tool-call dispatch path that the runtime walks.

The router is what makes 200-tool agents work. Exposing every tool's full schema each turn would blow context windows and shred prompt-cache hits. But the router is not free: it costs the model a discovery round-trip before every call, and it hides schemas the model would otherwise reason over directly. Which trade-off is right depends entirely on how many tools the agent has, so it is a setting rather than a default.

## How to use it

### Pick a tool exposure

The Tools tab splits into two halves. The top control is **tool exposure**, and it is the single switch that decides how the model reaches its tools:

- **Direct** — every enabled tool is injected as a callable tool with its full JSON Schema. The model calls `send_email(...)` by name. `find_tools` and `execute_tools` are **not** present. Best for agents under roughly 40 tools, and required when the tool backend is itself a router (see the pitfall below).
- **Meta** — enabled tools are *not* injected. The model gets `find_tools` and `execute_tools` and discovers the rest at call time. Best for large or open-ended tool sets.

Exposure defaults to **Meta**. It is stored on the agent as `toolExposure` and applies to entity and skill tools only — runtime tools (`remember`, `spawn_bgo`, …) are always injected directly under either setting.

Under Direct, tool order is name-sorted and deduped so the injected block is byte-stable turn to turn, which is what lets the prompt cache hit across a conversation.

### Route by category

Set `enabledCategories` to narrow the matrix to specific tool categories (e.g. `["email", "calendar"]`). Categories come from the entity backend or the skill manifest. This runs *before* exposure, so it shrinks both the injected set under Direct and the searchable set under Meta.

### Discover tools mid-turn

Under Meta exposure, the model calls `find_tools({ query: "send an email" })`. The router runs BM25 over tool names, descriptions, and category descriptions, returns the top candidates with their schemas, and the model then invokes them in a batch:

```json
execute_tools({ "calls": [{ "tool": "gmail_send", "params": { "to": "…" } }] })
```

`calls` is an array — the model can dispatch several tools in one step. BM25 is plain in-memory ranking via `bm25.ts`.

### Test a tool

The Tools tab has a "Test" button per tool. It invokes the tool through the same executor the runtime uses, scoped to the active environment. Useful for verifying entity-side wiring without spinning up an agent turn.

## Common pitfalls

- The early-message buffer in `tool-sync-ws.service.ts:130-135, 281-284` is load-bearing. The buffer listener is attached before the async auth handshake and swapped after auth completes; frames received during the gap are replayed. Removing the buffer drops tool registrations during the connect race. Do not violate this invariant.
- BM25 is in-memory and per-process. A multi-replica deployment needs each replica to keep the registry in sync via the WebSocket fan-out. Cold replicas pre-warm by replaying the registry from the gateway.
- Entity tools mirror what the entity backend declares. If the backend goes offline mid-turn, the matrix still shows the tool, but execution fails with `ENTITY_OFFLINE`. The retry policy is the entity's responsibility.
- `enabledTools` is an allowlist. An empty array means "no entity tools". Set to `null` to mean "all visible".
- **Don't stack a router on a router.** If the connected entity already exposes its own search/execute pair (a gateway that fronts many integrations behind two tools), leaving Platos on Meta exposure gives the model *two* layers of indirection: `find_tools` → the entity's own search → the entity's own execute. The model has to guess a tool name it has never seen a schema for, which is why such agents work intermittently rather than never. Set exposure to **Direct** so the entity's tools arrive as real schemas.
- Turning meta-tools off does not disarm memory or background work. `remember`, `recall`, `spawn_bgo` and the rest are runtime tools, always injected by name under both exposures.

## Related

- [Skills](/docs/skills): how skill tools enter the registry.
- [Connected entities](/docs/connected-entities): how entity tools enter the registry over WebSocket.
- [MCP gateway](/docs/mcp-gateway): the federated surface external clients see.
- [Platos tasks](/docs/platos-tasks): `spawn_bgo` is the runtime tool agents use to dispatch background work.
