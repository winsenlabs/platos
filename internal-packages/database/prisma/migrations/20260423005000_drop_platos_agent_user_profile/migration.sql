-- Theme M.4 — drop the legacy PlatosAgentUserProfile blob table. M.3 flipped
-- readers to PlatosMemory (kind="profile") via ProfileCacheService. M.2's
-- dual-write populated PlatosMemory with every profile key. This drops the
-- now-orphan blob table.
--
-- Safe: IF EXISTS makes re-runs idempotent; no FK constraints reference
-- PlatosAgentUserProfile from other tables (it was scope-tuple keyed via
-- denormalized org/project/env FKs — those FKs pointed OUT of this table,
-- never into it).
DROP TABLE IF EXISTS "public"."PlatosAgentUserProfile";
