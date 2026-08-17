-- Dedicated hash-only PAT and MCP token lifecycle evidence.
-- This table intentionally contains token row references and scope metadata only.
CREATE TYPE "public"."TokenFamily" AS ENUM ('PERSONAL_ACCESS_TOKEN', 'MCP_TOKEN');
CREATE TYPE "public"."TokenLifecycleAction" AS ENUM ('MINT', 'USE', 'REVOKE');
CREATE TYPE "public"."TokenLifecycleOutcome" AS ENUM ('SUCCESS');

CREATE TABLE "public"."TokenLifecycleAudit" (
  "id" UUID NOT NULL,
  "family" "public"."TokenFamily" NOT NULL,
  "personalAccessTokenId" UUID,
  "mcpTokenId" UUID,
  "scopeKind" "public"."AuthorizationScopeKind" NOT NULL,
  "organizationId" UUID,
  "projectId" UUID,
  "environmentId" UUID,
  "actorUserId" UUID NOT NULL,
  "action" "public"."TokenLifecycleAction" NOT NULL,
  "outcome" "public"."TokenLifecycleOutcome" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TokenLifecycleAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TokenLifecycleAudit_reference_shape_check" CHECK (
    ("family" = 'PERSONAL_ACCESS_TOKEN' AND "personalAccessTokenId" IS NOT NULL AND "mcpTokenId" IS NULL) OR
    ("family" = 'MCP_TOKEN' AND "personalAccessTokenId" IS NULL AND "mcpTokenId" IS NOT NULL)
  ),
  CONSTRAINT "TokenLifecycleAudit_scope_shape_check" CHECK (
    (
      "family" = 'PERSONAL_ACCESS_TOKEN' AND (
        ("scopeKind" = 'GLOBAL' AND "organizationId" IS NULL AND "projectId" IS NULL AND "environmentId" IS NULL) OR
        ("scopeKind" = 'ORGANIZATION' AND "organizationId" IS NOT NULL AND "projectId" IS NULL AND "environmentId" IS NULL) OR
        ("scopeKind" = 'PROJECT' AND "organizationId" IS NULL AND "projectId" IS NOT NULL AND "environmentId" IS NULL) OR
        ("scopeKind" = 'ENVIRONMENT' AND "organizationId" IS NULL AND "projectId" IS NULL AND "environmentId" IS NOT NULL)
      )
    ) OR (
      "family" = 'MCP_TOKEN' AND "scopeKind" = 'ENVIRONMENT' AND
      "organizationId" IS NULL AND "projectId" IS NULL AND "environmentId" IS NOT NULL
    )
  )
);

CREATE INDEX "TokenLifecycleAudit_personalAccessTokenId_createdAt_idx"
  ON "public"."TokenLifecycleAudit"("personalAccessTokenId", "createdAt");
CREATE INDEX "TokenLifecycleAudit_mcpTokenId_createdAt_idx"
  ON "public"."TokenLifecycleAudit"("mcpTokenId", "createdAt");
CREATE INDEX "TokenLifecycleAudit_actorUserId_createdAt_idx"
  ON "public"."TokenLifecycleAudit"("actorUserId", "createdAt");
CREATE INDEX "TokenLifecycleAudit_organizationId_createdAt_idx"
  ON "public"."TokenLifecycleAudit"("organizationId", "createdAt");
CREATE INDEX "TokenLifecycleAudit_projectId_createdAt_idx"
  ON "public"."TokenLifecycleAudit"("projectId", "createdAt");
CREATE INDEX "TokenLifecycleAudit_environmentId_createdAt_idx"
  ON "public"."TokenLifecycleAudit"("environmentId", "createdAt");
CREATE INDEX "TokenLifecycleAudit_family_action_outcome_createdAt_idx"
  ON "public"."TokenLifecycleAudit"("family", "action", "outcome", "createdAt");

ALTER TABLE "public"."TokenLifecycleAudit"
  ADD CONSTRAINT "TokenLifecycleAudit_personalAccessTokenId_fkey"
  FOREIGN KEY ("personalAccessTokenId") REFERENCES "public"."PersonalAccessToken"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."TokenLifecycleAudit"
  ADD CONSTRAINT "TokenLifecycleAudit_mcpTokenId_fkey"
  FOREIGN KEY ("mcpTokenId") REFERENCES "public"."McpToken"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."TokenLifecycleAudit"
  ADD CONSTRAINT "TokenLifecycleAudit_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."TokenLifecycleAudit"
  ADD CONSTRAINT "TokenLifecycleAudit_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."TokenLifecycleAudit"
  ADD CONSTRAINT "TokenLifecycleAudit_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."TokenLifecycleAudit"
  ADD CONSTRAINT "TokenLifecycleAudit_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "public"."User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "public"."enforce_token_lifecycle_audit_scope"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."family" = 'PERSONAL_ACCESS_TOKEN' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "public"."PersonalAccessToken" token
      WHERE token.id = NEW."personalAccessTokenId"
        AND token."scopeKind" = NEW."scopeKind"
        AND token."organizationId" IS NOT DISTINCT FROM NEW."organizationId"
        AND token."projectId" IS NOT DISTINCT FROM NEW."projectId"
        AND token."environmentId" IS NOT DISTINCT FROM NEW."environmentId"
    ) THEN
      RAISE EXCEPTION 'TokenLifecycleAudit PAT scope must match its persisted token scope'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."family" = 'MCP_TOKEN' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "public"."McpToken" token
      WHERE token.id = NEW."mcpTokenId"
        AND token."environmentId" = NEW."environmentId"
    ) THEN
      RAISE EXCEPTION 'TokenLifecycleAudit MCP scope must match its persisted Environment'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TokenLifecycleAudit_scope_match"
  BEFORE INSERT ON "public"."TokenLifecycleAudit"
  FOR EACH ROW EXECUTE FUNCTION "public"."enforce_token_lifecycle_audit_scope"();

CREATE FUNCTION "public"."reject_token_lifecycle_audit_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'TokenLifecycleAudit is immutable' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TokenLifecycleAudit_immutable_update"
  BEFORE UPDATE ON "public"."TokenLifecycleAudit"
  FOR EACH ROW EXECUTE FUNCTION "public"."reject_token_lifecycle_audit_mutation"();
CREATE TRIGGER "TokenLifecycleAudit_immutable_delete"
  BEFORE DELETE ON "public"."TokenLifecycleAudit"
  FOR EACH ROW EXECUTE FUNCTION "public"."reject_token_lifecycle_audit_mutation"();
CREATE TRIGGER "TokenLifecycleAudit_immutable_truncate"
  BEFORE TRUNCATE ON "public"."TokenLifecycleAudit"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."reject_token_lifecycle_audit_mutation"();

REVOKE UPDATE, DELETE, TRUNCATE
ON TABLE "public"."TokenLifecycleAudit"
FROM PUBLIC;
