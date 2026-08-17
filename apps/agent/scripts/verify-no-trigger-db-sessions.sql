\set ON_ERROR_STOP on

-- WIN-123 external Trigger writer fence.
-- Required psql variables:
--   trigger_db_role              exact legacy Trigger database role
--   trigger_application_pattern  case-insensitive application_name pattern
--
-- The deliberate invalid integer cast makes psql fail closed when any matching
-- session exists. Run continuously during maintenance; one successful sample is
-- not sufficient evidence that the writer remains fenced.
WITH trigger_sessions AS (
  SELECT pid, usename, application_name, client_addr, state
  FROM pg_stat_activity
  WHERE pid <> pg_backend_pid()
    AND datname = current_database()
    AND (
      usename = :'trigger_db_role'
      OR application_name ~* :'trigger_application_pattern'
    )
), assertion AS (
  SELECT CAST(
    CASE
      WHEN count(*) = 0 THEN '1'
      ELSE 'TRIGGER_DB_SESSIONS_PRESENT_' || count(*)::text
    END AS integer
  ) AS no_trigger_sessions
  FROM trigger_sessions
)
SELECT no_trigger_sessions FROM assertion;
