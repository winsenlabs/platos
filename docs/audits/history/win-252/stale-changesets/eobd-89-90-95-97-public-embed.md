---
title: "[POINT-IN-TIME] Eobd 89 90 95 97 Public Embed"
lifecycle: "POINT-IN-TIME"
"@platos/embed": minor
---

> **Lifecycle: POINT-IN-TIME.** This is a historical snapshot, not current product acceptance. Verify current truth with executable repository evidence.

EOBD.89/90/95/97 — public embed foundations:

- EOBD.89: new `PlatosAgent.visibility` column (default `"private"`, opt-in `"public-guest"`) + migration. Enables the B2C chatbot flow.
- EOBD.95: new `POST /api/v1/entities/:entityId/session-tokens` endpoint on the agent — entity backends Bearer-auth with their `serviceSecret` and mint scoped session tokens without implementing HMAC themselves.
- EOBD.90: new `@platos/embed` package — `<platos-agent>` web component wraps an iframe pointed at the Platos embed route. Drop-in for any HTML page.
- EOBD.97: wire-test page scaffold for entity detail (follow-up commit wires the webapp route).

Public guest-token minting, wire-test webapp route, rate limits, and the embed HTML route itself are still pending — tracked as follow-ups, blocking only the full B2C launch sequence, not EOBD closure.
