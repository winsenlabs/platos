-- Theme K.17 — MCP macros (record / replay / parameterize).
--
-- Stores recorded sequences of MCP tool calls with ${var.path}
-- placeholders, replayed through the same MCP router so every step
-- re-hits the permission gate + audit + scope enforcement.

CREATE TABLE IF NOT EXISTS "public"."PlatosMacro" (
    "id"             TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId"      TEXT NOT NULL,
    "environmentId"  TEXT NOT NULL,
    "name"           TEXT NOT NULL,
    "description"    TEXT,
    "steps"          JSONB NOT NULL,
    "paramSchema"    JSONB,
    "sharedWithOrg"  BOOLEAN NOT NULL DEFAULT false,
    "createdBy"      TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosMacro_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platos_macro_scope_idx"
  ON "public"."PlatosMacro"("organizationId", "projectId", "environmentId");

CREATE INDEX "platos_macro_creator_idx"
  ON "public"."PlatosMacro"("createdBy");
