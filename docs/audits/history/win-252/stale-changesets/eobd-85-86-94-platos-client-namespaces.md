---
"@platos/client": minor
"@platos/token-mint": minor
---

EOBD.85/86/94 — SDK surface expansion:

- `@platos/client` gains `approvals`, `budgets`, `monitoring` namespaces (EOBD.85).
- `@platos/client` now forwards an opaque `userToken` via `X-Platos-User-Token` on every REST call — set via `new PlatosClient({ userToken })` or per-call via `scope.userToken` (EOBD.86).
- New `@platos/token-mint` package (EOBD.94) — HS256 JWT minter for customer backends. Takes `{ serviceSecret, claims, ttlSeconds }` and produces a signed Platos session token.
