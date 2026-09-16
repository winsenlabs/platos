# WIN-253 workspace reachability baseline

> Non-destructive evidence only. This report does not authorize deletion, quarantine, merge, or publication.

Evidence SHA-256: `632ef4d913331b5b68a02fe8e6af79926ce2c8f0846c2293ec820cbdf20fcb92`

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
| `apps/agent` | `platos-agent` | yes | yes | yes | yes | retain-oci-image | no | no | `e38dbe73b4431a91…` |
| `apps/core-api` | `@platos/core-api` | yes | yes | yes | yes | retain-oci-image | no | no | `9bf793fe7742ad5a…` |
| `apps/mcp-stdio` | `@platos/mcp-stdio` | no | yes | yes | no | retain-application-deployable | no | no | `e72404f08531aa20…` |
| `apps/webapp` | `webapp` | yes | yes | yes | yes | retain-oci-image | no | no | `68123fe3ceed6f00…` |
| `docs` | `docs` | no | no | no | no | owner-review-repository-referenced | no | yes | `1cfd0877324280a2…` |
| `internal-packages/cache` | `@internal/cache` | no | no | no | no | owner-review-repository-referenced | no | yes | `f9f2db1155272a42…` |
| `internal-packages/compute` | `@internal/compute` | no | no | no | no | owner-review-repository-referenced | no | yes | `744fd4bd20e8d379…` |
| `internal-packages/cost-rates` | `@internal/cost-rates` | no | no | no | no | owner-review-repository-referenced | no | yes | `6164efe052d457dc…` |
| `internal-packages/database` | `@platos/database` | no | no | no | yes | owner-review-repository-referenced | no | yes | `eb585daaa786095c…` |
| `internal-packages/docs` | `@internal/docs` | yes | yes | yes | yes | retain-oci-image | no | no | `19cf817a5ad68c24…` |
| `internal-packages/emails` | `emails` | no | no | no | no | owner-review-repository-referenced | no | yes | `d70cdae4f2453d04…` |
| `internal-packages/llm-model-catalog` | `@internal/llm-model-catalog` | no | no | no | no | owner-review-repository-referenced | no | yes | `01ef30f9cd4ea0f7…` |
| `internal-packages/otlp-importer` | `@platos/otlp-importer` | no | no | no | no | owner-review-repository-referenced | no | yes | `0f8ba62fd936c535…` |
| `internal-packages/redis` | `@internal/redis` | no | no | no | no | owner-review-repository-referenced | no | yes | `aacf6f6e72da1bed…` |
| `internal-packages/run-engine` | `@internal/run-engine` | no | no | no | no | owner-review-repository-referenced | no | yes | `c957a9fd543a701b…` |
| `internal-packages/schedule-engine` | `@internal/schedule-engine` | no | no | no | no | owner-review-repository-referenced | no | yes | `c6e22fe59eb7f562…` |
| `internal-packages/tenancy-database` | `@platos/tenancy-database` | yes | yes | yes | yes | retain-oci-image | no | no | `75846fdb04d0fe0f…` |
| `internal-packages/tenancy-database/migration-image` | `@platos/tenancy-migration-image` | yes | no | yes | yes | retain-oci-image | no | no | `f63a66d17bb21fb6…` |
| `internal-packages/testcontainers` | `@internal/testcontainers` | no | no | no | yes | owner-review-repository-referenced | no | yes | `1aba54594dcdd5fb…` |
| `internal-packages/tracing` | `@internal/tracing` | no | no | no | no | owner-review-repository-referenced | no | yes | `e03f6256d2d15deb…` |
| `internal-packages/workload-identity` | `@internal/workload-identity` | yes | yes | yes | yes | retain-oci-image | no | no | `aa71d9e74d2487ac…` |
| `internal-packages/zod-worker` | `@internal/zod-worker` | no | no | no | no | owner-review-repository-referenced | no | yes | `86a5ee29b9046270…` |
| `packages/adapters/channel-discord` | `@platos/adapter-channel-discord` | yes | yes | yes | yes | retain-oci-image | no | no | `b1c2188e3b407cdf…` |
| `packages/adapters/channel-slack` | `@platos/adapter-channel-slack` | yes | yes | yes | yes | retain-oci-image | no | no | `87671759fb12b742…` |
| `packages/adapters/clickhouse-observability` | `@platos/adapter-clickhouse-observability` | yes | yes | yes | yes | retain-oci-image | no | no | `f857fc2d44513e64…` |
| `packages/adapters/durable-runtime` | `@platos/adapter-durable-runtime` | yes | yes | yes | yes | retain-oci-image | no | no | `31623b67273d0751…` |
| `packages/adapters/keyring-envelope` | `@platos/adapter-keyring-envelope` | yes | yes | yes | yes | retain-oci-image | no | no | `3fd4146d8b13dccb…` |
| `packages/adapters/model-router-providers` | `@platos/adapter-model-router-providers` | yes | yes | yes | yes | retain-oci-image | no | no | `7991c78611e120d5…` |
| `packages/adapters/node-crypto-digest` | `@platos/adapter-node-crypto-digest` | yes | yes | yes | yes | retain-oci-image | no | no | `4e5f82d4f56a436e…` |
| `packages/adapters/notifier-email` | `@platos/adapter-notifier-email` | yes | yes | yes | yes | retain-oci-image | no | no | `1dd80592a6cb9be0…` |
| `packages/adapters/notifier-webhook` | `@platos/adapter-notifier-webhook` | yes | yes | yes | yes | retain-oci-image | no | no | `d8de636b737b014d…` |
| `packages/adapters/objectstore-minio` | `@platos/adapter-objectstore-minio` | yes | yes | yes | yes | retain-oci-image | no | no | `d50f4f1de0309c55…` |
| `packages/adapters/outbox` | `@platos/adapter-outbox` | yes | yes | yes | yes | retain-oci-image | no | no | `fd0b2025375b36f2…` |
| `packages/adapters/postgres-tenancy` | `@platos/adapter-postgres-tenancy` | yes | yes | yes | yes | retain-oci-image | no | no | `1bc817cf20beefae…` |
| `packages/adapters/redis-cache` | `@platos/adapter-redis-cache` | yes | yes | yes | yes | retain-oci-image | no | no | `1728467f7af652e4…` |
| `packages/adapters/redis-ratelimit` | `@platos/adapter-redis-ratelimit` | yes | yes | yes | yes | retain-oci-image | no | no | `ba286d32df7e3ba1…` |
| `packages/adapters/redis-streams` | `@platos/adapter-redis-streams` | yes | yes | yes | yes | retain-oci-image | no | no | `e0cd73300f90f1ec…` |
| `packages/adapters/tokenmint-totp` | `@platos/adapter-tokenmint-totp` | yes | yes | yes | yes | retain-oci-image | no | no | `7021378df2aed620…` |
| `packages/contexts/agents` | `@platos/context-agents` | yes | yes | yes | yes | retain-oci-image | no | no | `e30c454171c1219d…` |
| `packages/contexts/channels` | `@platos/context-channels` | yes | yes | yes | yes | retain-oci-image | no | no | `c86d8630b1528a42…` |
| `packages/contexts/conversations` | `@platos/context-conversations` | yes | yes | yes | yes | retain-oci-image | no | no | `a14564396d574559…` |
| `packages/contexts/cost-monitoring` | `@platos/context-cost-monitoring` | yes | yes | yes | yes | retain-oci-image | no | no | `ed1dd64dc6c6fcd1…` |
| `packages/contexts/eventing` | `@platos/context-eventing` | yes | yes | yes | yes | retain-oci-image | no | no | `7f8a27c909e29020…` |
| `packages/contexts/files` | `@platos/context-files` | yes | yes | yes | yes | retain-oci-image | no | no | `4d7928487e3ac103…` |
| `packages/contexts/governance` | `@platos/context-governance` | yes | yes | yes | yes | retain-oci-image | no | no | `1d82296e614a01b2…` |
| `packages/contexts/identity-access` | `@platos/context-identity-access` | yes | yes | yes | yes | retain-oci-image | no | no | `ba6b671ea773ef26…` |
| `packages/contexts/jobs` | `@platos/context-jobs` | yes | yes | yes | yes | retain-oci-image | no | no | `5192152e0a1a1447…` |
| `packages/contexts/memory` | `@platos/context-memory` | yes | yes | yes | yes | retain-oci-image | no | no | `9fa6669fcda625e4…` |
| `packages/contexts/observability` | `@platos/context-observability` | yes | yes | yes | yes | retain-oci-image | no | no | `018b39c562a7f2da…` |
| `packages/contexts/privacy` | `@platos/context-privacy` | yes | yes | yes | yes | retain-oci-image | no | no | `c37f4a196e078a46…` |
| `packages/contexts/providers` | `@platos/context-providers` | yes | yes | yes | yes | retain-oci-image | no | no | `507a2fb40e6a21bc…` |
| `packages/contexts/secrets` | `@platos/context-secrets` | yes | yes | yes | yes | retain-oci-image | no | no | `3b19a897476babbf…` |
| `packages/contexts/skills` | `@platos/context-skills` | yes | yes | yes | yes | retain-oci-image | no | no | `9e680a38e3c82570…` |
| `packages/contexts/tenancy` | `@platos/context-tenancy` | yes | yes | yes | yes | retain-oci-image | no | no | `05b15294ec2cccd9…` |
| `packages/contexts/tools` | `@platos/context-tools` | yes | yes | yes | yes | retain-oci-image | no | no | `9ceff624a6bf341b…` |
| `packages/core` | `@platos/core` | no | no | no | yes | owner-review-public-boundary | yes | yes | `4039d9fbd3cfee89…` |
| `packages/kernel` | `@platos/kernel` | yes | yes | yes | yes | retain-oci-image | no | no | `61278a87a7af9236…` |
| `packages/platools-js` | `@platosdev/platools-sdk` | no | no | no | no | owner-review-public-boundary | yes | yes | `8d962a2ae84b3811…` |
| `packages/platos-client` | `@platosdev/client` | no | no | no | no | owner-review-public-boundary | yes | yes | `8f94cd244456e27c…` |
| `packages/platos-embed` | `@platosdev/embed` | no | no | no | no | owner-review-public-boundary | yes | yes | `dbdbba2e8f86b315…` |
| `packages/platos-react-widget` | `@platosdev/react-widget` | no | no | no | no | owner-review-public-boundary | yes | yes | `213f01585b2357a7…` |
| `packages/platos-token-mint` | `@platosdev/token-mint` | no | no | no | yes | owner-review-public-boundary | yes | yes | `c8c6e941d0efc940…` |
| `packages/react-hooks` | `@platos/react-hooks` | no | no | no | no | owner-review-public-boundary | yes | yes | `60a5d19096461195…` |
| `packages/redis-worker` | `@platos/redis-worker` | no | no | no | no | owner-review-public-boundary | yes | yes | `63eea109cbc580bd…` |

Exact roots, reasons, reverse paths, channel evidence, boundaries, input hashes, and full per-workspace hashes are in the JSON artifact.
