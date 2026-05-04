-- MCP approval-UI Wave 2 — extend PlatosAgentApproval with the
-- edit-first decision columns.
--
-- `editedArgs` holds the operator-modified call arguments captured at
-- resolve-time when decision = "approved_with_edits". The Platform MCP
-- router executes the tool with these instead of the original `args`,
-- and both versions are preserved so the audit trail shows the LLM's
-- proposed call AND the operator's edited version.
--
-- `editedByUserId` records who made the edit. In practice the same as
-- `respondedBy`, but kept separate so a future signing-key flow can
-- record "X approved Y's edits" without overloading `respondedBy`.
--
-- Both columns are nullable — existing rows + the approve/reject paths
-- (no edit) leave them null. `editedArgs IS NOT NULL` is the marker
-- that the operator edited the call.

ALTER TABLE "PlatosAgentApproval"
  ADD COLUMN IF NOT EXISTS "editedArgs" JSONB,
  ADD COLUMN IF NOT EXISTS "editedByUserId" TEXT;
