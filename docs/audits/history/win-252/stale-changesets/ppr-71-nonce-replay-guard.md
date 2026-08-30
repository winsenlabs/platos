---
title: "[POINT-IN-TIME] Ppr 71 Nonce Replay Guard"
lifecycle: "POINT-IN-TIME"
"@platools/sdk": patch
---

> **Lifecycle: POINT-IN-TIME.** This is a historical snapshot, not current product acceptance. Verify current truth with executable repository evidence.

PPR-71: add HMAC nonce + per-entity LRU replay protection. Platos agent now signs requests as `HMAC-SHA256(secret, "{ts}.{nonce}.{body}")` and forwards `X-Platos-Nonce` (embedded in the `__platos` envelope on the WS path, as an HTTP header on the fallback path). The SDK exposes `verifyRequest()` from `@platools/sdk` which verifies the signature + skew window and rejects replays via an in-process LRU (100k entries per entity, FIFO eviction). Legacy `{ts}.{body}` requests are still accepted for one release with a one-time warning — remove after next release. The `nonce` field on `PlatosCallContext` / `PlatosEnvelope` is optional to allow rolling deploys where the agent hasn't upgraded yet.
