-- M4 forward-upgrade contract.
--
-- The initial migration was already applied by deployed databases before the
-- Thread fork, attachment ownership, Postman execution, and Entity tool-policy
-- ownership contracts landed. Keep this migration idempotent because clean
-- databases may already contain these objects from the integrated initial SQL.

-- This forward upgrade is a maintenance-window migration: every application
-- writer must be stopped before `prisma migrate deploy` starts and remain
-- stopped until it completes. The preflights intentionally run before any DDL
-- and outside the mutation transaction so Prisma preserves their actionable
-- errors instead of replacing them with a transaction-aborted error. Dynamic
-- owner expressions keep the checks compatible with both the origin/main
-- schema (columns absent) and the integrated schema (present).
DO $preflight$
DECLARE
  has_agent_owner BOOLEAN;
  has_thread_owner BOOLEAN;
  agent_owner_expression TEXT;
  thread_owner_expression TEXT;
  unattached_count BIGINT;
  missing_turn_or_thread_count BIGINT;
  scope_mismatch_count BIGINT;
  conflicting_owner_count BIGINT;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'MessageAttachment' AND column_name = 'agentId'
  ) INTO has_agent_owner;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'MessageAttachment' AND column_name = 'threadId'
  ) INTO has_thread_owner;

  agent_owner_expression := CASE
    WHEN has_agent_owner THEN 'attachment."agentId"'
    ELSE 'NULL::UUID'
  END;
  thread_owner_expression := CASE
    WHEN has_thread_owner THEN 'attachment."threadId"'
    ELSE 'NULL::UUID'
  END;

  EXECUTE format($query$
    SELECT
      count(*) FILTER (WHERE (%1$s IS NULL OR %2$s IS NULL) AND attachment."turnId" IS NULL),
      count(*) FILTER (WHERE (%1$s IS NULL OR %2$s IS NULL) AND attachment."turnId" IS NOT NULL AND (turn_row.id IS NULL OR thread_row.id IS NULL)),
      count(*) FILTER (WHERE (%1$s IS NULL OR %2$s IS NULL) AND thread_row.id IS NOT NULL AND (thread_row."environmentId" <> attachment."environmentId" OR thread_row."endUserId" <> attachment."endUserId" OR environment.id IS NULL OR project.id IS NULL OR end_user.id IS NULL OR agent.id IS NULL)),
      count(*) FILTER (WHERE thread_row.id IS NOT NULL AND ((%1$s IS NOT NULL AND %1$s <> thread_row."agentId") OR (%2$s IS NOT NULL AND %2$s <> thread_row.id)))
    FROM "public"."MessageAttachment" attachment
    LEFT JOIN "public"."Turn" turn_row ON turn_row.id = attachment."turnId"
    LEFT JOIN "public"."Thread" thread_row ON thread_row.id = turn_row."threadId"
    LEFT JOIN "public"."Environment" environment ON environment.id = attachment."environmentId"
    LEFT JOIN "public"."Project" project ON project.id = environment."projectId"
    LEFT JOIN "public"."EndUser" end_user ON end_user.id = attachment."endUserId" AND end_user."organizationId" = project."organizationId"
    LEFT JOIN "public"."Agent" agent ON agent.id = thread_row."agentId" AND agent."projectId" = project.id
  $query$, agent_owner_expression, thread_owner_expression)
  INTO unattached_count, missing_turn_or_thread_count, scope_mismatch_count, conflicting_owner_count;

  IF unattached_count > 0 OR missing_turn_or_thread_count > 0 OR scope_mismatch_count > 0 OR conflicting_owner_count > 0 THEN
    RAISE EXCEPTION 'MessageAttachment ownership backfill failed: unattached=%, missing_turn_or_thread=%, scope_mismatch=%, conflicting_owner=%',
      unattached_count, missing_turn_or_thread_count, scope_mismatch_count, conflicting_owner_count
      USING ERRCODE = '23514';
  END IF;
END
$preflight$;

