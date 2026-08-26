# WIN-236/WIN-237 PostgreSQL evidence gate

The nonlocal gate runs against an isolated PostgreSQL database with pgvector installed. It resets the database's `public` schema before each suite. The reset accepts only this exact disposable identity:

- host `127.0.0.1` and port `55433`;
- database and principal `platos_memory_evidence_ci`;
- schema URL parameter `public`;
- explicit `PLATOS_POSTGRES_INTEGRATION_ALLOW_RESET=1`;
- the checked server-side sentinel in the non-public `platos_memory_evidence_guard` schema.

Names that merely contain `test`, `integration`, or `gate` are rejected. A VPC database must be exposed through a loopback tunnel with the exact disposable database/principal and must have its server-side sentinel explicitly provisioned before the gate can reset anything.

## Command

```bash
export PLATOS_POSTGRES_INTEGRATION_DATABASE_URL='postgresql://platos_memory_evidence_ci:<password>@127.0.0.1:55433/platos_memory_evidence_ci?schema=public'
export PLATOS_POSTGRES_INTEGRATION_ALLOW_RESET=1
export PLATOS_POSTGRES_EVIDENCE_DIR=artifacts/win236-win237-postgres
export PLATOS_POSTGRES_EVIDENCE_REQUIRED=1

# Separate, explicit server-side opt-in. The test runner never creates this sentinel.
pnpm provision:postgres-memory:evidence
pnpm test:postgres-memory:evidence
```

GitHub Actions executes this command in the `postgres-memory-evidence` job with the digest-pinned `pgvector/pgvector:pg16` service. Tests use that service directly; they do not start Testcontainers in external-database mode.

## Fail-loud contract

The command executes these files serially against a clean schema:

1. `memory-retrieval-postgres.integration.test.ts` — exactly 4 tests.
2. `knowledge-graph-postgres.integration.test.ts` — exactly 7 tests.
3. `memory-import-export-postgres.integration.test.ts` — exactly 2 tests.
4. `memory-profile-upgrade-postgres.integration.test.ts` — exactly 1 test.

Any failed, skipped, todo, missing, or unexpectedly added test fails the gate. Query evidence is hard-pinned by filename, endpoint, fixture cardinality, and maximum count: semantic search `1559/12`, Memory list `384/8`, and graph list `141/6`. Changing a declared maximum is itself a verifier failure.

EXPLAIN plans replay the exact Prisma-emitted endpoint SQL and record its normalized SHA-256 hash. Memory and graph item/count plans are checked independently, so one valid plan cannot mask a missing `ANALYZE`, rows, or buffers payload in another. The verifier also rejects artifacts above 256 KiB, PostgreSQL versions other than 16, and missing pgvector.

## Artifact contract

GitHub uploads `win236-win237-postgres-<run_id>-<run_attempt>` for 14 days. It contains:

- `manifest.json` and `artifact-schema.json` — immutable commit SHA, exact suite/test counts, zero failed/skipped totals, command, and evidence inventory.
- `suites/<suite>.json` — normalized Vitest JSON reports used by the verifier.
- `suites/<suite>.stdout.log` and `.stderr.log` — bounded-run diagnostics.
- `postgres-runtime.json` — PostgreSQL and pgvector versions.
- `*.query-count.json` — measured query count plus hard-pinned maximum, endpoint, and dense fixture size.
- `*.explain.json` — bounded `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` evidence containing captured normalized endpoint SQL, SHA-256, and independently verified plan payloads for semantic retrieval, 384-row Memory pagination, and 141-entity graph pagination.

Re-verify a downloaded artifact with:

```bash
pnpm test:postgres-memory:artifacts -- /path/to/artifact
```
