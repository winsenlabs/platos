-- PRA-TC.1b: Add threading config to PlatosAgent.
-- enableThreading: opt-in toggle, default false (no UI shown when off).
-- threadingConfig: JSON shape { maxDepth: 1, showReplyCount: true, defaultThreadOpen: false }

ALTER TABLE "PlatosAgent"
  ADD COLUMN IF NOT EXISTS "enableThreading"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "threadingConfig"  JSONB;
