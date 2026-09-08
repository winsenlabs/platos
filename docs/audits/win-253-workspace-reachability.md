# WIN-253 workspace reachability baseline

> Non-destructive evidence only. This report does not authorize deletion, quarantine, merge, or publication.

Evidence SHA-256: `a6a36a432f24922c57e59e8f6bdc44ef5081a2001625d7adb2a50ab326d44e02`

## Baseline

- Registered workspace members: **63**
- Current OCI image workspace closure: **6**
- Application/deployable workspace closure: **40**
- Application plus migrations union: **41**
- OCI-root + devDependency closure: **10**
- Frozen-install registration traversal: **63**
- Review candidates (not deletion authorization): **22**
- External/public package boundaries: **8**
- Configured patch reconciliation: **5/5** concrete lock snapshots
- Existing SBOM snapshot-node baselines: **agent 718**, **webapp 335**
- Generator-owned V1 baseline: **120 files / 35 projects**

The OCI closure is derived from CI-declared shipping Dockerfiles. The application/deployable closure is independently rooted by executable app manifests, root TypeScript references, and CI build entrypoints. Their union retains the V1 application graph and the separately shipped migrations workspace. Every registered workspace remains part of frozen install traversal until separately authorized workspace/lockfile changes occur.

## Independent channel counts

| Channel | Workspaces reached |
| --- | ---: |
| sourceStatic | 46 |
| sourceDynamic | 2 |
| packageScripts | 63 |
| ci | 63 |
| dockerImage | 7 |
| testsFixtures | 59 |
| docsExamples | 60 |
| generated | 43 |
| license | 49 |
| patches | 17 |

## Per-workspace classification

