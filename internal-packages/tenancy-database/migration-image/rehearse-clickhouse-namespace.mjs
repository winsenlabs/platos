import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const endpoint = new URL(process.env.CLICKHOUSE_HTTP_URL ?? "http://clickhouse:8123");
const auth = endpoint.username
  ? `Basic ${Buffer.from(
      `${decodeURIComponent(endpoint.username)}:${decodeURIComponent(endpoint.password)}`
    ).toString("base64")}`
  : undefined;
endpoint.username = "";
endpoint.password = "";

async function query(sql) {
  const url = new URL(endpoint);
  url.searchParams.set("query", sql);
  const response = await fetch(url, {
    method: "POST",
    headers: auth ? { Authorization: auth } : {},
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`ClickHouse HTTP ${response.status}: ${body.slice(0, 500)}`);
  return body.trim();
}

function goose(command) {
  execFileSync("goose", ["-dir", "/migrations/clickhouse", command], {
    stdio: "inherit",
    env: process.env,
  });
}

const fixtureName = "win144.namespace_rehearsal";
const fixture = JSON.stringify({
  organization_id: "win144-org",
  project_id: "win144-project",
  environment_id: "win144-environment",
  metric_name: fixtureName,
  metric_type: "counter",
  metric_subject: "namespace-conservation",
  bucket_start: "2026-08-24 00:00:00",
  value: 144,
  attributes: {},
});

const targetTable = "platos_telemetry.metrics_v1";
// The rollback name is confined to this CI-only migration rehearsal. Runtime
// readers and writers never depend on it.
const rollbackTable = "trigger_dev.metrics_v1";
const fingerprint = (table) =>
  `SELECT count(), sum(cityHash64(organization_id, project_id, environment_id, metric_name, metric_subject, value)) FROM ${table} WHERE metric_name = '${fixtureName}' FORMAT TabSeparated`;
const catalogFingerprint = (database) =>
  `SELECT count(), sum(cityHash64(name, toString(uuid), engine)) FROM system.tables WHERE database = '${database}' FORMAT TabSeparated`;
const removeFixture = (table) =>
  query(
    `ALTER TABLE ${table} DELETE WHERE metric_name = '${fixtureName}' SETTINGS mutations_sync = 2`
  );

let rolledBack = false;
try {
  await removeFixture(targetTable);
  const catalogBefore = await query(catalogFingerprint("platos_telemetry"));
  assert.match(catalogBefore, /^\d+\t\d+$/, "forward namespace table catalog is empty");

  await query(`INSERT INTO ${targetTable} FORMAT JSONEachRow\n${fixture}`);
  const before = await query(fingerprint(targetTable));
  assert.match(before, /^1\t\d+$/, "forward namespace fixture was not persisted");

  goose("down");
  rolledBack = true;
  assert.equal(
    await query(fingerprint(rollbackTable)),
    before,
    "rollback changed fixture count/hash"
  );
  assert.equal(
    await query(catalogFingerprint("trigger_dev")),
    catalogBefore,
    "rollback changed table UUID/engine conservation fingerprint"
  );

  goose("up");
  rolledBack = false;
  assert.equal(
    await query(fingerprint(targetTable)),
    before,
    "forward-again changed fixture count/hash"
  );
  assert.equal(
    await query(catalogFingerprint("platos_telemetry")),
    catalogBefore,
    "forward-again changed table UUID/engine conservation fingerprint"
  );
  assert.equal(
    await query(
      "SELECT count() FROM system.databases WHERE name = 'platos_telemetry' FORMAT TabSeparated"
    ),
    "1",
    "target database is missing after rehearsal"
  );
  await removeFixture(targetTable);
  assert.equal(await query(fingerprint(targetTable)), "0\t0", "rehearsal fixture cleanup failed");
  process.stdout.write(`WIN-144 ClickHouse namespace rehearsal conserved ${before}\n`);
} finally {
  if (rolledBack) goose("up");
  try {
    await removeFixture(targetTable);
  } catch {
    // Preserve the original failure; the empty-store seed will independently
    // reject a leaked fixture if cleanup could not run.
  }
}
