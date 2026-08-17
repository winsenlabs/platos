-- Theme K.15 — tier-3 per-agent MCP permission overrides.
-- Map of tool-name → "auto_allow" | "require_approval" | "block".
-- Null = no overrides (tiers 1/2/4 alone).

ALTER TABLE "public"."PlatosAgent"
  ADD COLUMN IF NOT EXISTS "mcpPermissions" JSONB;
