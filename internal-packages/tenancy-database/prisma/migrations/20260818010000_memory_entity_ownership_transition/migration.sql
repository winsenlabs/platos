-- MemoryEntity has two disjoint identity domains:
--   standalone: (environmentId, endUserId, agentId, entityKey)
--   clustered:  (environmentId, endUserId, clusterId, entityKey)
-- Keep both as partial indexes so a standalone row can be promoted in place
-- without conflicting with its own immutable agent attribution.
DROP INDEX "public"."MemoryEntity_environmentId_endUserId_agentId_entityKey_key";

CREATE UNIQUE INDEX "MemoryEntity_standalone_agent_entityKey_key"
  ON "public"."MemoryEntity"("environmentId", "endUserId", "agentId", "entityKey")
  WHERE "clusterId" IS NULL;

-- Environment, subject, and agent attribution remain immutable. The only
-- allowed ownership transition is standalone -> the Agent's currently
-- persisted Environment cluster. Cluster removal and re-parenting fail closed.
CREATE FUNCTION "public"."enforce_memory_entity_owner_transition"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."environmentId" IS DISTINCT FROM NEW."environmentId" THEN
    RAISE EXCEPTION 'MemoryEntity ownership/authorization key environmentId is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD."agentId" IS DISTINCT FROM NEW."agentId" THEN
    RAISE EXCEPTION 'MemoryEntity ownership/authorization key agentId is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD."clusterId" IS NOT DISTINCT FROM NEW."clusterId" THEN
    RETURN NEW;
  END IF;
  IF OLD."clusterId" IS NULL AND NEW."clusterId" IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "public"."AgentBinding" binding
      WHERE binding."environmentId" = NEW."environmentId"
        AND binding."agentId" = NEW."agentId"
        AND binding."clusterId" = NEW."clusterId"
    ) THEN
      RAISE EXCEPTION 'MemoryEntity cluster promotion must match the persisted Agent cluster'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM "public"."MemoryRelationship" relationship
      WHERE relationship."fromEntityId" = OLD."id"
         OR relationship."toEntityId" = OLD."id"
    ) THEN
      RAISE EXCEPTION 'MemoryEntity with existing relationships cannot change ownership scope'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'MemoryEntity cluster ownership may only promote from standalone to the persisted Agent cluster'
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER "MemoryEntity_owner_immutable" ON "public"."MemoryEntity";
CREATE TRIGGER "MemoryEntity_owner_immutable"
  BEFORE UPDATE ON "public"."MemoryEntity"
  FOR EACH ROW EXECUTE FUNCTION "public"."enforce_memory_entity_owner_transition"();
