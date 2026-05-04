---
"@platos/client": patch
---

Add `modelLabel` to `SendMessageOptions` for per-request model routing.

Pass a named route label (e.g. `"fast"`, `"smart"`) to `threads.send()` to
select a specific model route configured on the agent, overriding the agent's
default model for that turn only:

```ts
// use the "fast" route for a quick summarisation turn
for await (const event of client.threads.send(threadId, "Summarise this", { modelLabel: "fast" })) { … }

// use the "smart" route for deep reasoning
for await (const event of client.threads.send(threadId, "Reason through…", { modelLabel: "smart" })) { … }
```

Falls back to the agent's default route when omitted.
