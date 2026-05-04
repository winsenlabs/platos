-- PRA-TC.1a: Add threading fields to PlatosAgentMessage.
-- threadReplyToId: self-referential FK for sub-thread replies (depth=1 enforced at app layer).
-- replyCount: cached count of replies, atomically incremented on each new reply.

ALTER TABLE "PlatosAgentMessage"
  ADD COLUMN IF NOT EXISTS "threadReplyToId" TEXT,
  ADD COLUMN IF NOT EXISTS "replyCount"      INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PlatosAgentMessage"
  ADD CONSTRAINT "PlatosAgentMessage_threadReplyToId_fkey"
  FOREIGN KEY ("threadReplyToId")
  REFERENCES "PlatosAgentMessage"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- Index for fast sub-thread fetches: all replies to a given message within a thread.
-- New column on existing table → CONCURRENTLY in its own migration (see migration _020000).
