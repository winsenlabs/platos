-- +goose Up
-- WIN-144 / WIN-150: move the inherited analytics namespace without
-- rewriting the 33 migrations that have already been applied in production.
RENAME DATABASE trigger_dev TO platos_telemetry;

-- +goose Down
-- Rollback is the inverse metadata rename. Atomic-database table UUIDs and
-- their data parts remain unchanged in either direction.
RENAME DATABASE platos_telemetry TO trigger_dev;
