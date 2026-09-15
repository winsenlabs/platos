# WIN-253 workspace reachability baseline

> Non-destructive evidence only. This report does not authorize deletion, quarantine, merge, or publication.

Evidence SHA-256: `f02ed6be252cc323851fc50d35abb83c92ea96b4ee695e478e56d9e7b72b0dda`

## Baseline

- Registered workspace members: **63**
- Current OCI image workspace closure: **40**
- Application/deployable workspace closure: **40**
- Application plus migrations union: **41**
- OCI-root + devDependency closure: **44**
- Frozen-install registration traversal: **63**
- Review candidates (not deletion authorization): **22**
- External/public package boundaries: **8**
- Configured patch reconciliation: **5/5** concrete lock snapshots
- Existing SBOM snapshot-node baselines: **agent 718**, **webapp 335**, **core-api 329**
- Generator-owned V1 baseline: **116 files / 35 projects**

The OCI closure is derived from CI-declared shipping Dockerfiles. The application/deployable closure is independently rooted by executable app manifests, root TypeScript references, and CI build entrypoints. Their union retains the V1 application graph and the separately shipped migrations workspace. Every registered workspace remains part of frozen install traversal until separately authorized workspace/lockfile changes occur.

## Independent channel counts

| Channel | Workspaces reached |
| --- | ---: |
| sourceStatic | 47 |
| sourceDynamic | 2 |
| packageScripts | 63 |
| ci | 63 |
| dockerImage | 8 |
| testsFixtures | 59 |
| docsExamples | 60 |
| generated | 43 |
| license | 49 |
| patches | 17 |

## Per-workspace classification

