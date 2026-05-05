-- +goose Up
-- Add visitor identity columns next to the hashed user_id. The agent's
-- writeSpanToClickhouse populates these from scope.sessionContext.user.*
-- (lifted from JWT userMeta by ScopeGuard) so analytics queries can
-- read name/email directly without JOINing through Postgres
-- PlatosEndUser. user_id stays as the SHA256-hashed `lead-<hash>` —
-- the dedicated columns carry plaintext PII only, separate from the
-- indexed identity column so a wipe of the PII columns leaves the
-- canonical user_id intact.

ALTER TABLE trigger_dev.platos_spans_v1
  ADD COLUMN IF NOT EXISTS user_display_name String DEFAULT '' CODEC(ZSTD(1)),
  ADD COLUMN IF NOT EXISTS user_email        String DEFAULT '' CODEC(ZSTD(1));

-- +goose Down
ALTER TABLE trigger_dev.platos_spans_v1
  DROP COLUMN IF EXISTS user_email,
  DROP COLUMN IF EXISTS user_display_name;
