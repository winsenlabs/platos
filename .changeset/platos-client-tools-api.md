---
"@platosdev/client": minor
---

Add `client.tools` namespace (issue #2) — typed wrappers for the tool-catalog REST surface exposed by the agent service. Previously consumers had to hand-roll fetch calls with the right scope + auth plumbing.

New methods:
- `client.tools.list({ category? })` — GET /api/v1/agent/tools
- `client.tools.search(q, { limit?, entity? })` — GET /api/v1/agent/tools/search
- `client.tools.stats()` — GET /api/v1/agent/tools/stats
- `client.tools.matrix()` — GET /api/v1/agent/tools/matrix (per-entity grid with health data)
- `client.tools.setEnabled(entityId, toolName, enabled)` — PATCH …/:entityId/:toolName/enabled
- `client.tools.test(toolId, params)` — POST …/:toolId/test

Exports: `PlatosTool`, `PlatosToolHealth`, `PlatosToolMatrixRow`, `PlatosToolStats`, `PlatosToolListOptions`, `PlatosToolSearchOptions`, `PlatosToolTestResult`.
