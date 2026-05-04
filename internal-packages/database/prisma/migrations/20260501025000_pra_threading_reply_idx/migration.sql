-- PRA-TC.1b (idx): CONCURRENTLY index on PlatosAgentMessage(threadId, threadReplyToId).
-- Must be in its own file — CONCURRENTLY cannot run inside a transaction block
-- (which Prisma uses for all migration files). Separated from the ADD COLUMN migration.

CREATE INDEX IF NOT EXISTS "PlatosAgentMessage_threadId_threadReplyToId_idx"
  ON "PlatosAgentMessage" ("threadId", "threadReplyToId");
