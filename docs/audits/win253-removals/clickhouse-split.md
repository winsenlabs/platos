# WIN-253 ClickHouse split audit

## Boundary

The owner-authorization baseline is
`fcf39fa227cb9265b7e532f14ef181a3b65ff061`. It authorizes the bounded cluster
paths, but it is not the deletion-blob or restore source. The cluster removes the inherited
ClickHouse npm implementation, replication package, TSQL parser package, and the
parser's root patch integration. It does not remove
`internal-packages/clickhouse/schema/` or the Platos observability migrations.
The assembled-tree deletion diff, every deletion blob identity, and the exact
restore command are anchored at primary integration base
`0e3a86661dcaeae1ef8932fb1371a55ff3614c15`, so already integrated WIN-252
deletions cannot be misattributed to this cluster and paths changed after owner
authorization restore to their integration-base bytes.

The authoritative evidence is generated, not transcribed:

```bash
pnpm test:win253-clickhouse-split
pnpm audit:win253-clickhouse-split
```

`scripts/clickhouse-split-audit.mjs` reads the owner-authorization tree, the
integration-base blobs, and the actual Git deletion set. `--check` fails if the
committed report differs by one byte;
`--write` regenerates
[`clickhouse-split.json`](./clickhouse-split.json) only after all invariants pass.
The package and CI semantic policy require both the mutation suite and read-only
audit.

## What the executable audit derives

The audit has no asserted deletion inventory. From Git and repository content it:

1. derives every owner-authorized path from the bounded cluster roots,
   explicitly excluding the schema directory;
2. derives every actual deletion from the integration-base-to-worktree Git diff;
3. rejects a missing cluster deletion, any unrecorded deletion outside the
   authorization, or any current tracked, untracked, or ignored file under the
   removed package roots while preserving the schema exception;
4. reuses the root-manifest repository enumerator for tracked/untracked
   non-ignored files, then separately walks the retired roots on disk so ignored
   `dist`, `node_modules`, cache, and other local remnants cannot masquerade as
   a complete tombstone;
5. reads each integration-base deletion blob through Git and records its blob
   OID, SHA-256, mode, and byte count;
6. emits the exact integration-base restore `argv` and pathspec from the actual
   deletion set, and tests that all 91 restored files byte-match Git, including
   the ClickHouse `package.json` changed after owner authorization;
7. derives candidate package names and dependency sections from owner-authorization
   `package.json` files;
8. scans regular, side-effect, dynamic, and `require` imports, filesystem and
   dynamic package-loader paths (including direct and aliased
   `createRequire(...).resolve(...)`), plus TypeScript references, CI, package scripts,
   Docker/Compose, test config, documentation, licence/notice, and generated-asset
   channels;
9. classifies owner-authorization references as cluster-internal or external and rejects
   current executable-channel references;
10. proves the parser patch/importers and deleted-path vocabulary rows are absent;
11. compares every protected schema/observability migration hash with the
    owner-authorization baseline and verifies retained shipping consumers.

The mutation test carries an independent fixture for every reported channel. It
also injects an unauthorized deletion, restores one expected owner-authorized
path, introduces tracked/untracked and explicitly ignored current-tree files
under tombstoned package roots, executes the generated restore command, and
tampers with the generated report so each fail-closed control demonstrates that
it can turn red.

## Integration-overlay gate

`pnpm test:docs-examples` derives the required Compose variables from the current
Compose contract. On this isolated predecessor branch it also requires the
WIN-252 integration overlay that documents `PLATOS_INTERNAL_AUTH_TOKEN` in
`content/docs/self-hosting.md`. WIN-253 does not duplicate that unrelated edit;
the docs-examples gate must be evaluated after applying the WIN-252 overlay.

## Retained production path

The retired npm client is distinct from the live migration directory. These
shipping paths remain in place and are protected by the audit:

- `apps/webapp/Dockerfile.platos` copies the schema into the built image;
- `apps/webapp/scripts/entrypoint.sh` runs Goose against that directory;
- `internal-packages/tenancy-database/Dockerfile.migrations` builds the migration
  image from the same schema;
- `docker-compose.platos.yml` and `docker-compose.deploy.yml` retain the
  migration service; the primary Compose overlay also retains WIN-290's
  `PLATOS_CLICKHOUSE_TIMEOUT_MS` contract;
- `internal-packages/testcontainers/src/utils.ts` resolves the retained schema;
- the agent observability sink and erasure contract still point at migration
  `033_create_platos_observability_v1.sql`.

All 34 schema files and the WIN-144 observability retry-vocabulary migration are
owner-authorization-hash protected. Vocabulary regeneration must preserve the complete
schema exception sequence exactly while removing only rows whose paths were
actually deleted.

## Restore

The JSON report's `restore.argv` is the exact non-shell command sourced from the
current integration base, and
`restore.pathspec` is its exact path list. This avoids a broad directory restore
that could overwrite retained schema work. To execute it safely:

```bash
node - <<'NODE'
const { spawnSync } = require("node:child_process");
const report = require("./docs/audits/win253-removals/clickhouse-split.json");
const [command, ...args] = report.restore.argv;
const result = spawnSync(command, args, { stdio: "inherit" });
process.exitCode = result.status ?? 1;
NODE
```

Restoring any recorded path intentionally makes the audit fail until the entire
cluster removal is reverted or the authorization is reviewed.
