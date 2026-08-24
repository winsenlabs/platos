# WIN-236/WIN-237 PostgreSQL evidence gate

The nonlocal gate runs against an isolated PostgreSQL database with pgvector installed. It resets the database's `public` schema before each suite, so the database name must contain `test`, `integration`, or `gate` and the caller must explicitly set `PLATOS_POSTGRES_INTEGRATION_ALLOW_RESET=1`.

## Command

```bash
PLATOS_POSTGRES_INTEGRATION_DATABASE_URL='postgresql://.../platos_memory_integration_test?schema=public' \
PLATOS_POSTGRES_INTEGRATION_ALLOW_RESET=1 \
PLATOS_POSTGRES_EVIDENCE_DIR=artifacts/win236-win237-postgres \
PLATOS_POSTGRES_EVIDENCE_REQUIRED=1 \
pnpm test:postgres-memory:evidence
```

GitHub Actions executes this command in the `postgres-memory-evidence` job with the digest-pinned `pgvector/pgvector:pg16` service. Tests use that service directly; they do not start Testcontainers in external-database mode.

## Fail-loud contract

The command executes these files serially against a clean schema:

1. `memory-retrieval-postgres.integration.test.ts` — exactly 4 tests.
2. `knowledge-graph-postgres.integration.test.ts` — exactly 7 tests.
3. `memory-import-export-postgres.integration.test.ts` — exactly 2 tests.
4. `memory-profile-upgrade-postgres.integration.test.ts` — exactly 1 test.

Any failed, skipped, todo, missing, or unexpectedly added test fails the gate. The verifier also fails when a query count exceeds its checked-in maximum, an EXPLAIN artifact lacks `ANALYZE`/`BUFFERS`, the plan artifact exceeds 256 KiB, PostgreSQL is not version 16, or pgvector is absent. `verify-artifacts.test.mjs` mutation-checks the skipped-test, query-budget, and non-ANALYZE failure paths.

## Artifact contract

GitHub uploads `win236-win237-postgres-<run_id>-<run_attempt>` for 14 days. It contains:

- `manifest.json` and `artifact-schema.json` — immutable commit SHA, exact suite/test counts, zero failed/skipped totals, command, and evidence inventory.
- `suites/<suite>.json` — normalized Vitest JSON reports used by the verifier.
- `suites/<suite>.stdout.log` and `.stderr.log` — bounded-run diagnostics.
- `postgres-runtime.json` — PostgreSQL and pgvector versions.
- `*.query-count.json` — measured query count, asserted maximum, endpoint, and dense fixture size.
- `*.explain.json` — bounded `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` evidence for semantic retrieval, 384-row Memory pagination, and 141-entity graph pagination.

Re-verify a downloaded artifact with:

```bash
pnpm test:postgres-memory:artifacts -- /path/to/artifact
```
