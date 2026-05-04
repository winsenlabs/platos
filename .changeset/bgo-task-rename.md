---
"@platos/client": minor
"@platos/react-hooks": patch
---

Theme BGO — rename Platos-exposed "task" surfaces to "bgo" (background operation).

`PlatosClient` now exposes a `client.bgo` namespace for durable
background-operation ops (tasks catalog, runs, schedules, batches).
The previous `client.trigger` namespace is preserved as a deprecated alias
pointing at the same `TriggerApi` instance — it will be removed in the next
major. Both namespaces are interchangeable during the one-release compat
window.

On the stream protocol side, the `run_update` event — emitted when the
durable background operation (`spawn_bgo`, formerly `spawn_task`) fires —
is unchanged on the wire. The doc comment in
`@platos/react-hooks/useAgentStream` was updated to reference the new
meta-tool name.

See `docs/BGO_RENAME.md` for the full rename table and deprecation plan.
