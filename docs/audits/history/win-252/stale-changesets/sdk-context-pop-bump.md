---
"@platools/sdk": minor
---

`@platools/sdk` 0.1.0 → 0.2.0 — first release with audited `_context` envelope handling.

The dispatcher (`src/transport/client.ts`) pops both `__platos` and `_context` from tool-call params before Zod-validating the handler input. Handlers without an explicit `ctx` parameter receive a clean payload; handlers that opt in to `ctx: PlatosContext` get the unpacked CTX.2 envelope. AsyncLocalStorage frame lives only for the duration of `tool.handler`, with guaranteed teardown on error.

Mirrors Python `platools` 0.2.0 — both SDKs ship the same architectural contract: Platos always injects `_context` (default ON for new entities); the SDK pops it; the user function runs with kwargs/input untouched plus ContextVars / AsyncLocalStorage populated.
