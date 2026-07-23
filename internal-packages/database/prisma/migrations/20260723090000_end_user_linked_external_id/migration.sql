-- IDENTITY-CORE §A.1 — externalId adoption representation.
--
-- Adds PlatosEndUser.linkedExternalId: the ADOPTED external id (e.g. the Walle
-- DB user id = Composio `user_id`). When set, the resolver PREFERS it over
-- externalUserId as the substituted `{{endUserId}}`. NULL means "fall back to
-- externalUserId", i.e. byte-for-byte today's behaviour for every existing row.
--
-- The scoped @@unique is NULL-distinct in Postgres (default), so the many
-- un-adopted (NULL) rows coexist freely, while two persons in one
-- (org, project, env) scope can never claim the same Composio `user_id`. The
-- adoption op (`end_users.bind_external_id`) handles a cross-person collision
-- explicitly (`external_id_conflict`) rather than letting Prisma throw.
--
-- Additive, NO backfill — every existing row keeps linkedExternalId = NULL.
-- All statements use IF NOT EXISTS so the migration is idempotent on a database
-- carrying partial state (branch juggling / direct-psql apply on the deploy
-- target).

ALTER TABLE "public"."PlatosEndUser"
    ADD COLUMN IF NOT EXISTS "linkedExternalId" TEXT;

-- Index name matches EXACTLY the explicit `map:` on the @@unique so Prisma does
-- not report schema drift. Postgres treats NULLs as distinct in a UNIQUE index,
-- so this constrains only rows that have actually adopted an external id.
CREATE UNIQUE INDEX IF NOT EXISTS "platos_end_user_scope_linked_ext_uniq"
    ON "public"."PlatosEndUser"("organizationId", "projectId", "environmentId", "linkedExternalId");
