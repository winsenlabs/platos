import assert from "node:assert/strict";
import test from "node:test";
import {
  DISPOSABLE_DATABASE_IDENTITY,
  guardedPublicSchemaResetSql,
  sentinelProvisionSql,
  validateDisposableDatabaseUrl,
} from "./reset-guard.mjs";

const exactUrl =
  "postgresql://platos_memory_evidence_ci:password@127.0.0.1:55433/platos_memory_evidence_ci?schema=public";

test("accepts only the exact loopback disposable database identity", () => {
  assert.doesNotThrow(() => validateDisposableDatabaseUrl(exactUrl));
  for (const invalid of [
    exactUrl.replace("127.0.0.1", "localhost"),
    exactUrl.replace("55433", "5432"),
    exactUrl.replace("platos_memory_evidence_ci?", "platos_memory_evidence_ci_backup?"),
    exactUrl.replace("/platos_memory_evidence_ci?", "/production_test?"),
    exactUrl.replace("platos_memory_evidence_ci:password", "postgres:password"),
  ]) {
    assert.throws(() => validateDisposableDatabaseUrl(invalid));
  }
});

test("checks database, principal, and server sentinel before destructive SQL", () => {
  const sql = guardedPublicSchemaResetSql();
  const guardEnd = sql.indexOf("$platos_evidence_reset_guard$;");
  const drop = sql.indexOf('DROP SCHEMA "public" CASCADE');
  assert.ok(guardEnd > 0 && drop > guardEnd, "DROP must follow the complete server guard");
  assert.match(sql, /current_database\(\)/);
  assert.match(sql, /current_user/);
  assert.match(sql, new RegExp(DISPOSABLE_DATABASE_IDENTITY.sentinelSchema));
  assert.match(sql, new RegExp(DISPOSABLE_DATABASE_IDENTITY.sentinelValue));
});

test("sentinel provisioning is explicit and outside public schema", () => {
  const sql = sentinelProvisionSql();
  assert.match(
    sql,
    new RegExp(`CREATE SCHEMA IF NOT EXISTS "${DISPOSABLE_DATABASE_IDENTITY.sentinelSchema}"`)
  );
  assert.doesNotMatch(sql, /DROP SCHEMA/);
  assert.doesNotMatch(DISPOSABLE_DATABASE_IDENTITY.sentinelSchema, /^public$/);
});
