-- EOBD.44 — Admin-action audit log.
-- One row per destructive admin operation. Scope-stamped + indexed for
-- cheap /admin-audit dashboards.

CREATE TABLE IF NOT EXISTS "public"."PlatosAdminAudit" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "environmentId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "action" TEXT NOT NULL,
  "subjectType" TEXT NOT NULL,
  "subjectId" TEXT,
  "beforeJson" JSONB,
  "afterJson" JSONB,
  "reason" TEXT,
  "source" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PlatosAdminAudit_pkey" PRIMARY KEY ("id")
);

-- Environment FK (cascade — scope cleanup removes audit rows too).
ALTER TABLE "public"."PlatosAdminAudit"
  ADD CONSTRAINT "PlatosAdminAudit_environmentId_fkey"
    FOREIGN KEY ("environmentId")
    REFERENCES "public"."RuntimeEnvironment"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "platos_admin_audit_scope_createdAt_idx"
  ON "public"."PlatosAdminAudit" ("organizationId", "projectId", "environmentId", "createdAt" DESC);

CREATE INDEX "platos_admin_audit_scope_action_idx"
  ON "public"."PlatosAdminAudit" ("organizationId", "projectId", "environmentId", "action");

CREATE INDEX "platos_admin_audit_scope_subject_idx"
  ON "public"."PlatosAdminAudit" ("organizationId", "projectId", "environmentId", "subjectType", "subjectId");

CREATE INDEX "platos_admin_audit_scope_actor_idx"
  ON "public"."PlatosAdminAudit" ("organizationId", "projectId", "environmentId", "actorUserId");
