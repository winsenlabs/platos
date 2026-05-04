---
"@platos/react-hooks": patch
---

EOBD.87 — `useAgentStream` guards every `setEvents` / `setTokens` call against `cancelled`, not just the top-of-loop break. Closes a race where an event arriving between the effect cleanup and the next `await` in the async iterator would leak into the new run's empty buffer, showing a stale event from the previous message in a fresh conversation.
