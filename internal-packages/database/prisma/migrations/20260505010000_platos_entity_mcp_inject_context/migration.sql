-- MCPF-followup: per-entity opt-in for `_context` envelope injection.
-- Default OFF for backwards-compat with existing entities — pre-PIFSP-21
-- behavior was no envelope injection. Operators on a platools-py version
-- that handles `_context` (or wraps the handler to pop it before
-- dispatch) flip this on. CTX.2 agent-contextMapping envelope is
-- unaffected (already opt-in via the agent config).

ALTER TABLE "PlatosEntityMcpConfig"
  ADD COLUMN "injectMcpContext" BOOLEAN NOT NULL DEFAULT false;
