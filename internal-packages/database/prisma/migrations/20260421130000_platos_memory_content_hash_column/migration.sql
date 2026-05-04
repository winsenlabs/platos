-- EOBD.46 — add contentHash column for extractor dedupe. Nullable so
-- legacy rows stay valid; new extractor writes always populate it.

ALTER TABLE "public"."PlatosMemory"
  ADD COLUMN IF NOT EXISTS "contentHash" TEXT;
