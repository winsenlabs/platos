-- PIFSP-3: customParams was a JSON blob injected into every tool call.
-- Superseded by per-agent "MCP arguments" (PIFSP Agent-config ticket).
-- Safe: the runtime code path that READ customParams is deleted in the
-- same release; any stored values just become dead weight, and then this
-- column vanishes.
ALTER TABLE "PlatosConnectedEntity" DROP COLUMN IF EXISTS "customParams";