| Workspace | Package | OCI | App/deployable | Union | OCI+dev | Candidate status | Public boundary | Owner decision | Evidence hash |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |
| `apps/agent` | `platos-agent` | yes | yes | yes | yes | retain-oci-image | no | no | `e228d554ff2f6833…` |
| `apps/core-api` | `@platos/core-api` | yes | yes | yes | yes | retain-oci-image | no | no | `556ca91cff9bb82f…` |
| `apps/mcp-stdio` | `@platos/mcp-stdio` | no | yes | yes | no | retain-application-deployable | no | no | `c0799a3d6cb567b6…` |
| `apps/webapp` | `webapp` | yes | yes | yes | yes | retain-oci-image | no | no | `1040b77e30ee510b…` |
| `docs` | `docs` | no | no | no | no | owner-review-repository-referenced | no | yes | `4acbcd06f617b3f5…` |
| `internal-packages/cache` | `@internal/cache` | no | no | no | no | owner-review-repository-referenced | no | yes | `f9f2db1155272a42…` |
| `internal-packages/compute` | `@internal/compute` | no | no | no | no | owner-review-repository-referenced | no | yes | `744fd4bd20e8d379…` |
| `internal-packages/cost-rates` | `@internal/cost-rates` | no | no | no | no | owner-review-repository-referenced | no | yes | `6164efe052d457dc…` |
| `internal-packages/database` | `@platos/database` | no | no | no | yes | owner-review-repository-referenced | no | yes | `ab4565588f3c5f7b…` |
| `internal-packages/docs` | `@internal/docs` | yes | yes | yes | yes | retain-oci-image | no | no | `7f0a9d011ee43e88…` |
| `internal-packages/emails` | `emails` | no | no | no | no | owner-review-repository-referenced | no | yes | `26084070c458a754…` |
| `internal-packages/llm-model-catalog` | `@internal/llm-model-catalog` | no | no | no | no | owner-review-repository-referenced | no | yes | `01ef30f9cd4ea0f7…` |
| `internal-packages/otlp-importer` | `@platos/otlp-importer` | no | no | no | no | owner-review-repository-referenced | no | yes | `311b16aa4a2f38e9…` |
| `internal-packages/redis` | `@internal/redis` | no | no | no | no | owner-review-repository-referenced | no | yes | `12737f67c1128fda…` |
| `internal-packages/run-engine` | `@internal/run-engine` | no | no | no | no | owner-review-repository-referenced | no | yes | `9123d3dc91ea420f…` |
| `internal-packages/schedule-engine` | `@internal/schedule-engine` | no | no | no | no | owner-review-repository-referenced | no | yes | `c6e22fe59eb7f562…` |
| `internal-packages/tenancy-database` | `@platos/tenancy-database` | yes | yes | yes | yes | retain-oci-image | no | no | `e6a648415673e0c6…` |
| `internal-packages/tenancy-database/migration-image` | `@platos/tenancy-migration-image` | yes | no | yes | yes | retain-oci-image | no | no | `f63a66d17bb21fb6…` |
| `internal-packages/testcontainers` | `@internal/testcontainers` | no | no | no | yes | owner-review-repository-referenced | no | yes | `8dde189dde0897f1…` |
| `internal-packages/tracing` | `@internal/tracing` | no | no | no | no | owner-review-repository-referenced | no | yes | `e03f6256d2d15deb…` |
| `internal-packages/workload-identity` | `@internal/workload-identity` | yes | yes | yes | yes | retain-oci-image | no | no | `3b52d7b020344e7b…` |
| `internal-packages/zod-worker` | `@internal/zod-worker` | no | no | no | no | owner-review-repository-referenced | no | yes | `86a5ee29b9046270…` |
| `packages/adapters/channel-slack` | `@platos/adapter-channel-slack` | yes | yes | yes | yes | retain-oci-image | no | no | `c302378b52f1b8ec…` |
| `packages/adapters/clickhouse-observability` | `@platos/adapter-clickhouse-observability` | yes | yes | yes | yes | retain-oci-image | no | no | `fda9e209c1616d4c…` |
| `packages/adapters/durable-runtime` | `@platos/adapter-durable-runtime` | yes | yes | yes | yes | retain-oci-image | no | no | `59c7de112762441b…` |
| `packages/adapters/keyring-envelope` | `@platos/adapter-keyring-envelope` | yes | yes | yes | yes | retain-oci-image | no | no | `011079b977dadc56…` |
| `packages/adapters/model-router-providers` | `@platos/adapter-model-router-providers` | yes | yes | yes | yes | retain-oci-image | no | no | `534058b52dc87199…` |
| `packages/adapters/node-crypto-digest` | `@platos/adapter-node-crypto-digest` | yes | yes | yes | yes | retain-oci-image | no | no | `64e48410da54308b…` |
| `packages/adapters/notifier-email` | `@platos/adapter-notifier-email` | yes | yes | yes | yes | retain-oci-image | no | no | `396e305a788ac535…` |
| `packages/adapters/notifier-webhook` | `@platos/adapter-notifier-webhook` | yes | yes | yes | yes | retain-oci-image | no | no | `e6b47c260c4f79d4…` |
| `packages/adapters/objectstore-minio` | `@platos/adapter-objectstore-minio` | yes | yes | yes | yes | retain-oci-image | no | no | `10b7bb6241015a7c…` |
| `packages/adapters/outbox` | `@platos/adapter-outbox` | yes | yes | yes | yes | retain-oci-image | no | no | `7461f1cba2cd800d…` |
| `packages/adapters/postgres-tenancy` | `@platos/adapter-postgres-tenancy` | yes | yes | yes | yes | retain-oci-image | no | no | `373ae7800f1d6aa0…` |
| `packages/adapters/redis-cache` | `@platos/adapter-redis-cache` | yes | yes | yes | yes | retain-oci-image | no | no | `3e4bcd04afabb08e…` |
| `packages/adapters/redis-ratelimit` | `@platos/adapter-redis-ratelimit` | yes | yes | yes | yes | retain-oci-image | no | no | `ac2e052315f876a1…` |
| `packages/adapters/redis-streams` | `@platos/adapter-redis-streams` | yes | yes | yes | yes | retain-oci-image | no | no | `2ec5b30d4b7363e5…` |
| `packages/adapters/tokenmint-totp` | `@platos/adapter-tokenmint-totp` | yes | yes | yes | yes | retain-oci-image | no | no | `8cc3dd1be25603d1…` |
| `packages/contexts/agents` | `@platos/context-agents` | yes | yes | yes | yes | retain-oci-image | no | no | `3aeeb14825605670…` |
| `packages/contexts/channels` | `@platos/context-channels` | yes | yes | yes | yes | retain-oci-image | no | no | `2389773295a2867a…` |
| `packages/contexts/conversations` | `@platos/context-conversations` | yes | yes | yes | yes | retain-oci-image | no | no | `e21819c7974d5c2f…` |
| `packages/contexts/cost-monitoring` | `@platos/context-cost-monitoring` | yes | yes | yes | yes | retain-oci-image | no | no | `55271308215f33ee…` |
| `packages/contexts/eventing` | `@platos/context-eventing` | yes | yes | yes | yes | retain-oci-image | no | no | `9641ac167d57c082…` |
| `packages/contexts/files` | `@platos/context-files` | yes | yes | yes | yes | retain-oci-image | no | no | `2e2d0aaf233bd9f1…` |
| `packages/contexts/governance` | `@platos/context-governance` | yes | yes | yes | yes | retain-oci-image | no | no | `8a4b27d9220f7398…` |
| `packages/contexts/identity-access` | `@platos/context-identity-access` | yes | yes | yes | yes | retain-oci-image | no | no | `3c21772be7bcad8c…` |
| `packages/contexts/jobs` | `@platos/context-jobs` | yes | yes | yes | yes | retain-oci-image | no | no | `80af2d31b88b1ddd…` |
| `packages/contexts/memory` | `@platos/context-memory` | yes | yes | yes | yes | retain-oci-image | no | no | `fdfb8a4715bfcb84…` |
| `packages/contexts/observability` | `@platos/context-observability` | yes | yes | yes | yes | retain-oci-image | no | no | `a0774824daa2a4c0…` |
| `packages/contexts/privacy` | `@platos/context-privacy` | yes | yes | yes | yes | retain-oci-image | no | no | `3e535281fb339d07…` |
| `packages/contexts/providers` | `@platos/context-providers` | yes | yes | yes | yes | retain-oci-image | no | no | `184e03ada313d884…` |
| `packages/contexts/secrets` | `@platos/context-secrets` | yes | yes | yes | yes | retain-oci-image | no | no | `16f3132b29677ab6…` |
| `packages/contexts/skills` | `@platos/context-skills` | yes | yes | yes | yes | retain-oci-image | no | no | `60a8b6546a6d552b…` |
| `packages/contexts/tenancy` | `@platos/context-tenancy` | yes | yes | yes | yes | retain-oci-image | no | no | `ed00ebf899ed566a…` |
| `packages/contexts/tools` | `@platos/context-tools` | yes | yes | yes | yes | retain-oci-image | no | no | `8cb508482ea9e1ef…` |
| `packages/core` | `@platos/core` | no | no | no | yes | owner-review-public-boundary | yes | yes | `38a8dd882327d119…` |
| `packages/kernel` | `@platos/kernel` | yes | yes | yes | yes | retain-oci-image | no | no | `947ccb8296a1fb18…` |
| `packages/platools-js` | `@platosdev/platools-sdk` | no | no | no | no | owner-review-public-boundary | yes | yes | `3060cecf558dc828…` |
| `packages/platos-client` | `@platosdev/client` | no | no | no | no | owner-review-public-boundary | yes | yes | `64be23b41f6d0503…` |
| `packages/platos-embed` | `@platosdev/embed` | no | no | no | no | owner-review-public-boundary | yes | yes | `47a367830c48c8f8…` |
| `packages/platos-react-widget` | `@platosdev/react-widget` | no | no | no | no | owner-review-public-boundary | yes | yes | `0cfd59f1501bd5cd…` |
| `packages/platos-token-mint` | `@platosdev/token-mint` | no | no | no | yes | owner-review-public-boundary | yes | yes | `5840540b012dd00d…` |
| `packages/react-hooks` | `@platos/react-hooks` | no | no | no | no | owner-review-public-boundary | yes | yes | `e7d6b6269f0582f5…` |
| `packages/redis-worker` | `@platos/redis-worker` | no | no | no | no | owner-review-public-boundary | yes | yes | `63eea109cbc580bd…` |

Exact roots, reasons, reverse paths, channel evidence, boundaries, input hashes, and full per-workspace hashes are in the JSON artifact.
