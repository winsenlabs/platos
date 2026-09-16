/**
 * WIN-269 (M4.3) — RE-EXPORT SHIM. THE MODULE MOVED; THIS PATH DID NOT.
 *
 * The implementation now lives at
 * `apps/agent/src/tool-gateway/tool-context/context-automap.ts`.
 *
 * WHY THE MOVE. `tool-gateway/tool-executor.service.ts` imported
 * `resolveToolMappings` and `applyResolutions` from `agent-runtime`, while
 * `agent-runtime` imports the executor back. That is the runtime↔tool cycle
 * WIN-269 removes. The module is pure functions over the agent's
 * `contextMapping` JSONB and no Nest provider, so it moves as a leaf.
 *
 * The file name lost its `.service` suffix in the move because it declares no
 * service; this path keeps the old spelling for M3.1's two files only.
 *
 * WHY THE SHIM STAYS. `agent.controller.ts` (dynamic `import()`) and
 * `agent.service.ts` import from this path and are M3.1's (WIN-261); this
 * tranche may not edit them. Deleted when M3.1 repoints them.
 */
export * from "../tool-gateway/tool-context/context-automap";
