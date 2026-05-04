# `@platos/client`

Official JavaScript/TypeScript client for [Platos](https://platos.dev) — the open-source agent runtime.

Agents · threads · realtime streaming · approvals · budgets · tool calls.

## Install

```bash
npm install @platos/client
# or
pnpm add @platos/client
```

Requires Node `>=18.20.0` (for native `fetch` and `ReadableStream`).

## Quick start

```ts
import { PlatosClient } from "@platos/client";

const platos = new PlatosClient({
  baseUrl: "https://platos.your-domain.com",
  sessionToken: "<minted by your backend — see Auth below>",
});

// Create a thread
const thread = await platos.threads.create({ agentId: "agt_abc123" });

// Stream a turn
const stream = platos.agents.stream(thread.id, {
  message: "Summarise today's inbox.",
});

for await (const event of stream) {
  if (event.type === "delta") process.stdout.write(event.text);
  if (event.type === "done")  console.log("\n[turn complete]");
}
```

## Auth — session tokens

Platos is multi-tenant. Browsers should **never** hold a raw `serviceSecret`. The pattern:

1. **Backend mints** a session token signed with your entity's `serviceSecret`. Use `@platos/token-mint` (see below) or follow the `docs/session-tokens.md` wire format.
2. **Browser** calls `new PlatosClient({ sessionToken })`. The token is a short-lived JWT (default 1 hour) carrying your scope tuple.
3. **Refresh** by re-minting on the server when `401` is returned — `PlatosClient` automatically retries the same request with the refreshed token if you pass `onTokenRefresh`.

```ts
const platos = new PlatosClient({
  baseUrl: "https://platos.example.com",
  sessionToken: currentToken,
  onTokenRefresh: async () => {
    const res = await fetch("/api/platos-session", { method: "POST" });
    const { token } = await res.json();
    return token;
  },
});
```

## User identity passthrough

If your agent needs to know *which of your users* is speaking (for per-user memory, rate limits, auth on tools), pass a `userToken` — an opaque identifier minted by your backend. Platos forwards it to your tool backend as `X-Platos-User-Token`:

```ts
const platos = new PlatosClient({
  baseUrl: "...",
  sessionToken: sessionToken,
  userToken: "usr_alice_42",
});
```

## Streaming in the browser

`platos.agents.stream()` returns an async iterator that works in Node, Deno, and browsers. For React, use the dedicated hook:

```tsx
import { useAgentStream } from "@platos/react-hooks";

function Chat({ threadId }) {
  const { events, send, isStreaming } = useAgentStream({ client: platos, threadId });
  // ...
}
```

## Error handling

All errors extend `PlatosError` with a stable `code` property:

```ts
try {
  await platos.agents.stream(thread.id, { message: "..." });
} catch (err) {
  if (err instanceof PlatosError) {
    switch (err.code) {
      case "turn_in_progress":       return "Another turn is streaming; retry later.";
      case "bgo_cap_exceeded":       return "Agent hit the background-operation cap.";
      case "already_processed":      return "Duplicate request (idempotency key already used).";
      case "unauthorized":           return "Session token expired.";
      case "quota_exceeded":         return "Budget cap reached.";
    }
  }
}
```

## Namespaces

| Namespace | What it does |
|---|---|
| `client.agents` | `stream`, `get`, `list` |
| `client.threads` | `create`, `get`, `list`, `fork` |
| `client.messages` | `list`, `rate` |
| `client.memories` | `list`, `get`, `add`, `update`, `delete`, `export` |
| `client.approvals` | `list`, `resolve` (human-in-the-loop) |
| `client.budgets` | `list`, `status` (read-only — caps managed via UI) |
| `client.monitoring` | `runs`, `traces`, `costByAgent`, `costByScope` |
| `client.artifacts` | `get`, `list` (Theme F) |
| `client.skills` | `list`, `enable`, `disable` |

## Licence

Apache 2.0 — same as Platos itself.

## Contributing

Source + issue tracker: https://github.com/platos-dev/platos
