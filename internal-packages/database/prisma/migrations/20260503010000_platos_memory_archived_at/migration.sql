-- Theme MCPF-W2: PlatosMemory.archivedAt soft-delete marker.
-- Read paths (list / semanticSearch) filter `archivedAt IS NULL` by default.
-- Restore via `memories.restore`; hard delete via `memories.delete` /
-- `memories.bulk_delete`.

ALTER TABLE "PlatosMemory" ADD COLUMN "archivedAt" TIMESTAMP(3);
