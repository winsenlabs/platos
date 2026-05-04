-- EOBD.25 — composite index on pre-existing PlatosAgentMessage(threadId, status).
-- CONCURRENTLY required (pre-existing table).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "PlatosAgentMessage_threadId_status_idx"
    ON "public"."PlatosAgentMessage"("threadId", "status");
