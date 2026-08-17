-- EOBD.25 — index on pre-existing PlatosAgentMessage(parentMessageId).
-- CONCURRENTLY required (pre-existing table).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "PlatosAgentMessage_parentMessageId_idx"
    ON "public"."PlatosAgentMessage"("parentMessageId");
