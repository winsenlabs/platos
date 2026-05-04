-- EOBD.25 — index on pre-existing PlatosAgentThread(parentThreadId).
-- Must use CREATE INDEX CONCURRENTLY because PlatosAgentThread is a
-- pre-existing table (from 20260415 migration). Non-concurrent CREATE
-- INDEX acquires a SHARE lock and blocks writes for the duration.
-- Per .claude/rules/database-safety.md one index per migration file.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "PlatosAgentThread_parentThreadId_idx"
    ON "public"."PlatosAgentThread"("parentThreadId");
