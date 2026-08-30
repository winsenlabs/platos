---
title: "[POINT-IN-TIME] Ppr 29 Platools Js Strict Context"
lifecycle: "POINT-IN-TIME"
"@platools/sdk": patch
---

> **Lifecycle: POINT-IN-TIME.** This is a historical snapshot, not current product acceptance. Verify current truth with executable repository evidence.

PPR-29: Align TypeScript `currentContext()` with Python's strict semantics. `envelopeToContext()` now returns `null` when any required field on the envelope is missing or non-string (mirroring `platools-py`'s `current_context()`), instead of coercing missing fields to empty strings. `fallbackCallId` argument removed from the public signature — the server always injects `callId` into the envelope (PPR-30), and the SDK no longer synthesizes it from the outer message. Handler code guarding `if (ctx)` now behaves identically across languages on partial envelopes. Tests updated to cover the new strict contract.
