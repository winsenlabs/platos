# `@platos/react-hooks`

Platos-native React hooks for agent streaming, context, input streams, and
artifact rendering.

The 1.0 surface exports `usePlatosClient`, `useAgentStream`,
`useInputStreamSend`, the Platos contexts, and `PlatosArtifact`.

Vendor-bound workflow hooks were removed in 1.0.0. Use `PlatosClient.turns`
and `PlatosClient.jobs` for canonical Turn and Job workflows. Stream consumers
must handle `job_update` with `jobId`; the canonical runtime tool is
`spawn_job`.

See [`docs/sdk-v1-migration.md`](../../docs/sdk-v1-migration.md).
