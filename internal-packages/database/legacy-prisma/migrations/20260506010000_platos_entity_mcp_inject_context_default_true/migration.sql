-- MCPF-followup: flip `injectMcpContext` default from false → true for
-- newly-created PlatosEntityMcpConfig rows.
--
-- Architectural intent: Platos always injects a `_context` envelope into
-- entity tool calls; the SDK (platools-py / @platools/sdk) pops the
-- envelope before the user handler runs. New entities should follow this
-- contract by default — opt-out is for legacy backends that don't yet
-- ship a recent SDK.
--
-- IMPORTANT: this migration does NOT backfill existing rows. Existing
-- entities (e.g. the live Winsen entity) keep `injectMcpContext = false`
-- so their currently-deployed backends don't break. Operators flip the
-- column to true manually after redeploying with a SDK version that pops
-- `_context` (platools >= 0.2.0 / @platools/sdk >= 0.2.0).

ALTER TABLE "PlatosEntityMcpConfig"
  ALTER COLUMN "injectMcpContext" SET DEFAULT true;
