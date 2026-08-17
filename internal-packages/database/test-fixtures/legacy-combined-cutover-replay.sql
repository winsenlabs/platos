-- Combined forced-rollback rehearsal fixture finalizer.
-- Apply after, in order:
--   legacy-core-seed.sql
--   legacy-auth-supplemental-seed.sql
--   legacy-agent-tool-batch1-seed.sql
--   legacy-conversation-batch2-seed.sql
--   legacy-retained-batch3-seed.sql
--   legacy-provider-oauth-batch4-seed.sql
--
-- The supplemental fixture deliberately retains negative fail-closed vectors
-- for its individual tests. The combined production-command replay removes
-- only those named blockers while preserving enabled-v1, pending-v2, and the
-- disabled/null-reference classification.
DELETE FROM "User"
 WHERE id IN (
   'cllegacyuser0004',
   'cllegacyuser0005',
   'cllegacyuser0006',
   'cllegacyuser0007'
 );
