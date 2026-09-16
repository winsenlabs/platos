# WIN-253 workspace reachability baseline

> Non-destructive evidence only. This report does not authorize deletion, quarantine, merge, or publication.

Evidence SHA-256: `c7b8cef775ffc9f10a163df0f7193900534be97c302c1c4c98465cf2c5d6acd4`

## Baseline

- Registered workspace members: **64**
- Current OCI image workspace closure: **41**
- Application/deployable workspace closure: **41**
- Application plus migrations union: **42**
- OCI-root + devDependency closure: **45**
- Frozen-install registration traversal: **64**
- Review candidates (not deletion authorization): **22**
- External/public package boundaries: **8**
- Configured patch reconciliation: **5/5** concrete lock snapshots
- Existing SBOM snapshot-node baselines: **agent 718**, **webapp 335**, **core-api 329**
- Generator-owned V1 baseline: **117 files / 36 projects**

The OCI closure is derived from CI-declared shipping Dockerfiles. The application/deployable closure is independently rooted by executable app manifests, root TypeScript references, and CI build entrypoints. Their union retains the V1 application graph and the separately shipped migrations workspace. Every registered workspace remains part of frozen install traversal until separately authorized workspace/lockfile changes occur.

## Independent channel counts

| Channel | Workspaces reached |
| --- | ---: |
| sourceStatic | 48 |
| sourceDynamic | 2 |
| packageScripts | 64 |
| ci | 64 |
| dockerImage | 8 |
| testsFixtures | 61 |
| docsExamples | 61 |
| generated | 44 |
| license | 50 |
| patches | 17 |

## Per-workspace classification

