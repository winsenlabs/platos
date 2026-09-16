# WIN-269 (M4.3) — apps/agent runtime <-> tool <-> MCP layering

GENERATED — `node scripts/arch/agent-area-cycles.mjs --write`.

Measured over `apps/agent/src`: 283 production files, 28 areas, 1106 intra-app file edges.

## The layering

| layer | areas |
| --- | --- |
| mcp | mcp-platform, mcp-docs |
| runtime | agent-runtime |
| tool | tool-gateway |

Edges between the layer areas, as measured:

| edge | file imports |
| --- | --- |
| `agent-runtime -> mcp-platform` | 1 |
| `agent-runtime -> tool-gateway` | 15 |
| `mcp-docs -> mcp-platform` | 1 |
| `mcp-platform -> agent-runtime` | 15 |
| `mcp-platform -> tool-gateway` | 16 |

## What the gate forbids

- `AAC-1-TOOL_REACHES_RUNTIME`
- `AAC-2-TOOL_REACHES_MCP`
- `AAC-3-RUNTIME_REACHES_MCP`
- `AAC-4-STALE_ALLOWLIST_ENTRY`
- `AAC-5-UNUSED_ALLOWLIST_ENTRY`
- `AAC-6-UNOWNED_ALLOWLIST_ENTRY`

AAC-1..3 are REACHABILITY tests over the whole apps/agent area graph, not path-vs-path tests: an upward edge routed through `monitoring`, `memory` or `privacy` fails them exactly as a direct import does.

## The allowlist

### `apps/agent/src/agent-runtime/agent.controller.ts`

- imports `apps/agent/src/mcp-platform/mcp-management.validation.ts`
- **owner: M3.1 (WIN-261)**
- AgentController imports the MCP management request validators to serve the `/entities/:entityId/mcp/*` routes. M3.1 owns apps/agent AgentController and AgentService and this tranche may not edit either file, so the edge cannot be inverted here. The fix is M3.1's: the validators are a leaf and move behind a tool-gateway-owned seam exactly as context-resolver, context-automap and the postman handle did, or the routes move to core-api with the rest of M3.1's controller. While this entry stands, WIN-269 is NOT closed.

## Is the clause closed?

Census row: _no runtime<->tool<->MCP import cycle remains_

**NOT CLOSED.** The gate passes because the edges below are allowlisted, and an allowlisted cycle is still a cycle. It closes when its owner removes it:

- `agent-runtime/agent.controller.ts -> mcp-platform/mcp-management.validation.ts (owner M3.1 (WIN-261))`

## Carried, and not this clause

- a strongly connected component of 7 areas: `agent-runtime`, `channels`, `connections`, `mcp-platform`, `skills`, `streaming`, `trigger-bridge`
- a strongly connected component of 5 areas: `auth`, `governance`, `monitoring`, `providers`, `tool-gateway`

These are real import cycles and this gate does not fail on them: they are not the runtime<->tool<->MCP clause and they belong to areas no M4 tranche owns. They are recorded so the number is known rather than discovered.
