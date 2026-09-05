# WIN-253 workspace reachability baseline

> Non-destructive evidence only. This report does not authorize deletion, quarantine, merge, or publication.

Evidence SHA-256: `6b6fe92c3d4009ad7c318cee3f35391f80e1973d98876c05c96c1ef0bd2e5a6d`

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
| sourceDynamic | 1 |
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
| `apps/core-api` | `@platos/core-api` | no | yes | yes | no | retain-application-deployable | no | no | `a9f9851f38016198…` |
| `apps/mcp-stdio` | `@platos/mcp-stdio` | no | yes | yes | no | retain-application-deployable | no | no | `50075bc7a7b9ff3f…` |
| `apps/webapp` | `webapp` | yes | yes | yes | yes | retain-oci-image | no | no | `515228d74cf753c9…` |
| `docs` | `docs` | no | no | no | no | owner-review-repository-referenced | no | yes | `7eddbbd1afff317a…` |
| `internal-packages/cache` | `@internal/cache` | no | no | no | no | owner-review-repository-referenced | no | yes | `f9f2db1155272a42…` |
| `internal-packages/compute` | `@internal/compute` | no | no | no | no | owner-review-repository-referenced | no | yes | `744fd4bd20e8d379…` |
| `internal-packages/cost-rates` | `@internal/cost-rates` | no | no | no | no | owner-review-repository-referenced | no | yes | `6164efe052d457dc…` |
| `internal-packages/database` | `@platos/database` | no | no | no | yes | owner-review-repository-referenced | no | yes | `d4da8313ab139673…` |
| `internal-packages/docs` | `@internal/docs` | yes | yes | yes | yes | retain-oci-image | no | no | `46bdcc86a506379d…` |
| `internal-packages/emails` | `emails` | no | no | no | no | owner-review-repository-referenced | no | yes | `26084070c458a754…` |
| `internal-packages/llm-model-catalog` | `@internal/llm-model-catalog` | no | no | no | no | owner-review-repository-referenced | no | yes | `01ef30f9cd4ea0f7…` |
| `internal-packages/otlp-importer` | `@platos/otlp-importer` | no | no | no | no | owner-review-repository-referenced | no | yes | `21e67e6f9b0975b8…` |
| `internal-packages/redis` | `@internal/redis` | no | no | no | no | owner-review-repository-referenced | no | yes | `08d45dbdf86429ec…` |
| `internal-packages/run-engine` | `@internal/run-engine` | no | no | no | no | owner-review-repository-referenced | no | yes | `9e26034b6059d755…` |
| `internal-packages/schedule-engine` | `@internal/schedule-engine` | no | no | no | no | owner-review-repository-referenced | no | yes | `c6e22fe59eb7f562…` |
| `internal-packages/tenancy-database` | `@platos/tenancy-database` | yes | yes | yes | yes | retain-oci-image | no | no | `ae8d91e862a3fe62…` |
| `internal-packages/tenancy-database/migration-image` | `@platos/tenancy-migration-image` | yes | no | yes | yes | retain-oci-image | no | no | `f63a66d17bb21fb6…` |
| `internal-packages/testcontainers` | `@internal/testcontainers` | no | no | no | yes | owner-review-repository-referenced | no | yes | `60a0680abd8027bd…` |
| `internal-packages/tracing` | `@internal/tracing` | no | no | no | no | owner-review-repository-referenced | no | yes | `e03f6256d2d15deb…` |
| `internal-packages/workload-identity` | `@internal/workload-identity` | yes | yes | yes | yes | retain-oci-image | no | no | `dadef2898f129ff1…` |
| `internal-packages/zod-worker` | `@internal/zod-worker` | no | no | no | no | owner-review-repository-referenced | no | yes | `86a5ee29b9046270…` |
| `packages/adapters/channel-slack` | `@platos/adapter-channel-slack` | no | yes | yes | no | retain-application-deployable | no | no | `f988f539443821b9…` |
| `packages/adapters/clickhouse-observability` | `@platos/adapter-clickhouse-observability` | no | yes | yes | no | retain-application-deployable | no | no | `4f32630460f9fb13…` |
| `packages/adapters/durable-runtime` | `@platos/adapter-durable-runtime` | no | yes | yes | no | retain-application-deployable | no | no | `da14665d55595932…` |
| `packages/adapters/model-router-providers` | `@platos/adapter-model-router-providers` | no | yes | yes | no | retain-application-deployable | no | no | `8720a44cacb8d8f3…` |
| `packages/adapters/notifier-email` | `@platos/adapter-notifier-email` | no | yes | yes | no | retain-application-deployable | no | no | `3e36d115fe2be2d9…` |
| `packages/adapters/notifier-webhook` | `@platos/adapter-notifier-webhook` | no | yes | yes | no | retain-application-deployable | no | no | `dc317253b570666a…` |
| `packages/adapters/objectstore-minio` | `@platos/adapter-objectstore-minio` | no | yes | yes | no | retain-application-deployable | no | no | `f577347a693015f2…` |
| `packages/adapters/outbox` | `@platos/adapter-outbox` | no | yes | yes | no | retain-application-deployable | no | no | `98074c4982742ec2…` |
| `packages/adapters/postgres-tenancy` | `@platos/adapter-postgres-tenancy` | no | yes | yes | no | retain-application-deployable | no | no | `21a95513e8bcfc22…` |
| `packages/adapters/redis-cache` | `@platos/adapter-redis-cache` | no | yes | yes | no | retain-application-deployable | no | no | `ca294643df908748…` |
| `packages/adapters/redis-ratelimit` | `@platos/adapter-redis-ratelimit` | no | yes | yes | no | retain-application-deployable | no | no | `e530b27e27ba4450…` |
| `packages/adapters/redis-streams` | `@platos/adapter-redis-streams` | no | yes | yes | no | retain-application-deployable | no | no | `046e169fb8c1a817…` |
| `packages/contexts/agents` | `@platos/context-agents` | no | yes | yes | no | retain-application-deployable | no | no | `b21d2ba3f2bb918b…` |
| `packages/contexts/channels` | `@platos/context-channels` | no | yes | yes | no | retain-application-deployable | no | no | `683403fe106bf24b…` |
| `packages/contexts/conversations` | `@platos/context-conversations` | no | yes | yes | no | retain-application-deployable | no | no | `75387f07a4631e61…` |
| `packages/contexts/cost-monitoring` | `@platos/context-cost-monitoring` | no | yes | yes | no | retain-application-deployable | no | no | `8d52e3ce84c96729…` |
| `packages/contexts/eventing` | `@platos/context-eventing` | no | yes | yes | no | retain-application-deployable | no | no | `b6077824b2fd0a31…` |
| `packages/contexts/files` | `@platos/context-files` | no | yes | yes | no | retain-application-deployable | no | no | `7a207abf3b46bc0e…` |
| `packages/contexts/governance` | `@platos/context-governance` | no | yes | yes | no | retain-application-deployable | no | no | `572bcd0a2da60bf5…` |
| `packages/contexts/identity-access` | `@platos/context-identity-access` | no | yes | yes | no | retain-application-deployable | no | no | `49d6726c5262b8bf…` |
| `packages/contexts/jobs` | `@platos/context-jobs` | no | yes | yes | no | retain-application-deployable | no | no | `2caa823f3abb5721…` |
| `packages/contexts/memory` | `@platos/context-memory` | no | yes | yes | no | retain-application-deployable | no | no | `3f878680f0c128e4…` |
| `packages/contexts/observability` | `@platos/context-observability` | no | yes | yes | no | retain-application-deployable | no | no | `2d94b8415579d3e5…` |
| `packages/contexts/privacy` | `@platos/context-privacy` | no | yes | yes | no | retain-application-deployable | no | no | `cc4f074a0ef476da…` |
| `packages/contexts/providers` | `@platos/context-providers` | no | yes | yes | no | retain-application-deployable | no | no | `1cc99bf745fc5329…` |
| `packages/contexts/secrets` | `@platos/context-secrets` | no | yes | yes | no | retain-application-deployable | no | no | `7ba4f39eeb03877f…` |
| `packages/contexts/skills` | `@platos/context-skills` | no | yes | yes | no | retain-application-deployable | no | no | `a978f74a124afd7d…` |
| `packages/contexts/tenancy` | `@platos/context-tenancy` | no | yes | yes | no | retain-application-deployable | no | no | `bea424f2cf277262…` |
| `packages/contexts/tools` | `@platos/context-tools` | no | yes | yes | no | retain-application-deployable | no | no | `50065374a36bd8b7…` |
| `packages/core` | `@platos/core` | no | no | no | yes | owner-review-public-boundary | yes | yes | `cff2a903852338f3…` |
| `packages/kernel` | `@platos/kernel` | no | yes | yes | no | retain-application-deployable | no | no | `3214820823c7a93b…` |
| `packages/platools-js` | `@platosdev/platools-sdk` | no | no | no | no | owner-review-public-boundary | yes | yes | `9a50f2e6623f2307…` |
| `packages/platos-client` | `@platosdev/client` | no | no | no | no | owner-review-public-boundary | yes | yes | `679ecc73148dd3de…` |
| `packages/platos-embed` | `@platosdev/embed` | no | no | no | no | owner-review-public-boundary | yes | yes | `26f83fd504a22a2c…` |
| `packages/platos-react-widget` | `@platosdev/react-widget` | no | no | no | no | owner-review-public-boundary | yes | yes | `87406163254db53e…` |
| `packages/platos-token-mint` | `@platosdev/token-mint` | no | no | no | yes | owner-review-public-boundary | yes | yes | `dcda0cfbae3f419d…` |
| `packages/react-hooks` | `@platos/react-hooks` | no | no | no | no | owner-review-public-boundary | yes | yes | `092d6043ec50ecdf…` |
| `packages/redis-worker` | `@platos/redis-worker` | no | no | no | no | owner-review-public-boundary | yes | yes | `e42019e87abb9845…` |

Exact roots, reasons, reverse paths, channel evidence, boundaries, input hashes, and full per-workspace hashes are in the JSON artifact.
