-- MCP approval-UI — extend PlatosAgentApproval with the columns
-- the Platform MCP `require_approval` flow needs (tool name, redacted
-- args, idempotency hash, cached resolution, consumed timestamp,
-- requesting token id).
--
-- All columns are nullable so existing waitpoint approvals (created
-- by the agent runtime via `request_approval` / `cancel_run`) continue
-- to work unchanged. Only the MCP path populates these fields.

ALTER TABLE "PlatosAgentApproval"
  ADD COLUMN IF NOT EXISTS "toolName" TEXT,
  ADD COLUMN IF NOT EXISTS "args" JSONB,
  ADD COLUMN IF NOT EXISTS "requestHash" TEXT,
  ADD COLUMN IF NOT EXISTS "resolution" JSONB,
  ADD COLUMN IF NOT EXISTS "consumedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "requestedByMcpTokenId" TEXT;
