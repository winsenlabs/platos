-- Theme M.1 — add `confidence` column to PlatosMemory. Nullable so legacy
-- rows stay valid; the M.2 writer always populates it and the M.5 reader
-- treats NULL as "unweighted" (cosine + recency ranking fallback).

ALTER TABLE "public"."PlatosMemory"
  ADD COLUMN IF NOT EXISTS "confidence" DOUBLE PRECISION;
