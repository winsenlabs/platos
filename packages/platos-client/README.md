# `@platosdev/client`

Official JavaScript / TypeScript client SDK for [Platos](https://platos.dev) — the open-source agent runtime.

Agents · threads · Turns · Jobs · realtime streaming · approvals · budgets · monitoring.

## Install

```bash
npm install @platosdev/client
# or
pnpm add @platosdev/client
# or
yarn add @platosdev/client
```

Requires Node `>=18.20.0` (for native `fetch` and `ReadableStream`).

## Quick start

```ts
import { PlatosClient } from "@platosdev/client";

const platos = new PlatosClient({
  baseUrl: "https://platos.your-domain.com",
  sessionToken: "<minted by your backend — see Auth below>",
});

// Create a thread for an agent.
const thread = await platos.threads.create(undefined, { agentId: "agt_abc123" });

// Send a message and stream the response.
for await (const event of platos.threads.send(thread.id, "Summarise today's inbox.")) {
  if (event.type === "token") process.stdout.write(event.text);
  if (event.type === "done")  console.log("\n[turn complete]");
}
```

## Auth — session tokens (recommended)

Platos is multi-tenant. Browsers must **never** hold a raw `serviceSecret`. The pattern:

1. **Backend mints** a session token signed with your entity's `serviceSecret` (use `@platosdev/token-mint` or any JWT lib).
2. **Browser** calls `new PlatosClient({ sessionToken })`. The token is a short-lived JWT carrying your scope tuple `(organizationId, projectId, environmentId)`.
3. **Refresh** by re-minting on the server; pass `onTokenRefresh` so the client retries automatically on `401`.

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

## User identity passthrough (`userMeta`)

If your agent needs to know *which of your users* is speaking, sign a `userMeta: { name, email }` claim into the session token. ScopeGuard surfaces it as `{{user.name}}` / `{{user.email}}` in prompts and dynamic blocks, and the trace's identity columns get populated. See [Auth modes docs](https://platos.dev/docs/auth-modes#visitor-identity-usermeta).

## Direct-header mode (server-to-server)

For trusted server-to-server use only — never the browser:

```ts
const platos = new PlatosClient({
  baseUrl: "http://platos:3100",
  apiKey: process.env.PLATOS_INTERNAL_TOKEN!,
  scope: { organizationId, projectId, environmentId },
});
```

## Streaming events

`platos.threads.send(...)` returns an `AsyncIterable<PlatosStreamEvent>`. Common event types:

| `event.type` | When it fires |
|---|---|
| `connected` / `disconnected` / `reconnecting` | WebSocket lifecycle |
| `token` | Streaming text chunk (`event.text`) |
| `thinking` | Reasoning / extended-thinking chunk |
| `tool_call` | Agent invoked a tool (`name`, `params`, `callId`) |
| `tool_result` | Tool returned (`name`, `result`, optional `display` hint) |
| `approval_needed` | HITL gate — call `client.approvals.resolve(...)` to continue |
| `job_update` | Job progress (`jobId`, `status`, output/error metadata) |
| `artifact_start` / `artifact_delta` / `artifact_committed` | Streaming artifact build |
| `safety_flags` | PII / safety filter hits |
| `done` | Turn finished (carries `usage` cost summary) |
| `error` | Server-side error (carries `message` + extras) |

The full union is exported as `PlatosStreamEvent`; reach for it for exhaustive `switch` checks.

## Error handling

All errors extend `PlatosError`. Subclasses encode the failure category:

```ts
import {
  PlatosAuthError,
  PlatosNotFoundError,
  PlatosValidationError,
  PlatosRateLimitError,
  PlatosServerError,
  PlatosNetworkError,
  isRetryableError,
} from "@platosdev/client";

try {
  await platos.threads.send(thread.id, "...").next();
} catch (err) {
  if (err instanceof PlatosAuthError)        { /* 401 / 403 — refresh token */ }
  else if (err instanceof PlatosRateLimitError) { /* 429 — wait err.retryAfterMs */ }
  else if (err instanceof PlatosValidationError) { /* 400 — fix payload */ }
  else if (err instanceof PlatosServerError) { /* 5xx — likely transient */ }
  else if (err instanceof PlatosNetworkError) { /* fetch failed */ }
  else if (isRetryableError(err))            { /* retry path */ }
  throw err;
}
```

## API surface

| Namespace | Methods |
|---|---|
| `client.agents` | `list`, `get`, `listVersions` |
| `client.threads` | `create`, `list`, `get`, `messages`, `artifacts`, `send` (streaming) |
| `client.turns` | `list`, `get` |
| `client.jobs` | `list`, `spawn`, `get`, `cancel`, `replay` |
| `client.approvals` | `list`, `resolve` (human-in-the-loop) |
| `client.budgets` | `list`, `status` (read-only — caps managed in the dashboard) |
| `client.monitoring` | `turns`, `trace`, `costByAgent`, `costByScope` |

`client.bgo` and `client.trigger` are deprecated compatibility aliases for
`client.jobs`. They were deprecated in 1.0.0 and are removed in 2.0.0. See
[`docs/sdk-v1-migration.md`](../../docs/sdk-v1-migration.md).

## Versioning

`@platosdev/client` follows semver. Major bumps signal a breaking change to the wire shape or the public type surface; minor bumps add namespaces or methods; patch bumps are non-breaking fixes.

The wire protocol matches the agent service version; pin a recent client when you upgrade Platos so new event types deserialize correctly.

## Licence

Apache 2.0 — see `LICENSE`. Same as Platos itself.

## Source + issues

- Repo: https://github.com/winsenlabs/platos
- Package directory: `packages/platos-client`
- Issues: https://github.com/winsenlabs/platos/issues
- Docs: https://platos.dev/docs
