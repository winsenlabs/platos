# `@platos/react-hooks`

Platos-native React hooks for agent streaming, client context, and artifact
rendering.

The 1.0 surface exports `PlatosProvider`, `usePlatosClient`, `useAgentStream`,
the canonical stream event helpers, and `PlatosArtifact`.

Vendor-bound workflow, input-stream, API-client, and auth-context hooks were
removed in 1.0.0. Use `PlatosClient.jobs` for canonical Job workflows. Stream
consumers must handle `job_update` with `jobId`; the canonical runtime tool is
`spawn_job`.

See [`docs/sdk-v1-migration.md`](../../docs/sdk-v1-migration.md).
