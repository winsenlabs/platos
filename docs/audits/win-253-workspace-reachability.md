# WIN-253 workspace reachability baseline

> Non-destructive evidence only. This report does not authorize deletion, quarantine, merge, or publication.

Evidence SHA-256: `650fd9539496c4654723750c22d8fa122e0d93200d390abfda3598b53af33845`

## Baseline

- Registered workspace members: **60**
- Current OCI image workspace closure: **6**
- Application/deployable workspace closure: **37**
- Application plus migrations union: **38**
- OCI-root + devDependency closure: **10**
- Frozen-install registration traversal: **60**
- Review candidates (not deletion authorization): **22**
- External/public package boundaries: **8**
- Configured patch reconciliation: **5/5** concrete lock snapshots
- Existing SBOM snapshot-node baselines: **agent 718**, **webapp 335**
- Generator-owned V1 baseline: **115 files / 32 projects**

The OCI closure is derived from CI-declared shipping Dockerfiles. The application/deployable closure is independently rooted by executable app manifests, root TypeScript references, and CI build entrypoints. Their union retains the V1 application graph and the separately shipped migrations workspace. Every registered workspace remains part of frozen install traversal until separately authorized workspace/lockfile changes occur.

## Independent channel counts

| Channel | Workspaces reached |
| --- | ---: |
| sourceStatic | 43 |
| sourceDynamic | 2 |
| packageScripts | 60 |
| ci | 60 |
| dockerImage | 7 |
| testsFixtures | 53 |
| docsExamples | 57 |
| generated | 40 |
| license | 46 |
| patches | 17 |

## Per-workspace classification

