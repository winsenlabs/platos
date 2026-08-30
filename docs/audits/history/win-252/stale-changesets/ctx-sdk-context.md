---
title: "[POINT-IN-TIME] Ctx Sdk Context"
lifecycle: "POINT-IN-TIME"
"@platools/sdk": patch
---

> **Lifecycle: POINT-IN-TIME.** This is a historical snapshot, not current product acceptance. Verify current truth with executable repository evidence.

CTX.5: Platools SDK unpacks the agent's `_context` envelope and hands it to tool handlers as an optional second argument. Handlers declared as `(params, ctx)` now receive a `PlatosContext` carrying `callId`, the unpacked `context` map (e.g. `ctx.context["user.id"]`), the heuristically-extracted `entityIds` list used for matrix routing, and the original envelope under `raw` for escape-hatch consumers. Both `__platos` (the signed scope tuple) and `_context` (the per-handler envelope) are now stripped from `params` before Zod validation so neither leaks into the handler's typed input. The handler signature is backwards-compatible: existing `(params) => …` handlers keep working unchanged because `ctx` is `?` optional. The Python SDK mirrors the behavior via an opt-in `ctx` parameter name detected by the decorator; the parameter is automatically excluded from the generated tool schema. New exports: `PlatosContext`, `buildPlatosContext` (TS) / `PlatosContext`, `build_platos_context` (Py).
