/**
 * WIN-269 (M4.3) — RE-EXPORT SHIM. THE MODULE MOVED; THIS PATH DID NOT.
 *
 * The implementation now lives at
 * `apps/agent/src/tool-gateway/tool-context/context-resolver.ts`.
 *
 * WHY THE MOVE. `tool-gateway` imported `filterByEntityIds`, `resolvePath`,
 * `injectArgs` and `buildEnvelope` from `agent-runtime`, while `agent-runtime`
 * imports `tool-gateway`'s registry, router and executor. That is the
 * runtime↔tool import cycle WIN-269 exists to remove. The four helpers are pure
 * functions over a JSONB shape — they belong to the TOOL side of the boundary,
 * which is why the seam they moved behind is tool-gateway's.
 *
 * WHY THE SHIM STAYS. `agent.controller.ts` and `agent.service.ts` import these
 * symbols from this path, and BOTH FILES ARE M3.1's (WIN-261); this tranche may
 * not edit them. The shim makes the move invisible to them. The edge it creates
 * — `agent-runtime` -> `tool-gateway` — is the ALLOWED direction, so it closes
 * the cycle rather than relocating it.
 *
 * It is deleted when M3.1 repoints its two files at the new path. Nothing else
 * in the tree imports through here; `scripts/arch/agent-area-cycles.mjs` is what
 * keeps it that way.
 */
export * from "../tool-gateway/tool-context/context-resolver";
