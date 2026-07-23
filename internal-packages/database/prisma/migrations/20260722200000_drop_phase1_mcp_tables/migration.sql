-- ═══════════════════════════════════════════════════════════════════════════════
-- Drop the superseded Phase-1 native-MCP-consumption tables.
--
-- These are replaced by the connected-entity model: an external MCP server is now
-- a PlatosConnectedEntity (connectionKind='mcp') whose transport lives on the 1:1
-- PlatosEntityMcpClient, and whose tools flow through the shared
-- PlatosToolDefinition + PlatosEntityToolMapping matrix. The Phase-1 subsystem
-- was never wired to the turn loop, so these tables are empty in every
-- environment (verified 0/0/0 on the live database at authoring time).
--
-- GUARD: this migration RAISES (aborting the deploy) unless ALL THREE tables are
-- empty, so a non-empty prod can never be silently dropped — data-migrate the
-- rows onto PlatosConnectedEntity + PlatosEntityMcpClient first.
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public."PlatosMCPServer"') IS NOT NULL
     AND (
       (SELECT count(*) FROM "PlatosMCPServer") <> 0
       OR (SELECT count(*) FROM "PlatosMCPServerTool") <> 0
       OR (SELECT count(*) FROM "PlatosAgentMCPBinding") <> 0
     ) THEN
    RAISE EXCEPTION
      'Refusing to drop Phase-1 MCP tables: at least one of PlatosMCPServer / PlatosMCPServerTool / PlatosAgentMCPBinding is non-empty (expected 0/0/0). Data-migrate to PlatosConnectedEntity + PlatosEntityMcpClient first.';
  END IF;
END $$;

-- Children (FK -> PlatosMCPServer, ON DELETE CASCADE) before the parent.
DROP TABLE IF EXISTS "PlatosAgentMCPBinding";
DROP TABLE IF EXISTS "PlatosMCPServerTool";
DROP TABLE IF EXISTS "PlatosMCPServer";
