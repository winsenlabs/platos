---
"@platos/client": minor
"@platos/react-hooks": minor
---

Theme I.1 – I.4 — extend `@platos/client` on top of the PPR-34 MVP:

- **Error hierarchy**: `PlatosAuthError`, `PlatosNotFoundError`, `PlatosValidationError`, `PlatosRateLimitError`, `PlatosServerError`, `PlatosNetworkError` all descend from `PlatosError`. `isRetryableError(err)` and `errorFromResponse(res)` helpers exported.
- **Retry with exponential backoff** (configurable `retry` option) on network errors, 5xx, and 429s that carry `Retry-After`.
- **401/403 refresh hook**: `onTokenRefresh({ currentToken, status })` returns a fresh token; the SDK retries the failed request once with the new token. `setSessionToken(token)` mutates the current token manually.
- **Per-call timeout** via `timeoutMs` (default 30 s) implemented with `AbortSignal`.
- **Trigger.dev ops surface** (`client.trigger.tasks / runs / schedules / batches`) mirrors the B.5 meta-tools as first-class SDK calls, plus a `client.trigger.raw(path, init)` escape hatch.
- **Threads surface expanded**: `list`, `get`, `messages`, `artifacts`, `archive`, `unarchive`, `delete`.
- **Hardened realtime**: `threads.send()` now owns its reconnect loop (exponential backoff, configurable `maxReconnectAttempts`). Events arriving while reconnecting are buffered; consumers see a `{ type: "reconnecting", attempt }` event instead of dropped frames.

Theme I.4 — `@platos/react-hooks` adds `PlatosProvider`, `usePlatosClient`, `useAgentStream`, `useThread`, `useToolResult`, `useArtifacts`, and `useStreamingResponse`. No new deps.
