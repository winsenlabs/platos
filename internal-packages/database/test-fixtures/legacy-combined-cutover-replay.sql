-- Combined forced-rollback rehearsal fixture finalizer.
-- Apply after, in order:
--   legacy-core-seed.sql
--   legacy-auth-supplemental-seed.sql
--   legacy-agent-tool-batch1-seed.sql
--   legacy-conversation-batch2-seed.sql
--   legacy-retained-batch3-seed.sql
--   legacy-provider-oauth-batch4-seed.sql
--   legacy-channel-batch5-seed.sql
--   legacy-operational-batch6-seed.sql
--   legacy-eval-job-skill-batch7-seed.sql
--   legacy-memory-batch8-seed.sql
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

-- Export-only Trigger/unsupported data must be present in the combined replay,
-- including a value that may appear only after the sealed artifact is opened.
INSERT INTO "DataMigration" (id, name, "createdAt", "updatedAt", "completedAt")
VALUES ('cllegacydatamigration0001', 'fixture-trigger-export-row',
        '2025-01-06T00:00:00Z', '2025-01-06T00:00:00Z', NULL);

INSERT INTO "FeatureFlag" (id, key, value, "createdAt", "updatedAt")
VALUES ('cllegacyfeatureflag0001', 'fixture-sealed-export-only',
        '{"token":"fixture-trigger-export-secret-never-report"}'::jsonb,
        '2025-01-06T00:00:00Z', '2025-01-06T00:00:00Z');

-- Both EPHEMERAL_DROP families are deliberately non-empty. The rehearsal
-- counts their invalidation disposition and then rolls the source transaction
-- back; it never translates either row into the clean catalog.
INSERT INTO "RuntimeEnvironmentSession"
  (id, "ipAddress", "environmentId", "createdAt", "updatedAt", "disconnectedAt")
VALUES ('cllegacysession0001', '192.0.2.44', 'cllegacyenv0001',
        '2025-01-06T00:00:00Z', '2025-01-06T00:00:00Z', NULL);
