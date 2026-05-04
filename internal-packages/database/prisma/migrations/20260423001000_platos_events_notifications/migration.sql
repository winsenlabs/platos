-- Theme K.15 — MCP events: subscribe + notifications routing.
--
-- Two new tables:
--   PlatosEvent               — immutable event log, scoped. Feeds SSE
--                                subscribers + persistent rule matcher.
--   PlatosNotificationRule    — operator-defined routing rules (Slack /
--                                email / PagerDuty / webhook).
--
-- Both indexes are declared inline since the tables are brand-new and
-- have no pre-existing data (CONCURRENTLY is not required for fresh
-- tables per .claude/rules/database-safety.md).

-- ═══ PlatosEvent ═══
CREATE TABLE IF NOT EXISTS "public"."PlatosEvent" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "projectId"      TEXT NOT NULL,
  "environmentId"  TEXT NOT NULL,
  "eventType"      TEXT NOT NULL,
  "subjectId"      TEXT,
  "payload"        JSONB NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatosEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platos_event_scope_created_idx"
  ON "public"."PlatosEvent" ("organizationId", "projectId", "environmentId", "createdAt");
CREATE INDEX "platos_event_type_created_idx"
  ON "public"."PlatosEvent" ("eventType", "createdAt");

ALTER TABLE "public"."PlatosEvent"
  ADD CONSTRAINT "PlatosEvent_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══ PlatosNotificationRule ═══
CREATE TABLE IF NOT EXISTS "public"."PlatosNotificationRule" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "projectId"      TEXT NOT NULL,
  "environmentId"  TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "filters"        JSONB NOT NULL,
  "delivery"       JSONB NOT NULL,
  "enabled"        BOOLEAN NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  "createdBy"      TEXT NOT NULL,
  CONSTRAINT "PlatosNotificationRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platos_notification_rule_scope_idx"
  ON "public"."PlatosNotificationRule" ("organizationId", "projectId", "environmentId");

ALTER TABLE "public"."PlatosNotificationRule"
  ADD CONSTRAINT "PlatosNotificationRule_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
