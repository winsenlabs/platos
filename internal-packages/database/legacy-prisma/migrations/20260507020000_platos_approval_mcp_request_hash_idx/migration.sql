-- MCP approval-UI — index for the (scope, requestHash) idempotency
-- lookup used by the Platform MCP router when deciding whether a
-- pending approval already exists for the same call. CONCURRENTLY +
-- IF NOT EXISTS so we don't lock the table on existing deployments.
--
-- Per .claude/rules/database-safety.md, CONCURRENT indexes must live
-- in their own migration file separate from the column add (the
-- preceding `20260507010000_platos_approval_mcp_columns` migration).

CREATE INDEX CONCURRENTLY IF NOT EXISTS "platos_approval_scope_requestHash_idx"
  ON "PlatosAgentApproval" ("organizationId", "projectId", "environmentId", "requestHash");
