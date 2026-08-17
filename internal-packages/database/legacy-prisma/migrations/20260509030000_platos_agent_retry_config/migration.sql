-- LAUNCH-2 — per-agent declarative retry/fallback waterfall config.
ALTER TABLE "PlatosAgent" ADD COLUMN IF NOT EXISTS "agentRetryConfig" JSONB;
