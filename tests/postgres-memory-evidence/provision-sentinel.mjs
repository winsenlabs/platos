import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { sentinelProvisionSql, validateDisposableDatabaseUrl } from "./reset-guard.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const databaseUrl = process.env.PLATOS_POSTGRES_INTEGRATION_DATABASE_URL?.trim();
assert.ok(databaseUrl, "PLATOS_POSTGRES_INTEGRATION_DATABASE_URL is required");
validateDisposableDatabaseUrl(databaseUrl);

const result = spawnSync(
  "pnpm",
  [
    "--filter",
    "@platos/tenancy-database",
    "exec",
    "prisma",
    "db",
    "execute",
    "--stdin",
    "--schema",
    "prisma/schema.prisma",
  ],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl },
    input: sentinelProvisionSql(),
    maxBuffer: 8 * 1024 * 1024,
  }
);
assert.equal(
  result.error,
  undefined,
  `sentinel provisioning could not start: ${result.error?.message}`
);
assert.equal(result.status, 0, `sentinel provisioning failed: ${result.stderr || result.stdout}`);
console.log("Provisioned exact server-side PostgreSQL evidence reset sentinel");