| Workspace | Package | OCI | App/deployable | Union | OCI+dev | Candidate status | Public boundary | Owner decision | Evidence hash |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |
| `apps/agent` | `platos-agent` | yes | yes | yes | yes | retain-oci-image | no | no | `f46413b56e8a40cb…` |
| `apps/core-api` | `@platos/core-api` | no | yes | yes | no | retain-application-deployable | no | no | `53c67987e1563293…` |
| `apps/mcp-stdio` | `@platos/mcp-stdio` | no | yes | yes | no | retain-application-deployable | no | no | `24eb49d4631f1d14…` |
| `apps/webapp` | `webapp` | yes | yes | yes | yes | retain-oci-image | no | no | `be7d731edd5aad04…` |
| `docs` | `docs` | no | no | no | no | owner-review-repository-referenced | no | yes | `7eddbbd1afff317a…` |
| `internal-packages/cache` | `@internal/cache` | no | no | no | no | owner-review-repository-referenced | no | yes | `f9f2db1155272a42…` |
| `internal-packages/compute` | `@internal/compute` | no | no | no | no | owner-review-repository-referenced | no | yes | `744fd4bd20e8d379…` |
| `internal-packages/cost-rates` | `@internal/cost-rates` | no | no | no | no | owner-review-repository-referenced | no | yes | `6164efe052d457dc…` |
| `internal-packages/database` | `@platos/database` | no | no | no | yes | owner-review-repository-referenced | no | yes | `d4da8313ab139673…` |
| `internal-packages/docs` | `@internal/docs` | yes | yes | yes | yes | retain-oci-image | no | no | `46bdcc86a506379d…` |
| `internal-packages/emails` | `emails` | no | no | no | no | owner-review-repository-referenced | no | yes | `26084070c458a754…` |
| `internal-packages/llm-model-catalog` | `@internal/llm-model-catalog` | no | no | no | no | owner-review-repository-referenced | no | yes | `01ef30f9cd4ea0f7…` |
| `internal-packages/otlp-importer` | `@platos/otlp-importer` | no | no | no | no | owner-review-repository-referenced | no | yes | `35c293168a99e683…` |
| `internal-packages/redis` | `@internal/redis` | no | no | no | no | owner-review-repository-referenced | no | yes | `08d45dbdf86429ec…` |
| `internal-packages/run-engine` | `@internal/run-engine` | no | no | no | no | owner-review-repository-referenced | no | yes | `6c68cd0cc3f7161b…` |
| `internal-packages/schedule-engine` | `@internal/schedule-engine` | no | no | no | no | owner-review-repository-referenced | no | yes | `c6e22fe59eb7f562…` |
| `internal-packages/tenancy-database` | `@platos/tenancy-database` | yes | yes | yes | yes | retain-oci-image | no | no | `c9f7dedaf33b8b1c…` |
| `internal-packages/tenancy-database/migration-image` | `@platos/tenancy-migration-image` | yes | no | yes | yes | retain-oci-image | no | no | `f63a66d17bb21fb6…` |
| `internal-packages/testcontainers` | `@internal/testcontainers` | no | no | no | yes | owner-review-repository-referenced | no | yes | `60a0680abd8027bd…` |
| `internal-packages/tracing` | `@internal/tracing` | no | no | no | no | owner-review-repository-referenced | no | yes | `e03f6256d2d15deb…` |
| `internal-packages/workload-identity` | `@internal/workload-identity` | yes | yes | yes | yes | retain-oci-image | no | no | `dadef2898f129ff1…` |
| `internal-packages/zod-worker` | `@internal/zod-worker` | no | no | no | no | owner-review-repository-referenced | no | yes | `86a5ee29b9046270…` |
| `packages/adapters/channel-slack` | `@platos/adapter-channel-slack` | no | yes | yes | no | retain-application-deployable | no | no | `a0b9b8f1997167fd…` |
| `packages/adapters/clickhouse-observability` | `@platos/adapter-clickhouse-observability` | no | yes | yes | no | retain-application-deployable | no | no | `20ffb187c8872c39…` |
| `packages/adapters/durable-runtime` | `@platos/adapter-durable-runtime` | no | yes | yes | no | retain-application-deployable | no | no | `6456f3c7fcc92bc7…` |
| `packages/adapters/model-router-providers` | `@platos/adapter-model-router-providers` | no | yes | yes | no | retain-application-deployable | no | no | `1fb15b8dc97d1495…` |
| `packages/adapters/notifier-email` | `@platos/adapter-notifier-email` | no | yes | yes | no | retain-application-deployable | no | no | `4f5a7f6e711923ec…` |
| `packages/adapters/notifier-webhook` | `@platos/adapter-notifier-webhook` | no | yes | yes | no | retain-application-deployable | no | no | `20e9eb605d7996f6…` |
| `packages/adapters/objectstore-minio` | `@platos/adapter-objectstore-minio` | no | yes | yes | no | retain-application-deployable | no | no | `68684b88628b9f4f…` |
| `packages/adapters/outbox` | `@platos/adapter-outbox` | no | yes | yes | no | retain-application-deployable | no | no | `837bebf3f7a4edc7…` |
| `packages/adapters/postgres-tenancy` | `@platos/adapter-postgres-tenancy` | no | yes | yes | no | retain-application-deployable | no | no | `696ac73f39e94019…` |
| `packages/adapters/redis-cache` | `@platos/adapter-redis-cache` | no | yes | yes | no | retain-application-deployable | no | no | `a3236cb35dc75dd8…` |
| `packages/adapters/redis-ratelimit` | `@platos/adapter-redis-ratelimit` | no | yes | yes | no | retain-application-deployable | no | no | `9747cd57f31b7784…` |
| `packages/adapters/redis-streams` | `@platos/adapter-redis-streams` | no | yes | yes | no | retain-application-deployable | no | no | `845365e798a050a4…` |
| `packages/contexts/agents` | `@platos/context-agents` | no | yes | yes | no | retain-application-deployable | no | no | `2f18d9436a2cdefd…` |
| `packages/contexts/channels` | `@platos/context-channels` | no | yes | yes | no | retain-application-deployable | no | no | `4972451b548e7869…` |
| `packages/contexts/conversations` | `@platos/context-conversations` | no | yes | yes | no | retain-application-deployable | no | no | `08ff1f5a6c7eaa48…` |
| `packages/contexts/cost-monitoring` | `@platos/context-cost-monitoring` | no | yes | yes | no | retain-application-deployable | no | no | `017cf237b296635c…` |
| `packages/contexts/eventing` | `@platos/context-eventing` | no | yes | yes | no | retain-application-deployable | no | no | `4e31045df7ac1b7e…` |
| `packages/contexts/files` | `@platos/context-files` | no | yes | yes | no | retain-application-deployable | no | no | `6283673a0b77b599…` |
| `packages/contexts/governance` | `@platos/context-governance` | no | yes | yes | no | retain-application-deployable | no | no | `14b4be1931f47f87…` |
| `packages/contexts/identity-access` | `@platos/context-identity-access` | no | yes | yes | no | retain-application-deployable | no | no | `a3139e1557ba0c48…` |
| `packages/contexts/jobs` | `@platos/context-jobs` | no | yes | yes | no | retain-application-deployable | no | no | `dfbef1a0bbb590e2…` |
| `packages/contexts/memory` | `@platos/context-memory` | no | yes | yes | no | retain-application-deployable | no | no | `ca5bdf8ecc16904a…` |
| `packages/contexts/observability` | `@platos/context-observability` | no | yes | yes | no | retain-application-deployable | no | no | `1f26324640a9eee7…` |
| `packages/contexts/privacy` | `@platos/context-privacy` | no | yes | yes | no | retain-application-deployable | no | no | `d26482cf40ae38cd…` |
| `packages/contexts/providers` | `@platos/context-providers` | no | yes | yes | no | retain-application-deployable | no | no | `afe21d96d9fbbc53…` |
| `packages/contexts/secrets` | `@platos/context-secrets` | no | yes | yes | no | retain-application-deployable | no | no | `e037b0ec3ad46e7e…` |
| `packages/contexts/skills` | `@platos/context-skills` | no | yes | yes | no | retain-application-deployable | no | no | `8f74118fd18b2385…` |
| `packages/contexts/tenancy` | `@platos/context-tenancy` | no | yes | yes | no | retain-application-deployable | no | no | `99780d3284bc2e2c…` |
| `packages/contexts/tools` | `@platos/context-tools` | no | yes | yes | no | retain-application-deployable | no | no | `af54362179ee169d…` |
| `packages/core` | `@platos/core` | no | no | no | yes | owner-review-public-boundary | yes | yes | `cff2a903852338f3…` |
| `packages/kernel` | `@platos/kernel` | no | yes | yes | no | retain-application-deployable | no | no | `2298217ae6268d76…` |
| `packages/platools-js` | `@platosdev/platools-sdk` | no | no | no | no | owner-review-public-boundary | yes | yes | `9a50f2e6623f2307…` |
| `packages/platos-client` | `@platosdev/client` | no | no | no | no | owner-review-public-boundary | yes | yes | `679ecc73148dd3de…` |
| `packages/platos-embed` | `@platosdev/embed` | no | no | no | no | owner-review-public-boundary | yes | yes | `26f83fd504a22a2c…` |
| `packages/platos-react-widget` | `@platosdev/react-widget` | no | no | no | no | owner-review-public-boundary | yes | yes | `87406163254db53e…` |
| `packages/platos-token-mint` | `@platosdev/token-mint` | no | no | no | yes | owner-review-public-boundary | yes | yes | `dcda0cfbae3f419d…` |
| `packages/react-hooks` | `@platos/react-hooks` | no | no | no | no | owner-review-public-boundary | yes | yes | `092d6043ec50ecdf…` |
| `packages/redis-worker` | `@platos/redis-worker` | no | no | no | no | owner-review-public-boundary | yes | yes | `e42019e87abb9845…` |

Exact roots, reasons, reverse paths, channel evidence, boundaries, input hashes, and full per-workspace hashes are in the JSON artifact.
