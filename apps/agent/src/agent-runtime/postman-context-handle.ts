/**
 * WIN-269 (M4.3) — RE-EXPORT SHIM. THE MODULE MOVED; THIS PATH DID NOT.
 *
 * The implementation now lives at
 * `apps/agent/src/tool-gateway/tool-context/postman-context-handle.ts`.
 *
 * WHY THE MOVE. `tool-gateway/tool-executor.service.ts` imported
 * `traceSessionContext` from `agent-runtime`, while `agent-runtime` imports the
 * executor back. `traceSessionContext` is the rule that decides whether a tool
 * call may carry the caller's session context into a trace — a tool-dispatch
 * concern — and the handle store beside it is read on the same path. Both are
 * pure over `RequestScope` plus an ioredis handle, so they move as leaves.
 *
 * WHY THE SHIM STAYS. `agent.controller.ts` and `agent.service.ts` import from
 * this path and are M3.1's (WIN-261); this tranche may not edit them.
 * `agent-task.service.ts` was repointed at the new path directly. Deleted when
 * M3.1 repoints its two.
 */
export * from "../tool-gateway/tool-context/postman-context-handle";
