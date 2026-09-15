# WIN-253 workspace reachability baseline

> Non-destructive evidence only. This report does not authorize deletion, quarantine, merge, or publication.

Evidence SHA-256: `4347ed8dc8aafebe1f19ef0dfee86736159cead56511d0493e4206b02765c5f6`

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
| `apps/agent` | `platos-agent` | yes | yes | yes | yes | retain-oci-image | no | no | `2db1940ffa67c9bd…` |
| `apps/core-api` | `@platos/core-api` | yes | yes | yes | yes | retain-oci-image | no | no | `0cdd4fa8ec2c5e64…` |
| `apps/mcp-stdio` | `@platos/mcp-stdio` | no | yes | yes | no | retain-application-deployable | no | no | `1c9a5286ae399d6f…` |
| `apps/webapp` | `webapp` | yes | yes | yes | yes | retain-oci-image | no | no | `7daf5b6a97dab718…` |
| `docs` | `docs` | no | no | no | no | owner-review-repository-referenced | no | yes | `72ea6321c9b15c6d…` |
| `internal-packages/cache` | `@internal/cache` | no | no | no | no | owner-review-repository-referenced | no | yes | `f9f2db1155272a42…` |
| `internal-packages/compute` | `@internal/compute` | no | no | no | no | owner-review-repository-referenced | no | yes | `744fd4bd20e8d379…` |
| `internal-packages/cost-rates` | `@internal/cost-rates` | no | no | no | no | owner-review-repository-referenced | no | yes | `6164efe052d457dc…` |
| `internal-packages/database` | `@platos/database` | no | no | no | yes | owner-review-repository-referenced | no | yes | `1dd62cfe9e3c9f1f…` |
| `internal-packages/docs` | `@internal/docs` | yes | yes | yes | yes | retain-oci-image | no | no | `f103fe02fd78580c…` |
| `internal-packages/emails` | `emails` | no | no | no | no | owner-review-repository-referenced | no | yes | `26084070c458a754…` |
| `internal-packages/llm-model-catalog` | `@internal/llm-model-catalog` | no | no | no | no | owner-review-repository-referenced | no | yes | `01ef30f9cd4ea0f7…` |
| `internal-packages/otlp-importer` | `@platos/otlp-importer` | no | no | no | no | owner-review-repository-referenced | no | yes | `32be9213fa8fd3e5…` |
| `internal-packages/redis` | `@internal/redis` | no | no | no | no | owner-review-repository-referenced | no | yes | `361afc7e1676fa7d…` |
| `internal-packages/run-engine` | `@internal/run-engine` | no | no | no | no | owner-review-repository-referenced | no | yes | `1e4ed426a3d5ab74…` |
| `internal-packages/schedule-engine` | `@internal/schedule-engine` | no | no | no | no | owner-review-repository-referenced | no | yes | `c6e22fe59eb7f562…` |
| `internal-packages/tenancy-database` | `@platos/tenancy-database` | yes | yes | yes | yes | retain-oci-image | no | no | `8d379ffc15b9d14b…` |
| `internal-packages/tenancy-database/migration-image` | `@platos/tenancy-migration-image` | yes | no | yes | yes | retain-oci-image | no | no | `f63a66d17bb21fb6…` |
| `internal-packages/testcontainers` | `@internal/testcontainers` | no | no | no | yes | owner-review-repository-referenced | no | yes | `4040c438255b3f61…` |
| `internal-packages/tracing` | `@internal/tracing` | no | no | no | no | owner-review-repository-referenced | no | yes | `e03f6256d2d15deb…` |
| `internal-packages/workload-identity` | `@internal/workload-identity` | yes | yes | yes | yes | retain-oci-image | no | no | `e6775b1d418866f8…` |
| `internal-packages/zod-worker` | `@internal/zod-worker` | no | no | no | no | owner-review-repository-referenced | no | yes | `86a5ee29b9046270…` |
| `packages/adapters/channel-slack` | `@platos/adapter-channel-slack` | yes | yes | yes | yes | retain-oci-image | no | no | `20122eda20056219…` |
| `packages/adapters/clickhouse-observability` | `@platos/adapter-clickhouse-observability` | yes | yes | yes | yes | retain-oci-image | no | no | `fda9e209c1616d4c…` |
| `packages/adapters/durable-runtime` | `@platos/adapter-durable-runtime` | yes | yes | yes | yes | retain-oci-image | no | no | `fc5396c7094bbaa4…` |
| `packages/adapters/keyring-envelope` | `@platos/adapter-keyring-envelope` | yes | yes | yes | yes | retain-oci-image | no | no | `3db5e007f1de64ad…` |
| `packages/adapters/model-router-providers` | `@platos/adapter-model-router-providers` | yes | yes | yes | yes | retain-oci-image | no | no | `c179f5bfce38b25f…` |
| `packages/adapters/node-crypto-digest` | `@platos/adapter-node-crypto-digest` | yes | yes | yes | yes | retain-oci-image | no | no | `16d3a8a9663096b1…` |
| `packages/adapters/notifier-email` | `@platos/adapter-notifier-email` | yes | yes | yes | yes | retain-oci-image | no | no | `396e305a788ac535…` |
| `packages/adapters/notifier-webhook` | `@platos/adapter-notifier-webhook` | yes | yes | yes | yes | retain-oci-image | no | no | `e6b47c260c4f79d4…` |
| `packages/adapters/objectstore-minio` | `@platos/adapter-objectstore-minio` | yes | yes | yes | yes | retain-oci-image | no | no | `10b7bb6241015a7c…` |
| `packages/adapters/outbox` | `@platos/adapter-outbox` | yes | yes | yes | yes | retain-oci-image | no | no | `e57102f8c3263f7d…` |
| `packages/adapters/postgres-tenancy` | `@platos/adapter-postgres-tenancy` | yes | yes | yes | yes | retain-oci-image | no | no | `73f5b3bb0a416cff…` |
| `packages/adapters/redis-cache` | `@platos/adapter-redis-cache` | yes | yes | yes | yes | retain-oci-image | no | no | `6af76fbd6bc4a7f6…` |
| `packages/adapters/redis-ratelimit` | `@platos/adapter-redis-ratelimit` | yes | yes | yes | yes | retain-oci-image | no | no | `f0a32c373f7fb437…` |
| `packages/adapters/redis-streams` | `@platos/adapter-redis-streams` | yes | yes | yes | yes | retain-oci-image | no | no | `71d9c33b97dfbaa2…` |
| `packages/adapters/tokenmint-totp` | `@platos/adapter-tokenmint-totp` | yes | yes | yes | yes | retain-oci-image | no | no | `916ca183865ba151…` |
| `packages/contexts/agents` | `@platos/context-agents` | yes | yes | yes | yes | retain-oci-image | no | no | `af51388b7932529b…` |
| `packages/contexts/channels` | `@platos/context-channels` | yes | yes | yes | yes | retain-oci-image | no | no | `16e8415260a7b434…` |
| `packages/contexts/conversations` | `@platos/context-conversations` | yes | yes | yes | yes | retain-oci-image | no | no | `30204b96fd51f40e…` |
| `packages/contexts/cost-monitoring` | `@platos/context-cost-monitoring` | yes | yes | yes | yes | retain-oci-image | no | no | `8f31cc263f688045…` |
| `packages/contexts/eventing` | `@platos/context-eventing` | yes | yes | yes | yes | retain-oci-image | no | no | `36cdc176e106eeb2…` |
| `packages/contexts/files` | `@platos/context-files` | yes | yes | yes | yes | retain-oci-image | no | no | `372a241ae766e528…` |
| `packages/contexts/governance` | `@platos/context-governance` | yes | yes | yes | yes | retain-oci-image | no | no | `5b8c81954bc1ee59…` |
| `packages/contexts/identity-access` | `@platos/context-identity-access` | yes | yes | yes | yes | retain-oci-image | no | no | `5567eabc50667763…` |
| `packages/contexts/jobs` | `@platos/context-jobs` | yes | yes | yes | yes | retain-oci-image | no | no | `461978dfa091d600…` |
| `packages/contexts/memory` | `@platos/context-memory` | yes | yes | yes | yes | retain-oci-image | no | no | `6f98127ecbf55502…` |
| `packages/contexts/observability` | `@platos/context-observability` | yes | yes | yes | yes | retain-oci-image | no | no | `f29cc1dce8621274…` |
| `packages/contexts/privacy` | `@platos/context-privacy` | yes | yes | yes | yes | retain-oci-image | no | no | `32a2b320ecfb1371…` |
| `packages/contexts/providers` | `@platos/context-providers` | yes | yes | yes | yes | retain-oci-image | no | no | `c99d7540bf59ce52…` |
| `packages/contexts/secrets` | `@platos/context-secrets` | yes | yes | yes | yes | retain-oci-image | no | no | `154d000be6ecb1d9…` |
| `packages/contexts/skills` | `@platos/context-skills` | yes | yes | yes | yes | retain-oci-image | no | no | `11981027c1f77676…` |
| `packages/contexts/tenancy` | `@platos/context-tenancy` | yes | yes | yes | yes | retain-oci-image | no | no | `9b7d801b784b1f31…` |
| `packages/contexts/tools` | `@platos/context-tools` | yes | yes | yes | yes | retain-oci-image | no | no | `13ac0d25b7d1011a…` |
| `packages/core` | `@platos/core` | no | no | no | yes | owner-review-public-boundary | yes | yes | `3770d048540fbfc0…` |
| `packages/kernel` | `@platos/kernel` | yes | yes | yes | yes | retain-oci-image | no | no | `63b3e77fd52a8a6f…` |
| `packages/platools-js` | `@platosdev/platools-sdk` | no | no | no | no | owner-review-public-boundary | yes | yes | `b2da39b373c42d04…` |
| `packages/platos-client` | `@platosdev/client` | no | no | no | no | owner-review-public-boundary | yes | yes | `784e57ff52e59224…` |
| `packages/platos-embed` | `@platosdev/embed` | no | no | no | no | owner-review-public-boundary | yes | yes | `34ba474f699c1d72…` |
| `packages/platos-react-widget` | `@platosdev/react-widget` | no | no | no | no | owner-review-public-boundary | yes | yes | `1cc79739618d77b9…` |
| `packages/platos-token-mint` | `@platosdev/token-mint` | no | no | no | yes | owner-review-public-boundary | yes | yes | `f392576405cec143…` |
| `packages/react-hooks` | `@platos/react-hooks` | no | no | no | no | owner-review-public-boundary | yes | yes | `e7d6b6269f0582f5…` |
| `packages/redis-worker` | `@platos/redis-worker` | no | no | no | no | owner-review-public-boundary | yes | yes | `63eea109cbc580bd…` |

Exact roots, reasons, reverse paths, channel evidence, boundaries, input hashes, and full per-workspace hashes are in the JSON artifact.
