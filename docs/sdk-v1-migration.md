# Platos SDK v1 migration

The v1 SDK release aligns all public packages with the canonical domain model:
a completed user-to-agent unit is a **Turn**, and Platos-owned asynchronous work
is a **Job**. This is a breaking release across the npm SDK packages and the two
Python SDKs.

## Client names

| Before v1 | v1 replacement | Compatibility/removal |
|---|---|---|
| `client.bgo` | `client.jobs` | Removed in 1.0.0; the nested legacy API cannot map truthfully to canonical Job routes |
| `client.trigger` | `client.jobs` | Removed in 1.0.0; the nested legacy API cannot map truthfully to canonical Job routes |
| `Trigger*` client types | Canonical Job types | Removed in 1.0.0 |
| monitoring run lists | Canonical Turn collection | Old method removed in 1.0.0; public Turn routes are not exposed by this SDK until the runtime provides `/api/v1/agent/turns` |

The Python `client.bgo`/`client.trigger` properties are also removed in 1.0.0.

## Streaming

| Before v1 | v1 replacement |
|---|---|
| `{ type: "run_update", runId }` | `{ type: "job_update", jobId }` |
| `{ type: "reconnecting", attempt }` | `{ type: "reconnecting", retryCount }` |
| `structured_output.attempts` | `structured_output.retryCount` |
| `spawn_bgo` | `spawn_job` |

These old stream and runtime-tool names are removed in 1.0.0; they are not
emitted as dual aliases.

## React hooks

`useRun`, `useRealtime`, `useTaskTrigger`, `useWaitToken`, `useInputStreamSend`,
`useApiClient`, the vendor auth contexts, and `trigger-swr` were vendor-bound
surfaces and are removed from `@platos/react-hooks` in 1.0.0. Use
`@platosdev/client` through `usePlatosClient`, then call `client.jobs`.

## Browser context safety

The public TypeScript client, Python client, and React widget no longer accept
per-message session-context overrides. Context simulation is an operator-only
runtime concern and is not part of a browser or end-user SDK payload.

## Tool registration

`tool_register` is a complete declaration. If a service first declares 22
tools and later declares 9, the platform retains those 9 and prunes the other
13. An empty declaration removes all tools. Both Platools SDKs replay the
current complete declaration on reconnect.

## Session tokens

`entityId` is required. Mint only on a trusted backend using that Entity's
`serviceSecret`; never send the secret to a browser. The agent verifies the JWT
against the resolved Entity secret and its Organization/Project/Environment
ancestry.

## The generated V1 surface (WIN-270, M4.4)

The V1 core-api routes are reached through a SEPARATE client, `createV1Client`,
whose namespaces are **generated** rather than hand-written: `pnpm generate:sdk-v1`
emits `@platosdev/client`'s `src/generated/v1.ts` and `platos_client.generated.v1`
from the V1 OpenAPI document, the operation manifest and core-api's own
idempotency policy, and `pnpm audit:sdk-v1` fails when a committed client differs
from what those inputs emit. The hand-written `apps/agent` namespaces above are
unchanged and still serve the operations that declare no wire DTO.

It is a separate client and not a `PlatosClient` namespace because the two
AUTHENTICATE DIFFERENTLY. `PlatosClient` sends `X-Platos-Session-Token`; the V1
operator seam reads the `__Host-` operator session cookie or
`Authorization: Bearer`, and nothing else. Hanging a namespace off `PlatosClient`
that silently ignored the credential that client was constructed with would be
worse than a second constructor.

```ts
import { createV1Client } from "@platosdev/client";

const v1 = createV1Client({ baseUrl, operatorToken });
const organizations = await v1.organizations.list();
const minted = await v1.mcpPlatformTokens.mint({ /* MintPlatformTokenBody */ });
```

```python
from platos_client.v1_transport import create_v1_client

v1 = create_v1_client(base_url, operator_token=operator_token)
organizations = v1.organizations.list()
```

### Token minting goes through the served routes, with a key

