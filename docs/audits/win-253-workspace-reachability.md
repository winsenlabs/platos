# WIN-253 workspace reachability baseline

> Non-destructive evidence only. This report does not authorize deletion, quarantine, merge, or publication.

Evidence SHA-256: `9ff023df491913d4750db6a1888c6c46fc8a4e6acd23240e3b4b6fa0592137de`

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
| `apps/core-api` | `@platos/core-api` | no | yes | yes | no | retain-application-deployable | no | no | `9d6337c4b4ad7e11…` |
| `apps/mcp-stdio` | `@platos/mcp-stdio` | no | yes | yes | no | retain-application-deployable | no | no | `b5e7da5fe2c41f1b…` |
| `apps/webapp` | `webapp` | yes | yes | yes | yes | retain-oci-image | no | no | `5847c575da7b72b6…` |
| `docs` | `docs` | no | no | no | no | owner-review-repository-referenced | no | yes | `7eddbbd1afff317a…` |
| `internal-packages/cache` | `@internal/cache` | no | no | no | no | owner-review-repository-referenced | no | yes | `f9f2db1155272a42…` |
| `internal-packages/compute` | `@internal/compute` | no | no | no | no | owner-review-repository-referenced | no | yes | `744fd4bd20e8d379…` |
| `internal-packages/cost-rates` | `@internal/cost-rates` | no | no | no | no | owner-review-repository-referenced | no | yes | `6164efe052d457dc…` |
| `internal-packages/database` | `@platos/database` | no | no | no | yes | owner-review-repository-referenced | no | yes | `d4da8313ab139673…` |
| `internal-packages/docs` | `@internal/docs` | yes | yes | yes | yes | retain-oci-image | no | no | `46bdcc86a506379d…` |
| `internal-packages/emails` | `emails` | no | no | no | no | owner-review-repository-referenced | no | yes | `26084070c458a754…` |
| `internal-packages/llm-model-catalog` | `@internal/llm-model-catalog` | no | no | no | no | owner-review-repository-referenced | no | yes | `01ef30f9cd4ea0f7…` |
| `internal-packages/otlp-importer` | `@platos/otlp-importer` | no | no | no | no | owner-review-repository-referenced | no | yes | `9bff29ccf09caa07…` |
| `internal-packages/redis` | `@internal/redis` | no | no | no | no | owner-review-repository-referenced | no | yes | `08d45dbdf86429ec…` |
| `internal-packages/run-engine` | `@internal/run-engine` | no | no | no | no | owner-review-repository-referenced | no | yes | `b25c76d5ce3d3566…` |
| `internal-packages/schedule-engine` | `@internal/schedule-engine` | no | no | no | no | owner-review-repository-referenced | no | yes | `c6e22fe59eb7f562…` |
| `internal-packages/tenancy-database` | `@platos/tenancy-database` | yes | yes | yes | yes | retain-oci-image | no | no | `1abf581703e278b2…` |
| `internal-packages/tenancy-database/migration-image` | `@platos/tenancy-migration-image` | yes | no | yes | yes | retain-oci-image | no | no | `f63a66d17bb21fb6…` |
| `internal-packages/testcontainers` | `@internal/testcontainers` | no | no | no | yes | owner-review-repository-referenced | no | yes | `60a0680abd8027bd…` |
| `internal-packages/tracing` | `@internal/tracing` | no | no | no | no | owner-review-repository-referenced | no | yes | `e03f6256d2d15deb…` |
| `internal-packages/workload-identity` | `@internal/workload-identity` | yes | yes | yes | yes | retain-oci-image | no | no | `dadef2898f129ff1…` |
| `internal-packages/zod-worker` | `@internal/zod-worker` | no | no | no | no | owner-review-repository-referenced | no | yes | `86a5ee29b9046270…` |
| `packages/adapters/channel-slack` | `@platos/adapter-channel-slack` | no | yes | yes | no | retain-application-deployable | no | no | `75c594b578931cac…` |
| `packages/adapters/clickhouse-observability` | `@platos/adapter-clickhouse-observability` | no | yes | yes | no | retain-application-deployable | no | no | `289f10fbc24ca8a7…` |
| `packages/adapters/durable-runtime` | `@platos/adapter-durable-runtime` | no | yes | yes | no | retain-application-deployable | no | no | `91c3ecef61058422…` |
| `packages/adapters/model-router-providers` | `@platos/adapter-model-router-providers` | no | yes | yes | no | retain-application-deployable | no | no | `d68743db97b3df39…` |
| `packages/adapters/notifier-email` | `@platos/adapter-notifier-email` | no | yes | yes | no | retain-application-deployable | no | no | `06ec4341e8fb5c66…` |
| `packages/adapters/notifier-webhook` | `@platos/adapter-notifier-webhook` | no | yes | yes | no | retain-application-deployable | no | no | `4f76e67432e576cd…` |
| `packages/adapters/objectstore-minio` | `@platos/adapter-objectstore-minio` | no | yes | yes | no | retain-application-deployable | no | no | `32f896194b842cb9…` |
| `packages/adapters/outbox` | `@platos/adapter-outbox` | no | yes | yes | no | retain-application-deployable | no | no | `b9fa66a30e42eb15…` |
| `packages/adapters/postgres-tenancy` | `@platos/adapter-postgres-tenancy` | no | yes | yes | no | retain-application-deployable | no | no | `2c50e88940417402…` |
| `packages/adapters/redis-cache` | `@platos/adapter-redis-cache` | no | yes | yes | no | retain-application-deployable | no | no | `9818b75497f2a932…` |
| `packages/adapters/redis-ratelimit` | `@platos/adapter-redis-ratelimit` | no | yes | yes | no | retain-application-deployable | no | no | `8476df6291aa73b4…` |
| `packages/adapters/redis-streams` | `@platos/adapter-redis-streams` | no | yes | yes | no | retain-application-deployable | no | no | `11b3e69bb57a74b0…` |
| `packages/contexts/agents` | `@platos/context-agents` | no | yes | yes | no | retain-application-deployable | no | no | `546aad3bbc07852a…` |
| `packages/contexts/channels` | `@platos/context-channels` | no | yes | yes | no | retain-application-deployable | no | no | `72efebb9f00821fc…` |
| `packages/contexts/conversations` | `@platos/context-conversations` | no | yes | yes | no | retain-application-deployable | no | no | `23e5a1ee5438b1fd…` |
| `packages/contexts/cost-monitoring` | `@platos/context-cost-monitoring` | no | yes | yes | no | retain-application-deployable | no | no | `251e5fda7301430c…` |
| `packages/contexts/eventing` | `@platos/context-eventing` | no | yes | yes | no | retain-application-deployable | no | no | `1fd15b3c36094b08…` |
| `packages/contexts/files` | `@platos/context-files` | no | yes | yes | no | retain-application-deployable | no | no | `aec878e051abb6b2…` |
| `packages/contexts/governance` | `@platos/context-governance` | no | yes | yes | no | retain-application-deployable | no | no | `e6c3fc275fdd01ec…` |
| `packages/contexts/identity-access` | `@platos/context-identity-access` | no | yes | yes | no | retain-application-deployable | no | no | `3e1f0b4f5e2dea5f…` |
| `packages/contexts/jobs` | `@platos/context-jobs` | no | yes | yes | no | retain-application-deployable | no | no | `dfbef1a0bbb590e2…` |
| `packages/contexts/memory` | `@platos/context-memory` | no | yes | yes | no | retain-application-deployable | no | no | `6e37c60eb45c68d7…` |
| `packages/contexts/observability` | `@platos/context-observability` | no | yes | yes | no | retain-application-deployable | no | no | `88a6d7166a95ad20…` |
| `packages/contexts/privacy` | `@platos/context-privacy` | no | yes | yes | no | retain-application-deployable | no | no | `0b36a9ed38ac6e77…` |
| `packages/contexts/providers` | `@platos/context-providers` | no | yes | yes | no | retain-application-deployable | no | no | `59e5f4c6e54a1bb5…` |
| `packages/contexts/secrets` | `@platos/context-secrets` | no | yes | yes | no | retain-application-deployable | no | no | `a78d0fa40992c11f…` |
| `packages/contexts/skills` | `@platos/context-skills` | no | yes | yes | no | retain-application-deployable | no | no | `653109e0b890ac2c…` |
| `packages/contexts/tenancy` | `@platos/context-tenancy` | no | yes | yes | no | retain-application-deployable | no | no | `c0228b63f44d5627…` |
| `packages/contexts/tools` | `@platos/context-tools` | no | yes | yes | no | retain-application-deployable | no | no | `09c3dc7d1a8ed1d6…` |
| `packages/core` | `@platos/core` | no | no | no | yes | owner-review-public-boundary | yes | yes | `cff2a903852338f3…` |
| `packages/kernel` | `@platos/kernel` | no | yes | yes | no | retain-application-deployable | no | no | `cbd20b827a5d493c…` |
| `packages/platools-js` | `@platosdev/platools-sdk` | no | no | no | no | owner-review-public-boundary | yes | yes | `9a50f2e6623f2307…` |
| `packages/platos-client` | `@platosdev/client` | no | no | no | no | owner-review-public-boundary | yes | yes | `679ecc73148dd3de…` |
| `packages/platos-embed` | `@platosdev/embed` | no | no | no | no | owner-review-public-boundary | yes | yes | `26f83fd504a22a2c…` |
| `packages/platos-react-widget` | `@platosdev/react-widget` | no | no | no | no | owner-review-public-boundary | yes | yes | `87406163254db53e…` |
| `packages/platos-token-mint` | `@platosdev/token-mint` | no | no | no | yes | owner-review-public-boundary | yes | yes | `dcda0cfbae3f419d…` |
| `packages/react-hooks` | `@platos/react-hooks` | no | no | no | no | owner-review-public-boundary | yes | yes | `092d6043ec50ecdf…` |
| `packages/redis-worker` | `@platos/redis-worker` | no | no | no | no | owner-review-public-boundary | yes | yes | `e42019e87abb9845…` |

Exact roots, reasons, reverse paths, channel evidence, boundaries, input hashes, and full per-workspace hashes are in the JSON artifact.
