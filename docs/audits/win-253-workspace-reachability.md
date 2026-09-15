# WIN-253 workspace reachability baseline

> Non-destructive evidence only. This report does not authorize deletion, quarantine, merge, or publication.

Evidence SHA-256: `fa02997a9bfad34eeb778939011f75fca1adc8033023fada97fb30b9f81b91d9`

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
- Generator-owned V1 baseline: **119 files / 36 projects**

The OCI closure is derived from CI-declared shipping Dockerfiles. The application/deployable closure is independently rooted by executable app manifests, root TypeScript references, and CI build entrypoints. Their union retains the V1 application graph and the separately shipped migrations workspace. Every registered workspace remains part of frozen install traversal until separately authorized workspace/lockfile changes occur.

## Independent channel counts

| Channel | Workspaces reached |
| --- | ---: |
| sourceStatic | 48 |
| sourceDynamic | 2 |
| packageScripts | 64 |
| ci | 64 |
| dockerImage | 8 |
| testsFixtures | 60 |
| docsExamples | 61 |
| generated | 44 |
| license | 50 |
| patches | 17 |

## Per-workspace classification

| Workspace | Package | OCI | App/deployable | Union | OCI+dev | Candidate status | Public boundary | Owner decision | Evidence hash |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |
| `apps/agent` | `platos-agent` | yes | yes | yes | yes | retain-oci-image | no | no | `e82077134c09833d…` |
| `apps/core-api` | `@platos/core-api` | yes | yes | yes | yes | retain-oci-image | no | no | `289f7ba98718c4d5…` |
| `apps/mcp-stdio` | `@platos/mcp-stdio` | no | yes | yes | no | retain-application-deployable | no | no | `c639b9fa7221006e…` |
| `apps/webapp` | `webapp` | yes | yes | yes | yes | retain-oci-image | no | no | `bd347a8ff3d6ddda…` |
| `docs` | `docs` | no | no | no | no | owner-review-repository-referenced | no | yes | `ad349ddea44d60ba…` |
| `internal-packages/cache` | `@internal/cache` | no | no | no | no | owner-review-repository-referenced | no | yes | `f9f2db1155272a42…` |
| `internal-packages/compute` | `@internal/compute` | no | no | no | no | owner-review-repository-referenced | no | yes | `744fd4bd20e8d379…` |
| `internal-packages/cost-rates` | `@internal/cost-rates` | no | no | no | no | owner-review-repository-referenced | no | yes | `6164efe052d457dc…` |
| `internal-packages/database` | `@platos/database` | no | no | no | yes | owner-review-repository-referenced | no | yes | `8c82a5da1a433d9c…` |
| `internal-packages/docs` | `@internal/docs` | yes | yes | yes | yes | retain-oci-image | no | no | `f103fe02fd78580c…` |
| `internal-packages/emails` | `emails` | no | no | no | no | owner-review-repository-referenced | no | yes | `26084070c458a754…` |
| `internal-packages/llm-model-catalog` | `@internal/llm-model-catalog` | no | no | no | no | owner-review-repository-referenced | no | yes | `01ef30f9cd4ea0f7…` |
| `internal-packages/otlp-importer` | `@platos/otlp-importer` | no | no | no | no | owner-review-repository-referenced | no | yes | `5202fcc1f799053d…` |
| `internal-packages/redis` | `@internal/redis` | no | no | no | no | owner-review-repository-referenced | no | yes | `747a9cc62ba19d54…` |
| `internal-packages/run-engine` | `@internal/run-engine` | no | no | no | no | owner-review-repository-referenced | no | yes | `11bda105fd2f9d00…` |
| `internal-packages/schedule-engine` | `@internal/schedule-engine` | no | no | no | no | owner-review-repository-referenced | no | yes | `c6e22fe59eb7f562…` |
| `internal-packages/tenancy-database` | `@platos/tenancy-database` | yes | yes | yes | yes | retain-oci-image | no | no | `7d1df3ba1cb57484…` |
| `internal-packages/tenancy-database/migration-image` | `@platos/tenancy-migration-image` | yes | no | yes | yes | retain-oci-image | no | no | `f63a66d17bb21fb6…` |
| `internal-packages/testcontainers` | `@internal/testcontainers` | no | no | no | yes | owner-review-repository-referenced | no | yes | `4040c438255b3f61…` |
| `internal-packages/tracing` | `@internal/tracing` | no | no | no | no | owner-review-repository-referenced | no | yes | `e03f6256d2d15deb…` |
| `internal-packages/workload-identity` | `@internal/workload-identity` | yes | yes | yes | yes | retain-oci-image | no | no | `e6775b1d418866f8…` |
| `internal-packages/zod-worker` | `@internal/zod-worker` | no | no | no | no | owner-review-repository-referenced | no | yes | `86a5ee29b9046270…` |
| `packages/adapters/channel-discord` | `@platos/adapter-channel-discord` | yes | yes | yes | yes | retain-oci-image | no | no | `220f49a44e109cc0…` |
| `packages/adapters/channel-slack` | `@platos/adapter-channel-slack` | yes | yes | yes | yes | retain-oci-image | no | no | `439c718b3e839b26…` |
| `packages/adapters/clickhouse-observability` | `@platos/adapter-clickhouse-observability` | yes | yes | yes | yes | retain-oci-image | no | no | `477e03168a543e4a…` |
| `packages/adapters/durable-runtime` | `@platos/adapter-durable-runtime` | yes | yes | yes | yes | retain-oci-image | no | no | `f8f5d8c7e82ed9b0…` |
| `packages/adapters/keyring-envelope` | `@platos/adapter-keyring-envelope` | yes | yes | yes | yes | retain-oci-image | no | no | `e03ba779b3528865…` |
| `packages/adapters/model-router-providers` | `@platos/adapter-model-router-providers` | yes | yes | yes | yes | retain-oci-image | no | no | `02c83177646a57a0…` |
| `packages/adapters/node-crypto-digest` | `@platos/adapter-node-crypto-digest` | yes | yes | yes | yes | retain-oci-image | no | no | `d2ce720844de953b…` |
| `packages/adapters/notifier-email` | `@platos/adapter-notifier-email` | yes | yes | yes | yes | retain-oci-image | no | no | `409bb1926769f545…` |
| `packages/adapters/notifier-webhook` | `@platos/adapter-notifier-webhook` | yes | yes | yes | yes | retain-oci-image | no | no | `82ab1fea4afb0b0e…` |
| `packages/adapters/objectstore-minio` | `@platos/adapter-objectstore-minio` | yes | yes | yes | yes | retain-oci-image | no | no | `9c27c41c3974be27…` |
| `packages/adapters/outbox` | `@platos/adapter-outbox` | yes | yes | yes | yes | retain-oci-image | no | no | `37f06d6d0a0bbcbe…` |
| `packages/adapters/postgres-tenancy` | `@platos/adapter-postgres-tenancy` | yes | yes | yes | yes | retain-oci-image | no | no | `58cb68c182817610…` |
| `packages/adapters/redis-cache` | `@platos/adapter-redis-cache` | yes | yes | yes | yes | retain-oci-image | no | no | `4d0590e3da84d422…` |
| `packages/adapters/redis-ratelimit` | `@platos/adapter-redis-ratelimit` | yes | yes | yes | yes | retain-oci-image | no | no | `a3edac4fdae75c22…` |
| `packages/adapters/redis-streams` | `@platos/adapter-redis-streams` | yes | yes | yes | yes | retain-oci-image | no | no | `8be5476a4e7b60bb…` |
| `packages/adapters/tokenmint-totp` | `@platos/adapter-tokenmint-totp` | yes | yes | yes | yes | retain-oci-image | no | no | `9787088e30f9a02a…` |
| `packages/contexts/agents` | `@platos/context-agents` | yes | yes | yes | yes | retain-oci-image | no | no | `3255ebd67bcc538b…` |
| `packages/contexts/channels` | `@platos/context-channels` | yes | yes | yes | yes | retain-oci-image | no | no | `aaa04771993995e7…` |
| `packages/contexts/conversations` | `@platos/context-conversations` | yes | yes | yes | yes | retain-oci-image | no | no | `4949bbf6525ec055…` |
| `packages/contexts/cost-monitoring` | `@platos/context-cost-monitoring` | yes | yes | yes | yes | retain-oci-image | no | no | `15f9970aa7b7fee6…` |
| `packages/contexts/eventing` | `@platos/context-eventing` | yes | yes | yes | yes | retain-oci-image | no | no | `82d21eeff9dcbee1…` |
| `packages/contexts/files` | `@platos/context-files` | yes | yes | yes | yes | retain-oci-image | no | no | `e89d32c7b6422485…` |
| `packages/contexts/governance` | `@platos/context-governance` | yes | yes | yes | yes | retain-oci-image | no | no | `1f86b7963277dd20…` |
| `packages/contexts/identity-access` | `@platos/context-identity-access` | yes | yes | yes | yes | retain-oci-image | no | no | `8e25568a34e5ee49…` |
| `packages/contexts/jobs` | `@platos/context-jobs` | yes | yes | yes | yes | retain-oci-image | no | no | `0a83f99d13245e71…` |
| `packages/contexts/memory` | `@platos/context-memory` | yes | yes | yes | yes | retain-oci-image | no | no | `5c347e2eba1ca803…` |
| `packages/contexts/observability` | `@platos/context-observability` | yes | yes | yes | yes | retain-oci-image | no | no | `a7468cc529f39a3a…` |
| `packages/contexts/privacy` | `@platos/context-privacy` | yes | yes | yes | yes | retain-oci-image | no | no | `c5be6603cc8875ba…` |
| `packages/contexts/providers` | `@platos/context-providers` | yes | yes | yes | yes | retain-oci-image | no | no | `14913a75b3a45b92…` |
| `packages/contexts/secrets` | `@platos/context-secrets` | yes | yes | yes | yes | retain-oci-image | no | no | `4711448e102b9cdc…` |
| `packages/contexts/skills` | `@platos/context-skills` | yes | yes | yes | yes | retain-oci-image | no | no | `5eb6bcffdd8be340…` |
| `packages/contexts/tenancy` | `@platos/context-tenancy` | yes | yes | yes | yes | retain-oci-image | no | no | `9596b6d69208c4ac…` |
| `packages/contexts/tools` | `@platos/context-tools` | yes | yes | yes | yes | retain-oci-image | no | no | `4d0f7182049832aa…` |
| `packages/core` | `@platos/core` | no | no | no | yes | owner-review-public-boundary | yes | yes | `3770d048540fbfc0…` |
| `packages/kernel` | `@platos/kernel` | yes | yes | yes | yes | retain-oci-image | no | no | `801ca37158c328e2…` |
| `packages/platools-js` | `@platosdev/platools-sdk` | no | no | no | no | owner-review-public-boundary | yes | yes | `f18ab16bb96256ff…` |
| `packages/platos-client` | `@platosdev/client` | no | no | no | no | owner-review-public-boundary | yes | yes | `85a0d9ad4af583ec…` |
| `packages/platos-embed` | `@platosdev/embed` | no | no | no | no | owner-review-public-boundary | yes | yes | `34ba474f699c1d72…` |
| `packages/platos-react-widget` | `@platosdev/react-widget` | no | no | no | no | owner-review-public-boundary | yes | yes | `1cc79739618d77b9…` |
| `packages/platos-token-mint` | `@platosdev/token-mint` | no | no | no | yes | owner-review-public-boundary | yes | yes | `f392576405cec143…` |
| `packages/react-hooks` | `@platos/react-hooks` | no | no | no | no | owner-review-public-boundary | yes | yes | `e7d6b6269f0582f5…` |
| `packages/redis-worker` | `@platos/redis-worker` | no | no | no | no | owner-review-public-boundary | yes | yes | `63eea109cbc580bd…` |

Exact roots, reasons, reverse paths, channel evidence, boundaries, input hashes, and full per-workspace hashes are in the JSON artifact.