| Workspace | Package | OCI | App/deployable | Union | OCI+dev | Candidate status | Public boundary | Owner decision | Evidence hash |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |
| `apps/agent` | `platos-agent` | yes | yes | yes | yes | retain-oci-image | no | no | `fa1b5e4ed7de94e6…` |
| `apps/core-api` | `@platos/core-api` | yes | yes | yes | yes | retain-oci-image | no | no | `8cc6901030c6a30e…` |
| `apps/mcp-stdio` | `@platos/mcp-stdio` | no | yes | yes | no | retain-application-deployable | no | no | `6f6af5c372e262a8…` |
| `apps/webapp` | `webapp` | yes | yes | yes | yes | retain-oci-image | no | no | `68123fe3ceed6f00…` |
| `docs` | `docs` | no | no | no | no | owner-review-repository-referenced | no | yes | `165dfa4ea02e4017…` |
| `internal-packages/cache` | `@internal/cache` | no | no | no | no | owner-review-repository-referenced | no | yes | `f9f2db1155272a42…` |
| `internal-packages/compute` | `@internal/compute` | no | no | no | no | owner-review-repository-referenced | no | yes | `744fd4bd20e8d379…` |
| `internal-packages/cost-rates` | `@internal/cost-rates` | no | no | no | no | owner-review-repository-referenced | no | yes | `6164efe052d457dc…` |
| `internal-packages/database` | `@platos/database` | no | no | no | yes | owner-review-repository-referenced | no | yes | `dc16a011f526c9ea…` |
| `internal-packages/docs` | `@internal/docs` | yes | yes | yes | yes | retain-oci-image | no | no | `003a711898042865…` |
| `internal-packages/emails` | `emails` | no | no | no | no | owner-review-repository-referenced | no | yes | `d70cdae4f2453d04…` |
| `internal-packages/llm-model-catalog` | `@internal/llm-model-catalog` | no | no | no | no | owner-review-repository-referenced | no | yes | `01ef30f9cd4ea0f7…` |
| `internal-packages/otlp-importer` | `@platos/otlp-importer` | no | no | no | no | owner-review-repository-referenced | no | yes | `63f07e6cca952ce3…` |
| `internal-packages/redis` | `@internal/redis` | no | no | no | no | owner-review-repository-referenced | no | yes | `88d4ec58de27eafd…` |
| `internal-packages/run-engine` | `@internal/run-engine` | no | no | no | no | owner-review-repository-referenced | no | yes | `3575311f0c19cca6…` |
| `internal-packages/schedule-engine` | `@internal/schedule-engine` | no | no | no | no | owner-review-repository-referenced | no | yes | `c6e22fe59eb7f562…` |
| `internal-packages/tenancy-database` | `@platos/tenancy-database` | yes | yes | yes | yes | retain-oci-image | no | no | `f3ae027ee8280b2f…` |
| `internal-packages/tenancy-database/migration-image` | `@platos/tenancy-migration-image` | yes | no | yes | yes | retain-oci-image | no | no | `f63a66d17bb21fb6…` |
| `internal-packages/testcontainers` | `@internal/testcontainers` | no | no | no | yes | owner-review-repository-referenced | no | yes | `b0928098982424ed…` |
| `internal-packages/tracing` | `@internal/tracing` | no | no | no | no | owner-review-repository-referenced | no | yes | `e03f6256d2d15deb…` |
| `internal-packages/workload-identity` | `@internal/workload-identity` | yes | yes | yes | yes | retain-oci-image | no | no | `bbdfbe285f2b6bb0…` |
| `internal-packages/zod-worker` | `@internal/zod-worker` | no | no | no | no | owner-review-repository-referenced | no | yes | `86a5ee29b9046270…` |
| `packages/adapters/channel-discord` | `@platos/adapter-channel-discord` | yes | yes | yes | yes | retain-oci-image | no | no | `71f3fe5307a2961f…` |
| `packages/adapters/channel-slack` | `@platos/adapter-channel-slack` | yes | yes | yes | yes | retain-oci-image | no | no | `15490ce871409802…` |
| `packages/adapters/clickhouse-observability` | `@platos/adapter-clickhouse-observability` | yes | yes | yes | yes | retain-oci-image | no | no | `f857fc2d44513e64…` |
| `packages/adapters/durable-runtime` | `@platos/adapter-durable-runtime` | yes | yes | yes | yes | retain-oci-image | no | no | `31623b67273d0751…` |
| `packages/adapters/keyring-envelope` | `@platos/adapter-keyring-envelope` | yes | yes | yes | yes | retain-oci-image | no | no | `d4d8bb0fa4af9ec1…` |
| `packages/adapters/model-router-providers` | `@platos/adapter-model-router-providers` | yes | yes | yes | yes | retain-oci-image | no | no | `1ad99ec0ed51d1f5…` |
| `packages/adapters/node-crypto-digest` | `@platos/adapter-node-crypto-digest` | yes | yes | yes | yes | retain-oci-image | no | no | `3e133f8037af2536…` |
| `packages/adapters/notifier-email` | `@platos/adapter-notifier-email` | yes | yes | yes | yes | retain-oci-image | no | no | `7d797b3222eb5275…` |
| `packages/adapters/notifier-webhook` | `@platos/adapter-notifier-webhook` | yes | yes | yes | yes | retain-oci-image | no | no | `d8de636b737b014d…` |
| `packages/adapters/objectstore-minio` | `@platos/adapter-objectstore-minio` | yes | yes | yes | yes | retain-oci-image | no | no | `d50f4f1de0309c55…` |
| `packages/adapters/outbox` | `@platos/adapter-outbox` | yes | yes | yes | yes | retain-oci-image | no | no | `a87e66b44f1eb548…` |
| `packages/adapters/postgres-tenancy` | `@platos/adapter-postgres-tenancy` | yes | yes | yes | yes | retain-oci-image | no | no | `d20f068083267a65…` |
| `packages/adapters/redis-cache` | `@platos/adapter-redis-cache` | yes | yes | yes | yes | retain-oci-image | no | no | `84c2a561a6124114…` |
| `packages/adapters/redis-ratelimit` | `@platos/adapter-redis-ratelimit` | yes | yes | yes | yes | retain-oci-image | no | no | `d90b9f4e7403a46d…` |
| `packages/adapters/redis-streams` | `@platos/adapter-redis-streams` | yes | yes | yes | yes | retain-oci-image | no | no | `1cd12f70fe1f1670…` |
| `packages/adapters/tokenmint-totp` | `@platos/adapter-tokenmint-totp` | yes | yes | yes | yes | retain-oci-image | no | no | `014edca2d7bddbef…` |
| `packages/contexts/agents` | `@platos/context-agents` | yes | yes | yes | yes | retain-oci-image | no | no | `51aa9c27a7292ad1…` |
| `packages/contexts/channels` | `@platos/context-channels` | yes | yes | yes | yes | retain-oci-image | no | no | `9937603c65a1e0e3…` |
| `packages/contexts/conversations` | `@platos/context-conversations` | yes | yes | yes | yes | retain-oci-image | no | no | `c23b87e462cbf044…` |
| `packages/contexts/cost-monitoring` | `@platos/context-cost-monitoring` | yes | yes | yes | yes | retain-oci-image | no | no | `94dbbb4f072651e6…` |
| `packages/contexts/eventing` | `@platos/context-eventing` | yes | yes | yes | yes | retain-oci-image | no | no | `e01649e401b39790…` |
| `packages/contexts/files` | `@platos/context-files` | yes | yes | yes | yes | retain-oci-image | no | no | `185913485d2dd606…` |
| `packages/contexts/governance` | `@platos/context-governance` | yes | yes | yes | yes | retain-oci-image | no | no | `87a16dddb5defa0a…` |
| `packages/contexts/identity-access` | `@platos/context-identity-access` | yes | yes | yes | yes | retain-oci-image | no | no | `56e09229aa3804df…` |
| `packages/contexts/jobs` | `@platos/context-jobs` | yes | yes | yes | yes | retain-oci-image | no | no | `b3605eed67c82d07…` |
| `packages/contexts/memory` | `@platos/context-memory` | yes | yes | yes | yes | retain-oci-image | no | no | `de786420a69e6e4a…` |
| `packages/contexts/observability` | `@platos/context-observability` | yes | yes | yes | yes | retain-oci-image | no | no | `a0de22df97276c4c…` |
| `packages/contexts/privacy` | `@platos/context-privacy` | yes | yes | yes | yes | retain-oci-image | no | no | `fc1fa6ba7811ddd6…` |
| `packages/contexts/providers` | `@platos/context-providers` | yes | yes | yes | yes | retain-oci-image | no | no | `7c14e443ad4b4d27…` |
| `packages/contexts/secrets` | `@platos/context-secrets` | yes | yes | yes | yes | retain-oci-image | no | no | `765c42b3036445b8…` |
| `packages/contexts/skills` | `@platos/context-skills` | yes | yes | yes | yes | retain-oci-image | no | no | `21fa650ba45854e5…` |
| `packages/contexts/tenancy` | `@platos/context-tenancy` | yes | yes | yes | yes | retain-oci-image | no | no | `b437be668502d7c4…` |
| `packages/contexts/tools` | `@platos/context-tools` | yes | yes | yes | yes | retain-oci-image | no | no | `fd04450c81bdb234…` |
| `packages/core` | `@platos/core` | no | no | no | yes | owner-review-public-boundary | yes | yes | `ad4d3f0109d91017…` |
| `packages/kernel` | `@platos/kernel` | yes | yes | yes | yes | retain-oci-image | no | no | `95db79a95d37118c…` |
| `packages/platools-js` | `@platosdev/platools-sdk` | no | no | no | no | owner-review-public-boundary | yes | yes | `17f45e66dca2e91c…` |
| `packages/platos-client` | `@platosdev/client` | no | no | no | no | owner-review-public-boundary | yes | yes | `1656e2f4c10fb993…` |
| `packages/platos-embed` | `@platosdev/embed` | no | no | no | no | owner-review-public-boundary | yes | yes | `49bb5573402706cd…` |
| `packages/platos-react-widget` | `@platosdev/react-widget` | no | no | no | no | owner-review-public-boundary | yes | yes | `618d641d9024deec…` |
| `packages/platos-token-mint` | `@platosdev/token-mint` | no | no | no | yes | owner-review-public-boundary | yes | yes | `d5b1206ecd121e9a…` |
| `packages/react-hooks` | `@platos/react-hooks` | no | no | no | no | owner-review-public-boundary | yes | yes | `60a5d19096461195…` |
| `packages/redis-worker` | `@platos/redis-worker` | no | no | no | no | owner-review-public-boundary | yes | yes | `63eea109cbc580bd…` |

Exact roots, reasons, reverse paths, channel evidence, boundaries, input hashes, and full per-workspace hashes are in the JSON artifact.
