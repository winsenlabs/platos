---
slug: context
title: Agent context
description: The four-tier context resolver that injects user, session, agent, and project values into tool calls and prompts.
category: platform
order: 120
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "What is the four-tier context resolver?"
  - "How do I inject a user-scoped value into a tool argument?"
  - "What is automap and when does it pick a value automatically?"
  - "How is session context different from user context?"
  - "How do I override a context value for a single turn?"
  - "Where do I configure the param mappings?"
related:
  - agents
  - tools
  - prompts
source_files_referenced:
  - apps/agent/src/agent-runtime/context-resolver.ts
  - apps/agent/src/agent-runtime/context-automap.service.ts
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.context/route.tsx
---

# Agent context

Context is the bag of values the agent's tools need but the model should not have to mention by name. User id, project id, calendar id, customer id: things the runtime knows from the session that the agent should not have to infer. The four-tier resolver injects them into tool arguments and prompt blocks at turn time, with explicit precedence.

## What it is

Four tiers, lowest to highest precedence:

1. **Project**: scope-wide constants (e.g. `tenant_id`). Set in the agent context tab.
2. **Agent**: per-agent constants pinned in the agent's `contextMapping`.
3. **User**: per-user values resolved from the session token (e.g. `user_id`, `user_email`).
4. **Session**: per-turn overrides supplied by the caller in the request payload.

Each tier writes into the resolver's keyed map. When a tool argument or prompt placeholder references `${user_id}`, the resolver walks tiers 4 -> 3 -> 2 -> 1 and returns the first hit.

`ContextResolver` owns the lookup. `ContextAutomapService` owns the auto-derivation: when an agent's `contextMapping` declares an `_auto` value for a key, the automap inspects the tool's input schema and picks the most likely candidate (e.g. when a tool expects `{ userId }` and the session has a `user_id` value, automap maps `userId -> user_id`).

The PIFSP-11 entity-ids mandate is the strongest example: when an agent has `entityIdsRequired: true`, every turn must carry an `entity_ids` list on the session context. Turns missing it fail fast with `ENTITY_IDS_REQUIRED` before the prompt is assembled.

## Why it matters

Without the resolver, every tool call has to mention the user explicitly: "send an email from user X to ...". The model gets it wrong sometimes; the prompt gets verbose; tools end up with leaky abstractions where the model is the auth boundary.

The resolver inverts that. The model sees a tool with input `{ to, body }`; the runtime injects `from = user_email` from the session. The model cannot accidentally call the tool as a different user, because the user id was never in the model's input space.

## How to use it

### Configure mappings

`/orgs/{org}/projects/{project}/env/{env}/agents/{agentId}/context` shows the mapping table. Each row is `{ key, source, fallback }`:

- `source: "session.user_id"` reads tier 4 then falls back through 3 -> 2 -> 1.
- `source: "_auto"` runs automap.
- `source: "_global"` reads from project-tier constants.
- `source: "CONSTANT:hello"` injects the literal string.

Inline edit and save. The runtime invalidates Layer-2 prompt cache for that agent.

### Inject into tool arguments

`toolArgInjection` on `contextMapping` maps tool argument names to resolver keys:

```json
{
  "toolArgInjection": {
    "send_email": { "from": "user_email", "tenant_id": "tenant_id" }
  }
}
```

When the model calls `send_email({ to, body })`, the runtime injects `from` and `tenant_id` from the resolver before dispatching to the entity.

### Inject into prompt blocks

Use `${key}` placeholders in any prompt block. The builder resolves at render time. Layer-2 cache is keyed off the resolved prompt, not the template, so a turn for user A and user B uses different cache entries (correctly).

### Override per turn

Pass `sessionContext` on the chat or messages endpoint:

```ts
await platos.threads.update({
  threadId,
  messages: [...],
  sessionContext: { entity_ids: ["entity-1"], shipping_address_id: "addr-9" },
});
```

These ride at tier 4. They are not persisted; they apply only to this turn.

## Common pitfalls

- `_auto` is best-effort. It works on field-name similarity. Misnamed schema fields will route values incorrectly. Pin the mapping explicitly when correctness matters.
- Project-tier constants do not version. A change applies to every agent in the project on the next turn. If you need a versioned constant, pin it in the agent's `contextMapping` instead.
- `entity_ids` on the session must be a list. Pass `["x"]` not `"x"`. The mandate check rejects the wrong type before the turn starts.
- Cache invalidation depends on the mapping change being a save. Rotating a session value at runtime (e.g. user changes email) flows through immediately because session is tier 4 and not cached.

## Related

- [Agents](/docs/agents): the agent record carries `contextMapping`.
- [Tools](/docs/tools): tool argument injection happens here.
- [Prompts](/docs/prompts): prompt placeholder resolution and the cache layer keyed off resolved prompts.