| Workspace | Package | OCI | App/deployable | Union | OCI+dev | Candidate status | Public boundary | Owner decision | Evidence hash |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |
| `apps/agent` | `platos-agent` | yes | yes | yes | yes | retain-oci-image | no | no | `f568dd97b0a6b7b3…` |
| `apps/core-api` | `@platos/core-api` | no | yes | yes | no | retain-application-deployable | no | no | `e21505c67859345d…` |
| `apps/mcp-stdio` | `@platos/mcp-stdio` | no | yes | yes | no | retain-application-deployable | no | no | `6a476d5fb9e8d7ff…` |
| `apps/webapp` | `webapp` | yes | yes | yes | yes | retain-oci-image | no | no | `e106ac7819dbda24…` |
| `docs` | `docs` | no | no | no | no | owner-review-repository-referenced | no | yes | `8d22bac63ce057c3…` |
| `internal-packages/cache` | `@internal/cache` | no | no | no | no | owner-review-repository-referenced | no | yes | `f9f2db1155272a42…` |
| `internal-packages/compute` | `@internal/compute` | no | no | no | no | owner-review-repository-referenced | no | yes | `744fd4bd20e8d379…` |
| `internal-packages/cost-rates` | `@internal/cost-rates` | no | no | no | no | owner-review-repository-referenced | no | yes | `6164efe052d457dc…` |
| `internal-packages/database` | `@platos/database` | no | no | no | yes | owner-review-repository-referenced | no | yes | `a7e2083bf41c152d…` |
| `internal-packages/docs` | `@internal/docs` | yes | yes | yes | yes | retain-oci-image | no | no | `e44c8a0d0d6008a8…` |
| `internal-packages/emails` | `emails` | no | no | no | no | owner-review-repository-referenced | no | yes | `26084070c458a754…` |
| `internal-packages/llm-model-catalog` | `@internal/llm-model-catalog` | no | no | no | no | owner-review-repository-referenced | no | yes | `01ef30f9cd4ea0f7…` |
| `internal-packages/otlp-importer` | `@platos/otlp-importer` | no | no | no | no | owner-review-repository-referenced | no | yes | `63ee1ccd463c0dc5…` |
| `internal-packages/redis` | `@internal/redis` | no | no | no | no | owner-review-repository-referenced | no | yes | `7e2bce57dce9388b…` |
| `internal-packages/run-engine` | `@internal/run-engine` | no | no | no | no | owner-review-repository-referenced | no | yes | `55600e9eec8ffb92…` |
| `internal-packages/schedule-engine` | `@internal/schedule-engine` | no | no | no | no | owner-review-repository-referenced | no | yes | `c6e22fe59eb7f562…` |
| `internal-packages/tenancy-database` | `@platos/tenancy-database` | yes | yes | yes | yes | retain-oci-image | no | no | `bcb59b7aa6c7706a…` |
| `internal-packages/tenancy-database/migration-image` | `@platos/tenancy-migration-image` | yes | no | yes | yes | retain-oci-image | no | no | `f63a66d17bb21fb6…` |
| `internal-packages/testcontainers` | `@internal/testcontainers` | no | no | no | yes | owner-review-repository-referenced | no | yes | `bb476fbe57da5a07…` |
| `internal-packages/tracing` | `@internal/tracing` | no | no | no | no | owner-review-repository-referenced | no | yes | `e03f6256d2d15deb…` |
| `internal-packages/workload-identity` | `@internal/workload-identity` | yes | yes | yes | yes | retain-oci-image | no | no | `1e22022c7c11d502…` |
| `internal-packages/zod-worker` | `@internal/zod-worker` | no | no | no | no | owner-review-repository-referenced | no | yes | `86a5ee29b9046270…` |
| `packages/adapters/channel-slack` | `@platos/adapter-channel-slack` | no | yes | yes | no | retain-application-deployable | no | no | `7da8e56cce5052ae…` |
| `packages/adapters/clickhouse-observability` | `@platos/adapter-clickhouse-observability` | no | yes | yes | no | retain-application-deployable | no | no | `0e548018f3101554…` |
| `packages/adapters/durable-runtime` | `@platos/adapter-durable-runtime` | no | yes | yes | no | retain-application-deployable | no | no | `facc4099bc582aac…` |
| `packages/adapters/keyring-envelope` | `@platos/adapter-keyring-envelope` | no | yes | yes | no | retain-application-deployable | no | no | `9e05b942943fdd5d…` |
| `packages/adapters/model-router-providers` | `@platos/adapter-model-router-providers` | no | yes | yes | no | retain-application-deployable | no | no | `e9a0152802110b16…` |
| `packages/adapters/node-crypto-digest` | `@platos/adapter-node-crypto-digest` | no | yes | yes | no | retain-application-deployable | no | no | `f47f82207cf80779…` |
| `packages/adapters/notifier-email` | `@platos/adapter-notifier-email` | no | yes | yes | no | retain-application-deployable | no | no | `ca71ec24fc235ca7…` |
| `packages/adapters/notifier-webhook` | `@platos/adapter-notifier-webhook` | no | yes | yes | no | retain-application-deployable | no | no | `b725855ada9d92d1…` |
| `packages/adapters/objectstore-minio` | `@platos/adapter-objectstore-minio` | no | yes | yes | no | retain-application-deployable | no | no | `5524e2315001c834…` |
| `packages/adapters/outbox` | `@platos/adapter-outbox` | no | yes | yes | no | retain-application-deployable | no | no | `10b58cc7b173bc45…` |
| `packages/adapters/postgres-tenancy` | `@platos/adapter-postgres-tenancy` | no | yes | yes | no | retain-application-deployable | no | no | `0b73fb69a83448e7…` |
| `packages/adapters/redis-cache` | `@platos/adapter-redis-cache` | no | yes | yes | no | retain-application-deployable | no | no | `d9afe5267973d5bf…` |
| `packages/adapters/redis-ratelimit` | `@platos/adapter-redis-ratelimit` | no | yes | yes | no | retain-application-deployable | no | no | `7a2581f381e690f2…` |
| `packages/adapters/redis-streams` | `@platos/adapter-redis-streams` | no | yes | yes | no | retain-application-deployable | no | no | `962ccb5f9dd651d7…` |
| `packages/adapters/tokenmint-totp` | `@platos/adapter-tokenmint-totp` | no | yes | yes | no | retain-application-deployable | no | no | `81226b5d20d15db2…` |
| `packages/contexts/agents` | `@platos/context-agents` | no | yes | yes | no | retain-application-deployable | no | no | `1872e1322a3fb049…` |
| `packages/contexts/channels` | `@platos/context-channels` | no | yes | yes | no | retain-application-deployable | no | no | `93bb33aac9d3e4eb…` |
| `packages/contexts/conversations` | `@platos/context-conversations` | no | yes | yes | no | retain-application-deployable | no | no | `c1bc75ad539b486b…` |
| `packages/contexts/cost-monitoring` | `@platos/context-cost-monitoring` | no | yes | yes | no | retain-application-deployable | no | no | `8f4b2fb36bbcf272…` |
| `packages/contexts/eventing` | `@platos/context-eventing` | no | yes | yes | no | retain-application-deployable | no | no | `67ca2b023d2b8de0…` |
| `packages/contexts/files` | `@platos/context-files` | no | yes | yes | no | retain-application-deployable | no | no | `70e72e5d7445936f…` |
| `packages/contexts/governance` | `@platos/context-governance` | no | yes | yes | no | retain-application-deployable | no | no | `ca7212925685d3ac…` |
| `packages/contexts/identity-access` | `@platos/context-identity-access` | no | yes | yes | no | retain-application-deployable | no | no | `171f58a82adf0bf4…` |
| `packages/contexts/jobs` | `@platos/context-jobs` | no | yes | yes | no | retain-application-deployable | no | no | `dc7b7b645202a5a7…` |
| `packages/contexts/memory` | `@platos/context-memory` | no | yes | yes | no | retain-application-deployable | no | no | `adeb3f6701e8c1e8…` |
| `packages/contexts/observability` | `@platos/context-observability` | no | yes | yes | no | retain-application-deployable | no | no | `b3941e2df8a369c5…` |
| `packages/contexts/privacy` | `@platos/context-privacy` | no | yes | yes | no | retain-application-deployable | no | no | `2496aed2a26454cf…` |
| `packages/contexts/providers` | `@platos/context-providers` | no | yes | yes | no | retain-application-deployable | no | no | `54f26271966afade…` |
| `packages/contexts/secrets` | `@platos/context-secrets` | no | yes | yes | no | retain-application-deployable | no | no | `ea3567733a64edde…` |
| `packages/contexts/skills` | `@platos/context-skills` | no | yes | yes | no | retain-application-deployable | no | no | `b5cde9de1841d595…` |
| `packages/contexts/tenancy` | `@platos/context-tenancy` | no | yes | yes | no | retain-application-deployable | no | no | `d035ef57f3e44de7…` |
| `packages/contexts/tools` | `@platos/context-tools` | no | yes | yes | no | retain-application-deployable | no | no | `1f3c24ccdd58b587…` |
| `packages/core` | `@platos/core` | no | no | no | yes | owner-review-public-boundary | yes | yes | `d2e8fdcb24c24c4a…` |
| `packages/kernel` | `@platos/kernel` | no | yes | yes | no | retain-application-deployable | no | no | `710f5a482e7c4f98…` |
| `packages/platools-js` | `@platosdev/platools-sdk` | no | no | no | no | owner-review-public-boundary | yes | yes | `51e254dc667559d2…` |
| `packages/platos-client` | `@platosdev/client` | no | no | no | no | owner-review-public-boundary | yes | yes | `9756bf724fd0a127…` |
| `packages/platos-embed` | `@platosdev/embed` | no | no | no | no | owner-review-public-boundary | yes | yes | `26f83fd504a22a2c…` |
| `packages/platos-react-widget` | `@platosdev/react-widget` | no | no | no | no | owner-review-public-boundary | yes | yes | `87406163254db53e…` |
| `packages/platos-token-mint` | `@platosdev/token-mint` | no | no | no | yes | owner-review-public-boundary | yes | yes | `72a406936156a843…` |
| `packages/react-hooks` | `@platos/react-hooks` | no | no | no | no | owner-review-public-boundary | yes | yes | `092d6043ec50ecdf…` |
| `packages/redis-worker` | `@platos/redis-worker` | no | no | no | no | owner-review-public-boundary | yes | yes | `e42019e87abb9845…` |

Exact roots, reasons, reverse paths, channel evidence, boundaries, input hashes, and full per-workspace hashes are in the JSON artifact.
