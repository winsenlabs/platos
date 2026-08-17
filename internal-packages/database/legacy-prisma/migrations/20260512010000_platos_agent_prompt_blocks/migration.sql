-- PlatosAgent.promptBlocks — schema/migration drift fix.
--
-- The column was declared in schema.prisma (`promptBlocks Json?`) but no
-- migration was ever generated, so a fresh `prisma migrate deploy` against
-- a clean Postgres leaves the column missing. The dashboard renders the
-- agent-creation form against this column; without it, agents_create
-- fails with `column "promptBlocks" does not exist`.
--
-- Idempotent ADD COLUMN keeps existing dev databases (where the column
-- was created via `prisma db push` instead of a migration) happy.

ALTER TABLE "PlatosAgent" ADD COLUMN IF NOT EXISTS "promptBlocks" JSONB;

-- Same drift on PlatosAgentVersion (snapshot of an agent's config — has
-- to mirror PlatosAgent's column set).
ALTER TABLE "PlatosAgentVersion" ADD COLUMN IF NOT EXISTS "promptBlocks" JSONB;
