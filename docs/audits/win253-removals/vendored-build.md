# WIN-253 vendored build/SDK retirement

## Result

At authorized base `fcf39fa227cb9265b7e532f14ef181a3b65ff061`, six inherited Trigger workspaces formed a closed cluster and were removed:

- `packages/trigger-sdk` (`@platos/sdk`)
- `internal-packages/sdk-compat-tests` (`@internal/sdk-compat-tests`)
- `packages/build` (`@platos/build`)
- `packages/python` (`@platos/python`, a JavaScript Trigger extension—not a Platos Python SDK)
- `packages/rsc` (`@platos/rsc`)
- `packages/schema-to-json` (`@platos/schema-to-json`)

`packages/cli-v3` was already absent. Commit `a2eade8eb033302d77abd80d3337a7fdb6213ca2` retired it before this branch's base, so this cluster does not delete it again.

The removal deletes 120 tracked files, 574,551 tracked bytes, and 20,067 diff lines. The agent Docker builder's broad workspace install now discovers six fewer workspaces. Production deploy dependency manifests are unchanged because no shipping app depended on a candidate.

## Reachability proof

The scan covered production and development manifests, source imports, dynamic loads, package scripts, CI, Dockerfiles, tests, docs, examples, generated indexes, lockfile importers, and license files.

| Channel | Finding | Classification |
| --- | --- | --- |
| Production manifests | No candidate dependency outside the candidate cluster. | Unreachable |
| Development/peer manifests | Six reverse edges, all internal to the retiring cluster. | Closed cluster |
| Source | No runtime import or dynamic load. Five app/package source occurrences of `@platos/sdk` are comments. | Non-consumer residue |
| Scripts | Two `@platos/sdk` strings are negative production-dependency guards. | Retain guard |
| CI | No candidate path/name execution. | Unreachable |
| Docker/image | No candidate path/name reference. Agent builder installs the full discovered workspace; webapp prune has no reverse manifest edge. | Builder-only traversal removed |
| Tests | Eleven tests/fixtures are package-local; no external test depends on the cluster. | Retire with package |
| Docs | Several path/name references describe the old vendored SDK/build packages. | Shared cleanup required |
| Examples | No candidate dependency. | Unreachable |
| Generated | Vocabulary manifest has 741 candidate-file entries. | Generated index residue |
| Lockfile | Six importer blocks remain until shared lock regeneration. | Shared cleanup required |
| Licenses | Three package-local MIT license files cover deleted code. Root legal files and protected SDK licenses remain. | No surviving-code obligation removed |

Exact package-name searches found no package-manifest consumer outside the cluster. Npm registry reads returned HTTP 404 on 2026-08-30 for `@platos/sdk`, `@platos/build`, `@platos/python`, `@platos/rsc`, and `@platos/schema-to-json`, so no published candidate version creates an unresolved compatibility obligation.

## Protected SDK boundary

This commit does not edit the externally published Platos SDK families under `packages/platools-js`, `packages/platos-client`, `packages/platos-embed`, `packages/platos-react-widget`, or `packages/platos-token-mint`. It also leaves both Platos Python SDKs—`packages/platools-py` and `packages/platos-client-py`—untouched. Their predecessor tree hashes are recorded in `vendored-build.json` for exact comparison.

## Rollback

Every deleted path can be restored independently from the immutable predecessor:

```sh
git restore --source=fcf39fa227cb9265b7e532f14ef181a3b65ff061 -- packages/trigger-sdk
git restore --source=fcf39fa227cb9265b7e532f14ef181a3b65ff061 -- internal-packages/sdk-compat-tests
git restore --source=fcf39fa227cb9265b7e532f14ef181a3b65ff061 -- packages/build
git restore --source=fcf39fa227cb9265b7e532f14ef181a3b65ff061 -- packages/python
git restore --source=fcf39fa227cb9265b7e532f14ef181a3b65ff061 -- packages/rsc
git restore --source=fcf39fa227cb9265b7e532f14ef181a3b65ff061 -- packages/schema-to-json
```

The historical CLI tree can be restored only if explicitly re-authorized:

```sh
git restore --source=a83ee845166d94b641952061f6d5eafc11a3772d -- packages/cli-v3
```

Path tree hashes, file/line/byte counts, predecessor SHAs, and per-path commands are machine-readable in `vendored-build.json`.

## Shared integration edits intentionally not owned here

This isolated cluster does not edit root package/workspace/lock/turbo/CI files, the vocabulary ledger, SBOMs, changesets, or shared application/docs files. The integration owner must:

1. Regenerate `pnpm-lock.yaml` to remove the six retired importer blocks and any candidate-only snapshots.
2. Regenerate `docs/vocabulary-boundary-exceptions.json` to remove 741 generated candidate-file entries.
3. Remove retired package bump entries from `.changeset/eobd-83-followup-package-repo-urls.md`.
4. Remove dead candidate ignores from `.gitignore` and `.cursorignore`.
5. Update `ai/references/repo.md`, active Trigger integration docs, and stale source comments to identify `@trigger.dev/sdk` as the external runtime SDK.
6. Retain `scripts/audit-platos-build.mjs` and `apps/agent/scripts/audit-production-dependencies.mjs` references to `@platos/sdk`; they are deliberate negative guards.
7. Regenerate current reachability/SBOM artifacts while preserving the M0.5 SBOM as historical evidence.

The generic workspace globs need no semantic edit: removing these directories makes workspace discovery stop traversing them. Root scripts, turbo configuration, CI, and Dockerfiles contain no exact candidate execution reference.

## Verification

The baseline `node scripts/audit-platos-build.mjs` passed all 1,579 checks. A temporary mutation that added `@platos/sdk` to `apps/agent/package.json` made the audit fail at `agent package does not depend on the legacy database graph`; restoring the manifest returned the worktree to its exact original bytes. This proves the dependency boundary assertion is non-vacuous.

Post-removal evidence:

| Command/proof | Result |
| --- | --- |
| `node scripts/audit-platos-build.mjs` | 1,579/1,579 checks passed again |
| `pnpm install --frozen-lockfile --ignore-scripts` | Passed; scope fell from 70 to 64 workspaces |
| TypeScript AST import/dynamic-load scan | Parsed 1,477 tracked source files; zero candidate edges |
| Manifest dependency scan | Parsed 68 tracked package manifests; zero candidate edges |
| `pnpm run build:platos:agent` | Passed strict production build and emitted dependency audit |
| Agent Trigger boundary suites | 5 bundle, 9 deployment-boundary, and 4 cutover tests passed |
| Protected JavaScript SDK suites | 151 tests passed; all five SDK typechecks passed |
| `packages/platools-py` | 165 tests passed |
| `packages/platos-client-py` | 9 tests passed |
| Shared graph diff | Root package, workspace, lock, turbo, and CI files unchanged |

The full Docker build is deferred to the integration owner because exact image evidence must follow shared lock, reachability, vocabulary, and SBOM regeneration, which this isolated cluster is explicitly forbidden to edit. No publish, push, merge, deploy, or external mutation is part of this cluster.
