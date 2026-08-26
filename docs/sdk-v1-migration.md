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

## Version policy

- npm packages use Changesets and receive a major release for this migration.
- `platos-client` and `platools` on PyPI are set explicitly to `1.0.0`, because
  Changesets does not update `pyproject.toml`.
- Names marked removed in 1.0.0 have no compatibility export. The old nested
  BGO/Trigger namespaces are intentionally not represented as shallow aliases.