`POST /mcp/platform/tokens` and `POST /mcp/entity/:entityId/tokens` are
one-time-secret mints: ADR M0.4 §2 REQUIRES an `Idempotency-Key`, and without
one the server answers `400 IDEMPOTENCY_KEY_REQUIRED`. Both clients send one
automatically, minted **once per logical call** and reused on every retry of
that call, so a mint whose response is lost to a dropped socket replays the
first answer instead of creating a second live credential.

Supply your own factory when the key must survive a process restart — a key held
only in memory cannot replay a mint the crash interrupted:

```ts
createV1Client({ baseUrl, operatorToken, idempotencyKey: (request) => myStableKey(request) });
```

`transport.lastResponseWasReplay` (`transport.last_response_was_replay` in
Python) reports the server's `Idempotency-Replayed: true`.

`@platosdev/token-mint` is unaffected: it signs a session-token JWT locally and
calls nothing.

### Refusals carry a code

Every non-2xx answer from the V1 surface is ADR M0.4 §2's envelope, and the SDKs
now read it. **This changes observable behaviour** and needs no code change:

| Before | Now |
|---|---|
| `err.message` was the bare HTTP status text | `err.message` leads with `error.code` |
| `error.code` was dropped | `err.code` (`err.code` in Python), plus `err.refusal` carrying `errorId`, `traceRef`, `version` and `fields[]` |
| `PlatosAuthError`/`PlatosNotFoundError`/`PlatosValidationError` extended `PlatosError` | they extend the new `PlatosRefusal`, which extends `PlatosError` |
| a 4xx with no named subclass became a bare `PlatosError` | it becomes a `PlatosRefusal` |

`instanceof PlatosError` and every named subclass keep working; `PlatosRefusal`
only widens what a single `catch` can reach. `PlatosRateLimitError` is
deliberately **not** in the refusal family — a 429 refuses this request and
invites another, which is why `isRetryableError` still returns `true` for it.

`err.code` is `undefined` (`None` in Python) when the body was not a V1
envelope. The SDK never invents a code: an invented one would be
indistinguishable from one the taxonomy minted.

### Widget and embed behaviour changes

- `usePlatosChat` throws a coded `PlatosRefusal` when `tokenUrl` refuses, and a
  refusal that names the status when the answer was not a V1 envelope. A `200`
  carrying no `{ token }` is also a refusal rather than a session.
- **A turn that never reached the agent no longer leaves an assistant bubble.**
  The optimistic placeholder is withdrawn instead of being rendered as
  `[error]`, because a visitor the server declined should not be shown a
  transcript. A turn that DID reach the agent and then failed keeps its bubble
  and now carries `message.refusalCode`. Hosts that keyed off the literal
  `"[error]"` content should read `error`/`refusalCode` instead.
- `<platos-agent>` drops its internal iframe handle when a required attribute
  goes missing, so its `postMessage` trust check never consults a detached
  frame. No attribute or event changed.

### Python packaging

`import platos_client` no longer imports `httpx` or `websockets` eagerly;
`PlatosClient` and the REST namespaces are resolved on first attribute access
(PEP 562). `from platos_client import PlatosClient` is unchanged. The practical
effect is that the error types and the V1 client import with no third-party
dependency at all.

### Reading an event stream

`environmentStreams.read` (`environment_streams.read` in Python) is an event
stream, and the generated method is now a **streaming method**. **This changes
its signature**: it used to return `Promise<void>` through the JSON transport,
which threw `SyntaxError` on every valid stream, so no working caller depended on
the old shape.

```ts
const stream = v1.environmentStreams.read(environmentId, streamId);
for await (const frame of stream) render(frame); // frame: { sv, t, seq, ts, ...fields }
// stream.end: { kind: "completed" } | { kind: "failed", code } | ...
```

```python
stream = v1.environment_streams.read(environment_id, stream_id)
for frame in stream:
    render(frame)
```

Nothing is sent until you iterate. The reader then:

| On the wire | What the reader does |
|---|---|
| the leading `stream_meta` event | checks `sv` is in the band this SDK reads and `replayFrom` is the position it asked for; anything else is a `PlatosStreamError` |
| a frame the kernel's `admitFrame` says to apply | hands it to you and records its `seq` and its `id:` cursor |
| a frame at or behind that position | drops it: redelivery after a reconnect is normal |
| a frame ahead of it (frames were lost) | abandons the connection and re-reads after the last applied cursor |
| `turn.done` or `stream.error` | ends the iteration; `stream.end` says which |
| `stream.offline`, or a connection that stops with no terminal frame | reconnects with `Last-Event-ID`; throws once `maxReconnects` (`max_reconnects`; default 5) reconnects in a row have applied no frame |
| a 5xx or 429 before the stream opens | retries with the same cursor; any other refusal is thrown as before |

The reconnect budget counts reconnects **in a row** with no frame applied between
them, not reconnects over the stream's life: a connection that applies at least
one frame restores it, and the backoff starts over. A long stream behind a proxy
that closes every connection after a while therefore finishes, while a server
that keeps answering with nothing new is still given up on. `stream.reconnects`
counts every reconnect.

A request carries no per-request timeout: a stream is long by design. Instead a
connection that delivers nothing — heartbeats included — for `idleTimeoutMs`
(`idle_timeout_s`; default 45 seconds, three of the server's heartbeats) is
treated as severed and resumed.

A stream request carries the client's `fetchOptions` (`credentials`, `mode`,
`cache`) exactly as a JSON call does, so a browser that authenticates with the
session cookie passes `credentials: "include"` once; the reader's own method,
headers and signal take precedence.

To continue in another process, save `stream.lastEventId` and `stream.lastSeq`
and pass both back (`lastEventId` + `lastSeq`, or `last_event_id` + `last_seq`);
one without the other is refused, because a frame is admitted against a sequence
and the cursor is opaque. A custom `V1Transport` must now implement
`stream(request, options)` as well as `send`, and `V1Operation` carries
`responseKind`.

## Retries

`PlatosClient` in `@platosdev/client` now retries a failed request only when
sending it again cannot repeat its effect. **This changes observable behaviour**
(recorded as a major in `.changeset/platos-client-post-retry-guard.md`):

| Request | Before | Now |
|---|---|---|
| `GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS` | retried up to `maxRetries` | unchanged |
| any method carrying a non-empty `Idempotency-Key` | retried up to `maxRetries` | unchanged, and every retry carries the same key |
| `POST` or `PATCH` without `Idempotency-Key` | retried up to `maxRetries` | **sent once**; its first failure is thrown |

The idempotent methods are RFC 9110 §9.2.2's. The header is matched
case-insensitively, and its name is imported from the generated V1 module so it
cannot drift from the one the server reads. Which failures count as retryable
(`isRetryableError`: network errors, 5xx, 429) and the `Retry-After` wait are
unchanged; what changed is whether a non-repeatable request is eligible at all.

In practice this reaches `approvals.resolve`, `jobs.create`, `jobs.update`,
`jobs.dispatch`, `messages.rate`, `threads.create`, `threads.archive`,
`threads.unarchive`, `tools.setEnabled` and `tools.test`. A transient failure on
one of those used to be absorbed, and could apply the effect twice when the first
request had reached the server; it now reaches your `catch`. Retry it yourself
only where your application knows repeating it is safe.

`createV1Client` is unaffected: it mints one `Idempotency-Key` per logical call
for every side-effecting V1 operation core-api's idempotency policy does not
exempt, and retries under that key. The Python
`PlatosClient` is also unchanged by this entry — its `_request_with_retry` still
retries every method, which is a known divergence between the two clients rather
than a documented equivalence.

## Version policy

- npm packages use Changesets and receive a major release for this migration.
- `platos-client` and `platools` on PyPI are set explicitly to `1.0.0`, because
  Changesets does not update `pyproject.toml`.
- Names marked removed in 1.0.0 have no compatibility export. The old nested
  BGO/Trigger namespaces are intentionally not represented as shallow aliases.
