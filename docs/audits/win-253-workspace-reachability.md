# WIN-253 workspace reachability baseline

> Non-destructive evidence only. This report does not authorize deletion, quarantine, merge, or publication.

Evidence SHA-256: `0cdb706a284463f58c861e6333a256b4da0823a71745d9abf15087d0abd0d358`

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
- Generator-owned V1 baseline: **116 files / 35 projects**

The OCI closure is derived from CI-declared shipping Dockerfiles. The application/deployable closure is independently rooted by executable app manifests, root TypeScript references, and CI build entrypoints. Their union retains the V1 application graph and the separately shipped migrations workspace. Every registered workspace remains part of frozen install traversal until separately authorized workspace/lockfile changes occur.

## Independent channel counts

| Channel | Workspaces reached |
| --- | ---: |
| sourceStatic | 47 |
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
| `apps/agent` | `platos-agent` | yes | yes | yes | yes | retain-oci-image | no | no | `a0f4b662dc650a7d…` |
| `apps/core-api` | `@platos/core-api` | no | yes | yes | no | retain-application-deployable | no | no | `2aacdb3f6f1a889f…` |
| `apps/mcp-stdio` | `@platos/mcp-stdio` | no | yes | yes | no | retain-application-deployable | no | no | `8b30c26d8bf77897…` |
| `apps/webapp` | `webapp` | yes | yes | yes | yes | retain-oci-image | no | no | `b64277decd91e316…` |
| `docs` | `docs` | no | no | no | no | owner-review-repository-referenced | no | yes | `b642d139aeae4166…` |
| `internal-packages/cache` | `@internal/cache` | no | no | no | no | owner-review-repository-referenced | no | yes | `f9f2db1155272a42…` |
| `internal-packages/compute` | `@internal/compute` | no | no | no | no | owner-review-repository-referenced | no | yes | `744fd4bd20e8d379…` |
| `internal-packages/cost-rates` | `@internal/cost-rates` | no | no | no | no | owner-review-repository-referenced | no | yes | `6164efe052d457dc…` |
| `internal-packages/database` | `@platos/database` | no | no | no | yes | owner-review-repository-referenced | no | yes | `4f152234aa103ce8…` |
| `internal-packages/docs` | `@internal/docs` | yes | yes | yes | yes | retain-oci-image | no | no | `6885e85116b353ce…` |
| `internal-packages/emails` | `emails` | no | no | no | no | owner-review-repository-referenced | no | yes | `26084070c458a754…` |
| `internal-packages/llm-model-catalog` | `@internal/llm-model-catalog` | no | no | no | no | owner-review-repository-referenced | no | yes | `01ef30f9cd4ea0f7…` |
| `internal-packages/otlp-importer` | `@platos/otlp-importer` | no | no | no | no | owner-review-repository-referenced | no | yes | `a42b04fb8a8a1373…` |
| `internal-packages/redis` | `@internal/redis` | no | no | no | no | owner-review-repository-referenced | no | yes | `5187a89453717dc4…` |
| `internal-packages/run-engine` | `@internal/run-engine` | no | no | no | no | owner-review-repository-referenced | no | yes | `2d6a6357433303ba…` |
| `internal-packages/schedule-engine` | `@internal/schedule-engine` | no | no | no | no | owner-review-repository-referenced | no | yes | `c6e22fe59eb7f562…` |
| `internal-packages/tenancy-database` | `@platos/tenancy-database` | yes | yes | yes | yes | retain-oci-image | no | no | `edf5148388a7b7b3…` |
| `internal-packages/tenancy-database/migration-image` | `@platos/tenancy-migration-image` | yes | no | yes | yes | retain-oci-image | no | no | `f63a66d17bb21fb6…` |
| `internal-packages/testcontainers` | `@internal/testcontainers` | no | no | no | yes | owner-review-repository-referenced | no | yes | `86336e37c37c485a…` |
| `internal-packages/tracing` | `@internal/tracing` | no | no | no | no | owner-review-repository-referenced | no | yes | `e03f6256d2d15deb…` |
| `internal-packages/workload-identity` | `@internal/workload-identity` | yes | yes | yes | yes | retain-oci-image | no | no | `49dd4658f0cd2f3c…` |
| `internal-packages/zod-worker` | `@internal/zod-worker` | no | no | no | no | owner-review-repository-referenced | no | yes | `86a5ee29b9046270…` |
| `packages/adapters/channel-slack` | `@platos/adapter-channel-slack` | no | yes | yes | no | retain-application-deployable | no | no | `9ec4ff3c4e19b895…` |
| `packages/adapters/clickhouse-observability` | `@platos/adapter-clickhouse-observability` | no | yes | yes | no | retain-application-deployable | no | no | `75742d2f2a388b35…` |
| `packages/adapters/durable-runtime` | `@platos/adapter-durable-runtime` | no | yes | yes | no | retain-application-deployable | no | no | `95d3808e9e99402b…` |
| `packages/adapters/keyring-envelope` | `@platos/adapter-keyring-envelope` | no | yes | yes | no | retain-application-deployable | no | no | `8265e2d48df531e1…` |
| `packages/adapters/model-router-providers` | `@platos/adapter-model-router-providers` | no | yes | yes | no | retain-application-deployable | no | no | `22dc09b524e29f8f…` |
| `packages/adapters/node-crypto-digest` | `@platos/adapter-node-crypto-digest` | no | yes | yes | no | retain-application-deployable | no | no | `843bb6b9669570f6…` |
| `packages/adapters/notifier-email` | `@platos/adapter-notifier-email` | no | yes | yes | no | retain-application-deployable | no | no | `99eab195b91415ea…` |
| `packages/adapters/notifier-webhook` | `@platos/adapter-notifier-webhook` | no | yes | yes | no | retain-application-deployable | no | no | `3504230bb64c2b66…` |
| `packages/adapters/objectstore-minio` | `@platos/adapter-objectstore-minio` | no | yes | yes | no | retain-application-deployable | no | no | `c6a5ad9937a90a43…` |
| `packages/adapters/outbox` | `@platos/adapter-outbox` | no | yes | yes | no | retain-application-deployable | no | no | `39829ec6bff855de…` |
| `packages/adapters/postgres-tenancy` | `@platos/adapter-postgres-tenancy` | no | yes | yes | no | retain-application-deployable | no | no | `1736ea31661a9002…` |
| `packages/adapters/redis-cache` | `@platos/adapter-redis-cache` | no | yes | yes | no | retain-application-deployable | no | no | `4363dee379642829…` |
| `packages/adapters/redis-ratelimit` | `@platos/adapter-redis-ratelimit` | no | yes | yes | no | retain-application-deployable | no | no | `c92573ee1971194e…` |
| `packages/adapters/redis-streams` | `@platos/adapter-redis-streams` | no | yes | yes | no | retain-application-deployable | no | no | `3849a945090ccada…` |
| `packages/adapters/tokenmint-totp` | `@platos/adapter-tokenmint-totp` | no | yes | yes | no | retain-application-deployable | no | no | `b5e8626e9c85b924…` |
| `packages/contexts/agents` | `@platos/context-agents` | no | yes | yes | no | retain-application-deployable | no | no | `46d0ab2e91701d26…` |
| `packages/contexts/channels` | `@platos/context-channels` | no | yes | yes | no | retain-application-deployable | no | no | `9ab6a43e5a7103d4…` |
| `packages/contexts/conversations` | `@platos/context-conversations` | no | yes | yes | no | retain-application-deployable | no | no | `8dbbb11130a2c510…` |
| `packages/contexts/cost-monitoring` | `@platos/context-cost-monitoring` | no | yes | yes | no | retain-application-deployable | no | no | `a43e2491b13badf7…` |
| `packages/contexts/eventing` | `@platos/context-eventing` | no | yes | yes | no | retain-application-deployable | no | no | `232af18c833f1dc2…` |
| `packages/contexts/files` | `@platos/context-files` | no | yes | yes | no | retain-application-deployable | no | no | `a58d80193f6e02e0…` |
| `packages/contexts/governance` | `@platos/context-governance` | no | yes | yes | no | retain-application-deployable | no | no | `d67942ed01a7ed2a…` |
| `packages/contexts/identity-access` | `@platos/context-identity-access` | no | yes | yes | no | retain-application-deployable | no | no | `779e5f5622b21c2e…` |
| `packages/contexts/jobs` | `@platos/context-jobs` | no | yes | yes | no | retain-application-deployable | no | no | `6c08c78fe958496f…` |
| `packages/contexts/memory` | `@platos/context-memory` | no | yes | yes | no | retain-application-deployable | no | no | `270ce6c3b51a4bb9…` |
| `packages/contexts/observability` | `@platos/context-observability` | no | yes | yes | no | retain-application-deployable | no | no | `9ce6352bdf89f325…` |
| `packages/contexts/privacy` | `@platos/context-privacy` | no | yes | yes | no | retain-application-deployable | no | no | `ff791ba79681c28b…` |
| `packages/contexts/providers` | `@platos/context-providers` | no | yes | yes | no | retain-application-deployable | no | no | `18b0f800688ee6ff…` |
| `packages/contexts/secrets` | `@platos/context-secrets` | no | yes | yes | no | retain-application-deployable | no | no | `5ae56ed21f54d13a…` |
| `packages/contexts/skills` | `@platos/context-skills` | no | yes | yes | no | retain-application-deployable | no | no | `221ee0e877348b1c…` |
| `packages/contexts/tenancy` | `@platos/context-tenancy` | no | yes | yes | no | retain-application-deployable | no | no | `16229b263676ce6e…` |
| `packages/contexts/tools` | `@platos/context-tools` | no | yes | yes | no | retain-application-deployable | no | no | `bc559eb8a18d9151…` |
| `packages/core` | `@platos/core` | no | no | no | yes | owner-review-public-boundary | yes | yes | `a0a1fdbed4f98f7f…` |
| `packages/kernel` | `@platos/kernel` | no | yes | yes | no | retain-application-deployable | no | no | `5d262859fe27ee46…` |
| `packages/platools-js` | `@platosdev/platools-sdk` | no | no | no | no | owner-review-public-boundary | yes | yes | `f1fa3ad918389600…` |
| `packages/platos-client` | `@platosdev/client` | no | no | no | no | owner-review-public-boundary | yes | yes | `69754f5738c74c04…` |
| `packages/platos-embed` | `@platosdev/embed` | no | no | no | no | owner-review-public-boundary | yes | yes | `8aaf3861f7505a24…` |
| `packages/platos-react-widget` | `@platosdev/react-widget` | no | no | no | no | owner-review-public-boundary | yes | yes | `6f809f18d00204d7…` |
| `packages/platos-token-mint` | `@platosdev/token-mint` | no | no | no | yes | owner-review-public-boundary | yes | yes | `24274bd408ec98d9…` |
| `packages/react-hooks` | `@platos/react-hooks` | no | no | no | no | owner-review-public-boundary | yes | yes | `092d6043ec50ecdf…` |
| `packages/redis-worker` | `@platos/redis-worker` | no | no | no | no | owner-review-public-boundary | yes | yes | `e42019e87abb9845…` |

Exact roots, reasons, reverse paths, channel evidence, boundaries, input hashes, and full per-workspace hashes are in the JSON artifact.
