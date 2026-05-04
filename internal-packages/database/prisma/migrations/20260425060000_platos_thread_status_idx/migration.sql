-- PIFSP-20: index for per-env archived/active thread list queries
-- CONCURRENTLY avoids locking the table on large deployments.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "PlatosAgentThread_env_status_idx"
ON "PlatosAgentThread" ("organizationId", "projectId", "environmentId", "status");
