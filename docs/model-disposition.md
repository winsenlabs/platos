# Inherited Prisma disposition

The executable source of truth is
`internal-packages/database/src/cutover-ledger.ts`; this document does
not duplicate the model list.

The inherited Prisma schema currently contains **124 models**. Every model is
classified exactly once:

| Disposition      |   Count | Meaning                                                                                                                                     |
| ---------------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKFILL`       |      64 | Read and transform into the clean UUID schema. This includes all 55 retained `Platos*` sources plus nine auth/tenancy/secret/audit sources. |
| `EXPORT_DROP`    |      58 | Export with counts/checksums, then remove from the live Platos catalog.                                                                     |
| `EPHEMERAL_DROP` |       2 | Intentionally invalidate without translating: legacy MFA recovery codes and runtime/browser sessions.                                       |
| **Total**        | **124** |                                                                                                                                             |

The same ledger covers all 130 replayed physical tables, including five Prisma
implicit join tables and `_prisma_migrations`. The checked-in
`legacy-index-catalog.ts` records all 458 indexes observed after replaying the
849 inherited migrations. The 44 enums are classified separately. The
application migration lineage creates no functions or triggers; pgvector-owned
functions are extension metadata and are represented by the single `vector`
extension entry.

Run the ownership gates with:

```sh
pnpm --filter @platos/database exec vitest run \
  src/cutover-ledger.test.ts src/cutover-id.test.ts \
  --sequence.concurrent=false --no-file-parallelism
```

The tests compare model/table/enum names to the inherited Prisma schema, compare
the physical index snapshot to the exact known migration-replay/datamodel delta,
validate field-addressable transforms and cryptographic probes, and fail on
missing or duplicate dispositions.
