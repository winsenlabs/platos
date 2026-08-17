-- MCP-as-connected-entity — Commit 4 (dispatch branch + endUserId plumbing).
--
-- One additive, non-destructive column so the tool-call audit can persist the
-- per-user identity that a `connectionKind="mcp"` dispatch substituted into
-- `{{endUserId}}`:
--
--   PlatosToolCallAudit gains `endUserId TEXT` (nullable). It stores the
--   resolved PlatosEndUser.externalUserId VERBATIM (Composio's `user_id`) —
--   the exact value substituted into the outbound URL/headers. It is NOT the
--   `platosEndUserId` FK: that column references PlatosEndUser.id, whereas this
--   is the opaque customer-facing id, and it is what the replay endpoint reads
--   back to reconstruct `origin.endUserId` so a re-dispatch re-targets the same
--   user (or fails closed when null). Mirrors the existing verbatim `mcpUserId`
--   / `mcpClientId` origin columns.
--
-- Wire calls and every legacy row leave it NULL, so wire dispatch + existing
-- audit reads are completely unaffected. Idempotent (IF NOT EXISTS) so a re-run
-- on a database carrying partial state is safe.

ALTER TABLE "public"."PlatosToolCallAudit"
  ADD COLUMN IF NOT EXISTS "endUserId" TEXT;