DO $preflight$
DECLARE
  has_environment_owner BOOLEAN;
  environment_owner_expression TEXT;
  missing_owner_count BIGINT;
  ambiguous_owner_count BIGINT;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'EntityToolPolicy' AND column_name = 'environmentId'
  ) INTO has_environment_owner;

  environment_owner_expression := CASE
    WHEN has_environment_owner THEN 'policy."environmentId"'
    ELSE 'NULL::UUID'
  END;

  EXECUTE format($query$
    WITH candidates AS (
      SELECT policy.id, count(DISTINCT environment.id) AS candidate_count
      FROM "public"."EntityToolPolicy" policy
      LEFT JOIN "public"."Entity" entity ON entity.id = policy."entityId"
      LEFT JOIN "public"."EnvironmentEntityTool" mapping
        ON mapping."entityId" = policy."entityId" AND mapping."toolId" = policy."toolId"
      LEFT JOIN "public"."Environment" environment
        ON environment.id = mapping."environmentId" AND environment."projectId" = entity."projectId"
      WHERE %1$s IS NULL
      GROUP BY policy.id
    )
    SELECT
      count(*) FILTER (WHERE candidate_count = 0),
      count(*) FILTER (WHERE candidate_count > 1)
    FROM candidates
  $query$, environment_owner_expression)
  INTO missing_owner_count, ambiguous_owner_count;

  IF missing_owner_count > 0 OR ambiguous_owner_count > 0 THEN
    RAISE EXCEPTION 'EntityToolPolicy ownership backfill failed: missing_owner=%, ambiguous_owner=%',
      missing_owner_count, ambiguous_owner_count
      USING ERRCODE = '23514';
  END IF;
END
$preflight$;

BEGIN;

-- Durable Postman execution admission and forensic attribution.
CREATE TABLE IF NOT EXISTS "public"."PostmanExecution" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "templateId" UUID,
    "requestId" UUID NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "actorUserId" UUID NOT NULL,
    "simulatedEndUserId" UUID,
    "contextHandle" TEXT NOT NULL,
    "contextExpiresAt" TIMESTAMP(3) NOT NULL,
    "status" "public"."WorkStatus" NOT NULL DEFAULT 'PENDING',
    "threadId" UUID,
    "turnId" UUID,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PostmanExecution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PostmanExecution_contextHandle_key"
  ON "public"."PostmanExecution"("contextHandle");
CREATE UNIQUE INDEX IF NOT EXISTS "PostmanExecution_turnId_key"
  ON "public"."PostmanExecution"("turnId");
CREATE UNIQUE INDEX IF NOT EXISTS "PostmanExecution_templateId_requestId_key"
  ON "public"."PostmanExecution"("templateId", "requestId");
CREATE INDEX IF NOT EXISTS "PostmanExecution_environmentId_createdAt_idx"
  ON "public"."PostmanExecution"("environmentId", "createdAt");
CREATE INDEX IF NOT EXISTS "PostmanExecution_actorUserId_createdAt_idx"
  ON "public"."PostmanExecution"("actorUserId", "createdAt");
