import assert from "node:assert/strict";

export const DISPOSABLE_DATABASE_IDENTITY = Object.freeze({
  protocol: "postgresql:",
  hostname: "127.0.0.1",
  port: "55433",
  database: "platos_memory_evidence_ci",
  username: "platos_memory_evidence_ci",
  sentinelSchema: "platos_memory_evidence_guard",
  sentinelId: "win236-win237-reset-v1",
  sentinelValue: "f06d7647-1445-49c7-b77d-7cbab8f9809d",
});

export function validateDisposableDatabaseUrl(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const identity = DISPOSABLE_DATABASE_IDENTITY;
  assert.equal(parsed.protocol, identity.protocol, "evidence database protocol is not exact");
  assert.equal(
    parsed.hostname,
    identity.hostname,
    "evidence database must use exact loopback host"
  );
  assert.equal(parsed.port, identity.port, "evidence database port is not exact");
  assert.equal(parsed.pathname, `/${identity.database}`, "evidence database name is not exact");
  assert.equal(parsed.username, identity.username, "evidence database user is not exact");
  assert.equal(
    parsed.searchParams.get("schema"),
    "public",
    "evidence database schema must be public"
  );
  return parsed;
}

export function sentinelProvisionSql() {
  const identity = DISPOSABLE_DATABASE_IDENTITY;
  return `
CREATE SCHEMA IF NOT EXISTS "${identity.sentinelSchema}";
CREATE TABLE IF NOT EXISTS "${identity.sentinelSchema}"."reset_sentinel" (
  "id" text PRIMARY KEY,
  "value" text NOT NULL
);
INSERT INTO "${identity.sentinelSchema}"."reset_sentinel" ("id", "value")
VALUES ('${identity.sentinelId}', '${identity.sentinelValue}')
ON CONFLICT ("id") DO UPDATE SET "value" = EXCLUDED."value";
REVOKE ALL ON SCHEMA "${identity.sentinelSchema}" FROM PUBLIC;
REVOKE ALL ON TABLE "${identity.sentinelSchema}"."reset_sentinel" FROM PUBLIC;
`;
}

export function guardedPublicSchemaResetSql() {
  const identity = DISPOSABLE_DATABASE_IDENTITY;
  return `
DO $platos_evidence_reset_guard$
DECLARE
  actual_sentinel text;
BEGIN
  IF current_database() IS DISTINCT FROM '${identity.database}' THEN
    RAISE EXCEPTION 'refusing reset: unexpected database identity';
  END IF;
  IF current_user IS DISTINCT FROM '${identity.username}' THEN
    RAISE EXCEPTION 'refusing reset: unexpected database principal';
  END IF;
  BEGIN
    SELECT "value" INTO STRICT actual_sentinel
    FROM "${identity.sentinelSchema}"."reset_sentinel"
    WHERE "id" = '${identity.sentinelId}';
  EXCEPTION
    WHEN undefined_table OR invalid_schema_name OR no_data_found THEN
      RAISE EXCEPTION 'refusing reset: server-side disposable database sentinel is absent';
  END;
  IF actual_sentinel IS DISTINCT FROM '${identity.sentinelValue}' THEN
    RAISE EXCEPTION 'refusing reset: server-side disposable database sentinel is invalid';
  END IF;
END
$platos_evidence_reset_guard$;
DROP SCHEMA "public" CASCADE;
CREATE SCHEMA "public";
`;
}
