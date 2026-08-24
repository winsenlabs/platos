-- Expand the deployed Memory schema without rewriting applied migration
-- history. Profile identity is finalized by the Agent after it decrypts
-- metadata with MessageCryptoService; this migration deliberately does not
-- create the partial unique indexes required by profile writes.
ALTER TABLE "public"."Memory"
ADD COLUMN "profileKey" TEXT,
ADD COLUMN "originalSource" TEXT,
ADD COLUMN "originalSourceThreadId" TEXT,
ADD COLUMN "originalSourceTurnIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Preserve pre-normalization provenance in inert columns. These values are
-- never treated as live Thread/Turn references.
UPDATE "public"."Memory"
SET
  "originalSource" = "source",
  "originalSourceThreadId" = "sourceThreadId"::TEXT,
  "originalSourceTurnIds" = ARRAY(
    SELECT source_turn_id::TEXT
    FROM unnest(coalesce("sourceTurnIds", ARRAY[]::UUID[])) AS source_turn_id
  );

-- Inventory compatibility categories before normalization. Do not emit raw
-- values: source and visibility were operator-controlled in older installations
-- and migration logs must not become a disclosure surface.
DO $$
DECLARE
  compatibility_inventory JSONB;
BEGIN
  SELECT jsonb_build_object(
    'source', jsonb_build_object(
      'canonical', count(*) FILTER (
        WHERE lower(btrim("source")) IN ('manual', 'extracted', 'imported', 'rag')
      ),
      'legacy_extracted', count(*) FILTER (
        WHERE lower(btrim("source")) IN ('turn', 'agent_turn', 'extractor', 'extraction')
      ),
      'legacy_imported', count(*) FILTER (
        WHERE lower(btrim("source")) IN ('import', 'migration', 'legacy_import')
      ),
      'legacy_rag', count(*) FILTER (
        WHERE lower(btrim("source")) IN ('retrieval', 'knowledge_base', 'knowledge-base', 'vector_store')
      ),
      'fallback', count(*) FILTER (
        WHERE lower(btrim("source")) NOT IN (
          'manual', 'extracted', 'imported', 'rag',
          'turn', 'agent_turn', 'extractor', 'extraction',
          'import', 'migration', 'legacy_import',
          'retrieval', 'knowledge_base', 'knowledge-base', 'vector_store'
        )
      )
    ),
    'visibility', jsonb_build_object(
      'canonical_consistent', count(*) FILTER (
        WHERE ("visibility" = 'agent_visible' AND "agentVisible" = TRUE)
           OR ("visibility" IN ('hidden', 'private') AND "agentVisible" = FALSE)
      ),
      'legacy_subject', count(*) FILTER (WHERE lower(btrim("visibility")) = 'subject'),
      'inconsistent_or_unknown', count(*) FILTER (
        WHERE NOT (
          ("visibility" = 'agent_visible' AND "agentVisible" = TRUE)
          OR ("visibility" IN ('hidden', 'private') AND "agentVisible" = FALSE)
        )
        AND lower(btrim("visibility")) <> 'subject'
      )
    )
  ) INTO compatibility_inventory
  FROM "public"."Memory";

  RAISE NOTICE 'Memory compatibility inventory before normalization: %', compatibility_inventory;
END $$;

-- Preserve known source semantics, infer extracted provenance where possible,
-- and conservatively classify otherwise unknown legacy values as manual.
UPDATE "public"."Memory"
SET "source" = CASE
  WHEN lower(btrim("source")) IN ('manual', 'extracted', 'imported', 'rag')
    THEN lower(btrim("source"))
  WHEN lower(btrim("source")) IN ('turn', 'agent_turn', 'extractor', 'extraction')
    THEN 'extracted'
  WHEN lower(btrim("source")) IN ('import', 'migration', 'legacy_import')
    THEN 'imported'
  WHEN lower(btrim("source")) IN ('retrieval', 'knowledge_base', 'knowledge-base', 'vector_store')
    THEN 'rag'
  WHEN "sourceThreadId" IS NOT NULL
    OR coalesce(cardinality("sourceTurnIds"), 0) > 0
    OR "extractorVersion" IS NOT NULL
    THEN 'extracted'
  ELSE 'manual'
END;

-- Legacy `subject` rows remain private to their persisted EndUser unless the
-- separately persisted recall flag explicitly made them Agent-visible.
-- Canonical rows with inconsistent flags are repaired by the same rule.
UPDATE "public"."Memory"
SET "visibility" = CASE
  WHEN "agentVisible" = TRUE THEN 'agent_visible'
  WHEN lower(btrim("visibility")) IN ('private', 'subject') THEN 'private'
  ELSE 'hidden'
END;

ALTER TABLE "public"."Memory"
ADD CONSTRAINT "Memory_source_check"
CHECK ("source" IN ('manual', 'extracted', 'imported', 'rag')) NOT VALID,
ADD CONSTRAINT "Memory_visibility_check"
CHECK (
  ("visibility" = 'agent_visible' AND "agentVisible" = TRUE)
  OR ("visibility" IN ('hidden', 'private') AND "agentVisible" = FALSE)
) NOT VALID;

ALTER TABLE "public"."Memory"
VALIDATE CONSTRAINT "Memory_source_check";

ALTER TABLE "public"."Memory"
VALIDATE CONSTRAINT "Memory_visibility_check";

-- Memory_profile_standalone_key and Memory_profile_cluster_key are created by
-- MemoryProfileBackfillService only after encrypted metadata has been
-- decrypted, normalized, deduplicated, remapped, and verified atomically.