CREATE INDEX IF NOT EXISTS "PostmanExecution_threadId_idx"
  ON "public"."PostmanExecution"("threadId");

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PostmanExecution_environmentId_fkey' AND conrelid = '"public"."PostmanExecution"'::regclass) THEN
    ALTER TABLE "public"."PostmanExecution" ADD CONSTRAINT "PostmanExecution_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PostmanExecution_agentId_fkey' AND conrelid = '"public"."PostmanExecution"'::regclass) THEN
    ALTER TABLE "public"."PostmanExecution" ADD CONSTRAINT "PostmanExecution_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PostmanExecution_templateId_fkey' AND conrelid = '"public"."PostmanExecution"'::regclass) THEN
    ALTER TABLE "public"."PostmanExecution" ADD CONSTRAINT "PostmanExecution_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "public"."PostmanTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PostmanExecution_actorUserId_fkey' AND conrelid = '"public"."PostmanExecution"'::regclass) THEN
    ALTER TABLE "public"."PostmanExecution" ADD CONSTRAINT "PostmanExecution_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PostmanExecution_simulatedEndUserId_fkey' AND conrelid = '"public"."PostmanExecution"'::regclass) THEN
    ALTER TABLE "public"."PostmanExecution" ADD CONSTRAINT "PostmanExecution_simulatedEndUserId_fkey" FOREIGN KEY ("simulatedEndUserId") REFERENCES "public"."EndUser"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PostmanExecution_threadId_fkey' AND conrelid = '"public"."PostmanExecution"'::regclass) THEN
    ALTER TABLE "public"."PostmanExecution" ADD CONSTRAINT "PostmanExecution_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."Thread"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PostmanExecution_turnId_fkey' AND conrelid = '"public"."PostmanExecution"'::regclass) THEN
    ALTER TABLE "public"."PostmanExecution" ADD CONSTRAINT "PostmanExecution_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "public"."Turn"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PostmanExecution_requestFingerprint_check' AND conrelid = '"public"."PostmanExecution"'::regclass) THEN
    ALTER TABLE "public"."PostmanExecution" ADD CONSTRAINT "PostmanExecution_requestFingerprint_check" CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PostmanExecution_contextHandle_check' AND conrelid = '"public"."PostmanExecution"'::regclass) THEN
    ALTER TABLE "public"."PostmanExecution" ADD CONSTRAINT "PostmanExecution_contextHandle_check" CHECK ("contextHandle" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') NOT VALID;
  END IF;
END
$migration$;

ALTER TABLE "public"."PostmanExecution" VALIDATE CONSTRAINT "PostmanExecution_environmentId_fkey";
ALTER TABLE "public"."PostmanExecution" VALIDATE CONSTRAINT "PostmanExecution_agentId_fkey";
ALTER TABLE "public"."PostmanExecution" VALIDATE CONSTRAINT "PostmanExecution_templateId_fkey";
ALTER TABLE "public"."PostmanExecution" VALIDATE CONSTRAINT "PostmanExecution_actorUserId_fkey";
ALTER TABLE "public"."PostmanExecution" VALIDATE CONSTRAINT "PostmanExecution_simulatedEndUserId_fkey";
ALTER TABLE "public"."PostmanExecution" VALIDATE CONSTRAINT "PostmanExecution_threadId_fkey";
ALTER TABLE "public"."PostmanExecution" VALIDATE CONSTRAINT "PostmanExecution_turnId_fkey";
ALTER TABLE "public"."PostmanExecution" VALIDATE CONSTRAINT "PostmanExecution_requestFingerprint_check";
ALTER TABLE "public"."PostmanExecution" VALIDATE CONSTRAINT "PostmanExecution_contextHandle_check";

-- Thread fork history is empty for every pre-fork Thread. Add the fields in
-- nullable form, backfill the deterministic empty history, then constrain it.
ALTER TABLE "public"."Thread"
  ADD COLUMN IF NOT EXISTS "forkedUpToTurnId" UUID,
  ADD COLUMN IF NOT EXISTS "forkedTurnIds" UUID[];
UPDATE "public"."Thread" SET "forkedTurnIds" = ARRAY[]::UUID[] WHERE "forkedTurnIds" IS NULL;
ALTER TABLE "public"."Thread" ALTER COLUMN "forkedTurnIds" SET DEFAULT ARRAY[]::UUID[];
ALTER TABLE "public"."Thread" ALTER COLUMN "forkedTurnIds" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "Thread_forkedUpToTurnId_idx" ON "public"."Thread"("forkedUpToTurnId");
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Thread_forkedUpToTurnId_fkey' AND conrelid = '"public"."Thread"'::regclass) THEN
    ALTER TABLE "public"."Thread" ADD CONSTRAINT "Thread_forkedUpToTurnId_fkey" FOREIGN KEY ("forkedUpToTurnId") REFERENCES "public"."Turn"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
END
$migration$;
ALTER TABLE "public"."Thread" VALIDATE CONSTRAINT "Thread_forkedUpToTurnId_fkey";

-- Attachment ownership is derivable only from an already-bound canonical Turn.
-- Refuse unattached, missing, cross-scope, or conflicting legacy rows instead of
-- selecting an Agent or Thread from the wider Environment.
ALTER TABLE "public"."MessageAttachment"
  ADD COLUMN IF NOT EXISTS "agentId" UUID,
  ADD COLUMN IF NOT EXISTS "threadId" UUID;

UPDATE "public"."MessageAttachment" attachment
SET "threadId" = thread_row.id,
    "agentId" = thread_row."agentId"
FROM "public"."Turn" turn_row
JOIN "public"."Thread" thread_row ON thread_row.id = turn_row."threadId"
JOIN "public"."Agent" agent ON agent.id = thread_row."agentId"
JOIN "public"."Project" project ON project.id = agent."projectId"
JOIN "public"."Environment" environment ON environment."projectId" = project.id
JOIN "public"."EndUser" end_user ON end_user."organizationId" = project."organizationId"
WHERE attachment."turnId" = turn_row.id
  AND (attachment."threadId" IS NULL OR attachment."agentId" IS NULL)
  AND environment.id = attachment."environmentId"
  AND thread_row."environmentId" = environment.id
  AND end_user.id = attachment."endUserId"
  AND thread_row."endUserId" = end_user.id;

ALTER TABLE "public"."MessageAttachment" ALTER COLUMN "agentId" SET NOT NULL;
ALTER TABLE "public"."MessageAttachment" ALTER COLUMN "threadId" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "MessageAttachment_agentId_threadId_createdAt_idx" ON "public"."MessageAttachment"("agentId", "threadId", "createdAt");
CREATE INDEX IF NOT EXISTS "MessageAttachment_threadId_turnId_idx" ON "public"."MessageAttachment"("threadId", "turnId");
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MessageAttachment_agentId_fkey' AND conrelid = '"public"."MessageAttachment"'::regclass) THEN
    ALTER TABLE "public"."MessageAttachment" ADD CONSTRAINT "MessageAttachment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MessageAttachment_threadId_fkey' AND conrelid = '"public"."MessageAttachment"'::regclass) THEN
    ALTER TABLE "public"."MessageAttachment" ADD CONSTRAINT "MessageAttachment_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
END
$migration$;
ALTER TABLE "public"."MessageAttachment" VALIDATE CONSTRAINT "MessageAttachment_agentId_fkey";
ALTER TABLE "public"."MessageAttachment" VALIDATE CONSTRAINT "MessageAttachment_threadId_fkey";

-- Legacy EntityToolPolicy rows were project-wide. Derive an Environment only
-- when exactly one tenant-correct EnvironmentEntityTool mapping owns the same
-- Entity/Tool pair. Zero or multiple candidates require operator remediation.
ALTER TABLE "public"."EntityToolPolicy" ADD COLUMN IF NOT EXISTS "environmentId" UUID;

WITH owners AS (
  SELECT policy.id, min(environment.id::TEXT)::UUID AS "environmentId"
  FROM "public"."EntityToolPolicy" policy
  JOIN "public"."Entity" entity ON entity.id = policy."entityId"
  JOIN "public"."EnvironmentEntityTool" mapping
    ON mapping."entityId" = policy."entityId" AND mapping."toolId" = policy."toolId"
  JOIN "public"."Environment" environment
    ON environment.id = mapping."environmentId" AND environment."projectId" = entity."projectId"
  WHERE policy."environmentId" IS NULL
  GROUP BY policy.id
  HAVING count(DISTINCT environment.id) = 1
)
UPDATE "public"."EntityToolPolicy" policy
SET "environmentId" = owners."environmentId"::UUID
FROM owners
WHERE policy.id = owners.id;

ALTER TABLE "public"."EntityToolPolicy" ALTER COLUMN "environmentId" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "EntityToolPolicy_environmentId_entityId_toolId_key"
  ON "public"."EntityToolPolicy"("environmentId", "entityId", "toolId");
DROP INDEX IF EXISTS "public"."EntityToolPolicy_entityId_toolId_key";
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EntityToolPolicy_environmentId_fkey' AND conrelid = '"public"."EntityToolPolicy"'::regclass) THEN
    ALTER TABLE "public"."EntityToolPolicy" ADD CONSTRAINT "EntityToolPolicy_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
END
$migration$;
ALTER TABLE "public"."EntityToolPolicy" VALIDATE CONSTRAINT "EntityToolPolicy_environmentId_fkey";

CREATE OR REPLACE FUNCTION "public"."prevent_postman_execution_attribution_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."environmentId" IS DISTINCT FROM OLD."environmentId"
     OR NEW."agentId" IS DISTINCT FROM OLD."agentId"
     OR NEW."requestId" IS DISTINCT FROM OLD."requestId"
     OR NEW."requestFingerprint" IS DISTINCT FROM OLD."requestFingerprint"
     OR NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId"
     OR NEW."contextHandle" IS DISTINCT FROM OLD."contextHandle"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'PostmanExecution forensic attribution is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "public"."enforce_message_attachment_binding_transition"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."turnId" IS NOT NULL AND NEW."turnId" IS DISTINCT FROM OLD."turnId" THEN
    RAISE EXCEPTION 'MessageAttachment turn binding is one-way and immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- These four branches are the complete integrated enforce_domain_ancestry
-- delta. Keeping them in a forward-only function avoids rewriting the large
-- function installed by the already-applied initial migration.
CREATE OR REPLACE FUNCTION "public"."enforce_m4_forward_upgrade_ancestry"()
RETURNS TRIGGER AS $$
DECLARE
  valid BOOLEAN := FALSE;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'PostmanExecution' THEN
      SELECT EXISTS (
        SELECT 1 FROM "Environment" environment
        JOIN "Project" project ON project.id = environment."projectId"
        JOIN "Agent" agent ON agent.id = NEW."agentId" AND agent."projectId" = project.id
        JOIN "User" actor ON actor.id = NEW."actorUserId"
        LEFT JOIN "PostmanTemplate" template ON template.id = NEW."templateId"
          AND template."environmentId" = environment.id AND template."agentId" = agent.id
        LEFT JOIN "EndUser" simulated ON simulated.id = NEW."simulatedEndUserId"
          AND simulated."organizationId" = project."organizationId"
        LEFT JOIN "Thread" thread_row ON thread_row.id = NEW."threadId"
          AND thread_row."environmentId" = environment.id AND thread_row."agentId" = agent.id
          AND (NEW."simulatedEndUserId" IS NULL OR thread_row."endUserId" = NEW."simulatedEndUserId")
        LEFT JOIN "Turn" turn_row ON turn_row.id = NEW."turnId" AND turn_row."threadId" = thread_row.id
        WHERE environment.id = NEW."environmentId"
          AND (NEW."templateId" IS NULL OR template.id IS NOT NULL)
          AND (NEW."simulatedEndUserId" IS NULL OR simulated.id IS NOT NULL)
          AND (NEW."threadId" IS NULL OR thread_row.id IS NOT NULL)
          AND (NEW."turnId" IS NULL OR turn_row.id IS NOT NULL)
      ) INTO valid;
    WHEN 'Thread' THEN
      SELECT EXISTS (
        SELECT 1 FROM "Environment" environment
        JOIN "Project" project ON project.id = environment."projectId"
        JOIN "Agent" agent ON agent.id = NEW."agentId" AND agent."projectId" = project.id
        JOIN "EndUser" end_user ON end_user.id = NEW."endUserId" AND end_user."organizationId" = project."organizationId"
        LEFT JOIN "AgentCluster" cluster ON cluster.id = NEW."clusterId" AND cluster."environmentId" = environment.id
        LEFT JOIN "Thread" parent ON parent.id = NEW."parentThreadId" AND parent."environmentId" = environment.id AND parent."endUserId" = end_user.id AND parent."agentId" = agent.id
        LEFT JOIN "Turn" fork_boundary ON fork_boundary.id = NEW."forkedUpToTurnId"
          AND (fork_boundary."threadId" = parent.id OR fork_boundary.id = ANY(parent."forkedTurnIds"))
        LEFT JOIN "Turn" cursor ON cursor.id = NEW."compactedUpToTurnId" AND cursor."threadId" = NEW.id
        WHERE environment.id = NEW."environmentId"
          AND (NEW."clusterId" IS NULL OR cluster.id IS NOT NULL)
          AND (NEW."parentThreadId" IS NULL OR parent.id IS NOT NULL)
          AND (
            cardinality(NEW."forkedTurnIds") = 0 AND NEW."forkedUpToTurnId" IS NULL
            OR parent.id IS NOT NULL
              AND fork_boundary.id IS NOT NULL
              AND NEW."forkedUpToTurnId" = NEW."forkedTurnIds"[cardinality(NEW."forkedTurnIds")]
              AND cardinality(NEW."forkedTurnIds") = (SELECT count(DISTINCT forked_id) FROM unnest(NEW."forkedTurnIds") AS forked_id)
              AND NOT EXISTS (
                SELECT 1 FROM unnest(NEW."forkedTurnIds") AS forked_id
                LEFT JOIN "Turn" inherited_turn ON inherited_turn.id = forked_id
                  AND (inherited_turn."threadId" = parent.id OR inherited_turn.id = ANY(parent."forkedTurnIds"))
                WHERE inherited_turn.id IS NULL
              )
          )
          AND (NEW."compactedUpToTurnId" IS NULL OR cursor.id IS NOT NULL)
      ) INTO valid;
    WHEN 'MessageAttachment' THEN
      SELECT EXISTS (
        SELECT 1 FROM "Environment" environment
        JOIN "Project" project ON project.id = environment."projectId"
        JOIN "EndUser" end_user ON end_user.id = NEW."endUserId" AND end_user."organizationId" = project."organizationId"
        JOIN "Agent" agent ON agent.id = NEW."agentId" AND agent."projectId" = project.id
        JOIN "Thread" thread_row ON thread_row.id = NEW."threadId" AND thread_row."environmentId" = environment.id AND thread_row."endUserId" = end_user.id AND thread_row."agentId" = agent.id
        LEFT JOIN "Turn" turn_row ON turn_row.id = NEW."turnId" AND turn_row."threadId" = thread_row.id
        WHERE environment.id = NEW."environmentId" AND (NEW."turnId" IS NULL OR turn_row.id IS NOT NULL)
      ) INTO valid;
    WHEN 'EntityToolPolicy' THEN
      SELECT EXISTS (
        SELECT 1 FROM "Environment" environment
        JOIN "Entity" entity ON entity."projectId" = environment."projectId"
        WHERE environment.id = NEW."environmentId" AND entity.id = NEW."entityId"
      ) INTO valid;
    ELSE
      RAISE EXCEPTION 'Unsupported M4 ancestry table %', TG_TABLE_NAME USING ERRCODE = '23514';
  END CASE;

  IF NOT valid THEN
    RAISE EXCEPTION '% crosses its canonical owner ancestry', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Thread_owner_immutable" ON "public"."Thread";
CREATE TRIGGER "Thread_owner_immutable" BEFORE UPDATE ON "public"."Thread" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('environmentId', 'parentThreadId', 'forkedUpToTurnId', 'forkedTurnIds');
DROP TRIGGER IF EXISTS "MessageAttachment_owner_immutable" ON "public"."MessageAttachment";
CREATE TRIGGER "MessageAttachment_owner_immutable" BEFORE UPDATE ON "public"."MessageAttachment" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('environmentId', 'endUserId', 'agentId', 'threadId');

DROP TRIGGER IF EXISTS "PostmanExecution_ancestry" ON "public"."PostmanExecution";
CREATE TRIGGER "PostmanExecution_ancestry" BEFORE INSERT OR UPDATE ON "public"."PostmanExecution" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_m4_forward_upgrade_ancestry"();
DROP TRIGGER IF EXISTS "PostmanExecution_attribution_immutable" ON "public"."PostmanExecution";
CREATE TRIGGER "PostmanExecution_attribution_immutable" BEFORE UPDATE ON "public"."PostmanExecution" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_postman_execution_attribution_mutation"();
DROP TRIGGER IF EXISTS "Thread_ancestry" ON "public"."Thread";
CREATE TRIGGER "Thread_ancestry" BEFORE INSERT OR UPDATE ON "public"."Thread" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_m4_forward_upgrade_ancestry"();
DROP TRIGGER IF EXISTS "MessageAttachment_ancestry" ON "public"."MessageAttachment";
CREATE TRIGGER "MessageAttachment_ancestry" BEFORE INSERT OR UPDATE ON "public"."MessageAttachment" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_m4_forward_upgrade_ancestry"();
DROP TRIGGER IF EXISTS "MessageAttachment_binding_one_way" ON "public"."MessageAttachment";
CREATE TRIGGER "MessageAttachment_binding_one_way" BEFORE UPDATE ON "public"."MessageAttachment" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_message_attachment_binding_transition"();
DROP TRIGGER IF EXISTS "EntityToolPolicy_ancestry" ON "public"."EntityToolPolicy";
CREATE TRIGGER "EntityToolPolicy_ancestry" BEFORE INSERT OR UPDATE ON "public"."EntityToolPolicy" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_m4_forward_upgrade_ancestry"();

COMMIT;
