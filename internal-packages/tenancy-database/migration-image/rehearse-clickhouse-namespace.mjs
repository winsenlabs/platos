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

const forwardDatabase = "platos_telemetry";
// The rollback name is confined to this CI-only migration rehearsal. Runtime
// readers and writers never depend on it.
const rollbackDatabase = "trigger_dev";
const fixturePrefix = "win144_namespace_rehearsal";
const fixtureOrganization = `${fixturePrefix}_org`;
const fixtureProject = `${fixturePrefix}_project`;
const fixtureEnvironment = `${fixturePrefix}_environment`;

const viewRoutes = new Map([
  [
    "mv_task_event_usage_by_hour_v1",
    ["task_event_usage_by_minute_v1", "task_event_usage_by_hour_v1"],
  ],
  ["mv_task_event_usage_by_minute_v2", ["task_events_v1", "task_event_usage_by_minute_v1"]],
  [
    "mv_task_event_v2_usage_by_minute",
    ["task_events_v2", "task_event_usage_by_minute_v1"],
  ],
  ["task_events_search_mv_v1", ["task_events_v2", "task_events_search_v1"]],
  ["errors_mv_v1", ["task_runs_v2", "errors_v1"]],
  ["error_occurrences_mv_v1", ["task_runs_v2", "error_occurrences_v1"]],
  ["llm_model_aggregates_mv_v1", ["llm_metrics_v1", "llm_model_aggregates_v1"]],
]);

const destinationTables = [
  "task_event_usage_by_minute_v1",
  "task_event_usage_by_hour_v1",
  "task_events_search_v1",
  "errors_v1",
  "error_occurrences_v1",
  "llm_model_aggregates_v1",
];

function normalizeDefinition(value) {
  return value.replaceAll("`", "").replace(/\s+/g, " ").trim();
}

async function assertViewDefinitions(database, staleDatabase) {
  const names = [...viewRoutes.keys()].map((name) => `'${name}'`).join(", ");
  const body = await query(`
    SELECT name, create_table_query
    FROM system.tables
    WHERE database = '${database}' AND name IN (${names})
    ORDER BY name
    FORMAT JSONEachRow
  `);
  const rows = body ? body.split("\n").map((line) => JSON.parse(line)) : [];
  assert.deepEqual(
    rows.map((row) => row.name),
    [...viewRoutes.keys()].sort(),
    `${database} does not contain every expected materialized view`
  );

  for (const row of rows) {
    const [source, destination] = viewRoutes.get(row.name);
    const definition = normalizeDefinition(row.create_table_query);
    assert.match(
      definition,
      new RegExp(`\\bTO ${database}\\.${destination}\\b`, "i"),
      `${row.name} has the wrong destination namespace`
    );
    assert.match(
      definition,
      new RegExp(`\\bFROM ${database}\\.${source}\\b`, "i"),
      `${row.name} has the wrong source namespace`
    );
    assert.doesNotMatch(
      definition,
      new RegExp(`\\b${staleDatabase}\\.`, "i"),
      `${row.name} retains the stale namespace`
    );
  }
}

async function destinationCatalog(database) {
  const names = destinationTables.map((name) => `'${name}'`).join(", ");
  const body = await query(`
    SELECT name, toString(uuid), engine
    FROM system.tables
    WHERE database = '${database}' AND name IN (${names})
    ORDER BY name
    FORMAT TabSeparated
  `);
  const rows = body ? body.split("\n") : [];
  assert.equal(rows.length, destinationTables.length, `${database} destination catalog is incomplete`);
  return rows.join("\n");
}

const fingerprintQueries = {
  task_event_usage_by_minute_v1: (database) => `
    SELECT count(), sum(cityHash64(organization_id, project_id, environment_id, toString(bucket_start), toString(event_count)))
    FROM (
      SELECT organization_id, project_id, environment_id, bucket_start, sum(event_count) AS event_count
      FROM ${database}.task_event_usage_by_minute_v1
      WHERE organization_id = '${fixtureOrganization}'
      GROUP BY organization_id, project_id, environment_id, bucket_start
    ) FORMAT TabSeparated`,
  task_event_usage_by_hour_v1: (database) => `
    SELECT count(), sum(cityHash64(organization_id, project_id, environment_id, toString(bucket_start), toString(event_count)))
    FROM (
      SELECT organization_id, project_id, environment_id, bucket_start, sum(event_count) AS event_count
      FROM ${database}.task_event_usage_by_hour_v1
      WHERE organization_id = '${fixtureOrganization}'
      GROUP BY organization_id, project_id, environment_id, bucket_start
    ) FORMAT TabSeparated`,
  task_events_search_v1: (database) => `
    SELECT count(), sum(cityHash64(organization_id, project_id, environment_id, trace_id, span_id, run_id, message, toString(triggered_timestamp)))
    FROM ${database}.task_events_search_v1
    WHERE organization_id = '${fixtureOrganization}'
    FORMAT TabSeparated`,
  errors_v1: (database) => `
    SELECT count(), sum(cityHash64(organization_id, project_id, environment_id, task_identifier, error_fingerprint, toString(occurrence_count)))
    FROM (
      SELECT organization_id, project_id, environment_id, task_identifier, error_fingerprint,
        sumMerge(occurrence_count) AS occurrence_count
      FROM ${database}.errors_v1
      WHERE organization_id = '${fixtureOrganization}'
      GROUP BY organization_id, project_id, environment_id, task_identifier, error_fingerprint
    ) FORMAT TabSeparated`,
  error_occurrences_v1: (database) => `
    SELECT count(), sum(cityHash64(organization_id, project_id, environment_id, task_identifier, error_fingerprint, task_version, toString(minute), toString(event_count)))
    FROM (
      SELECT organization_id, project_id, environment_id, task_identifier, error_fingerprint, task_version, minute,
        sum(count) AS event_count
      FROM ${database}.error_occurrences_v1
      WHERE organization_id = '${fixtureOrganization}'
      GROUP BY organization_id, project_id, environment_id, task_identifier, error_fingerprint, task_version, minute
    ) FORMAT TabSeparated`,
  llm_model_aggregates_v1: (database) => `
    SELECT count(), sum(cityHash64(response_model, base_response_model, gen_ai_system, toString(minute), toString(call_count), toString(total_input_tokens), toString(total_output_tokens), toString(total_cost)))
    FROM (
      SELECT response_model, base_response_model, gen_ai_system, minute,
        sum(call_count) AS call_count,
        sum(total_input_tokens) AS total_input_tokens,
        sum(total_output_tokens) AS total_output_tokens,
        sum(total_cost) AS total_cost
      FROM ${database}.llm_model_aggregates_v1
      WHERE startsWith(response_model, '${fixturePrefix}_')
      GROUP BY response_model, base_response_model, gen_ai_system, minute
    ) FORMAT TabSeparated`,
};

async function destinationFingerprints(database) {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(fingerprintQueries).map(async ([table, build]) => [table, await query(build(database))])
    )
  );
}

function assertDestinationCount(fingerprints, expected) {
  for (const [table, fingerprint] of Object.entries(fingerprints)) {
    assert.match(fingerprint, /^\d+\t\d+$/, `${table} did not produce a count/hash fingerprint`);
    assert.equal(Number(fingerprint.split("\t", 1)[0]), expected, `${table} row count is wrong`);
  }
}

async function insertJson(database, table, row) {
  await query(
    `INSERT INTO ${database}.${table} SETTINGS enable_json_type = 1, input_format_defaults_for_omitted_fields = 1 FORMAT JSONEachRow\n${JSON.stringify(row)}`
  );
}

async function insertRepresentativeSources(database, phase) {
  const hour = String(phase).padStart(2, "0");
  const timestamp = `2099-01-01 ${hour}:00:00`;
  const runId = `${fixturePrefix}_run_${phase}`;
  const traceId = `${fixturePrefix}_trace_${phase}`;

  const event = {
    organization_id: fixtureOrganization,
    project_id: fixtureProject,
    environment_id: fixtureEnvironment,
    task_identifier: `${fixturePrefix}_runtime`,
    run_id: runId,
    start_time: `${timestamp}.000000000`,
    duration: 1_000_000,
    trace_id: traceId,
    span_id: `${fixturePrefix}_span_v1_${phase}`,
    parent_span_id: "",
    message: `${fixturePrefix}_event_v1_${phase}`,
    kind: "SPAN",
    status: "OK",
    attributes: { namespace_rehearsal: phase },
    metadata: "{}",
    expires_at: "2099-02-01 00:00:00.000",
  };
  await insertJson(database, "task_events_v1", event);
  await insertJson(database, "task_events_v2", {
    ...event,
    start_time: `${timestamp}.010000000`,
    span_id: `${fixturePrefix}_span_v2_${phase}`,
    message: `${fixturePrefix}_event_v2_${phase}`,
    inserted_at: `${timestamp}.010`,
  });

  await insertJson(database, "task_runs_v2", {
    organization_id: fixtureOrganization,
    project_id: fixtureProject,
    environment_id: fixtureEnvironment,
    run_id: runId,
    created_at: `${timestamp}.020`,
    updated_at: `${timestamp}.020`,
    status: "SYSTEM_FAILURE",
    environment_type: "PRODUCTION",
    friendly_id: `${fixturePrefix}_friendly_${phase}`,
    engine: "V2",
    task_identifier: `${fixturePrefix}_runtime`,
    error_fingerprint: `${fixturePrefix}_error_${phase}`,
    output: {},
    error: {
      data: {
        type: "NamespaceRehearsal",
        message: `${fixturePrefix} error ${phase}`,
        stack: `${fixturePrefix} stack ${phase}`,
      },
    },
    task_version: `v${phase}`,
    _version: phase,
    _is_deleted: 0,
  });

  await insertJson(database, "llm_metrics_v1", {
    organization_id: fixtureOrganization,
    project_id: fixtureProject,
    environment_id: fixtureEnvironment,
    run_id: runId,
    task_identifier: `${fixturePrefix}_runtime`,
    trace_id: traceId,
    span_id: `${fixturePrefix}_llm_span_${phase}`,
    gen_ai_system: "rehearsal",
    response_model: `${fixturePrefix}_model_${phase}`,
    base_response_model: `${fixturePrefix}_base`,
    finish_reason: "stop",
    input_tokens: 10 + phase,
    output_tokens: 20 + phase,
    total_cost: phase,
    ms_to_first_chunk: 10,
    tokens_per_second: 20,
    duration: 1_000,
    start_time: `${timestamp}.030000000`,
  });
}

async function removeFixtures(database) {
  const operations = [
    ["task_events_v1", `organization_id = '${fixtureOrganization}'`],
    ["task_events_v2", `organization_id = '${fixtureOrganization}'`],
    ["task_runs_v2", `organization_id = '${fixtureOrganization}'`],
    ["llm_metrics_v1", `organization_id = '${fixtureOrganization}'`],
    ["task_event_usage_by_minute_v1", `organization_id = '${fixtureOrganization}'`],
    ["task_event_usage_by_hour_v1", `organization_id = '${fixtureOrganization}'`],
    ["task_events_search_v1", `organization_id = '${fixtureOrganization}'`],
    ["errors_v1", `organization_id = '${fixtureOrganization}'`],
    ["error_occurrences_v1", `organization_id = '${fixtureOrganization}'`],
    ["llm_model_aggregates_v1", `startsWith(response_model, '${fixturePrefix}_')`],
  ];
  for (const [table, predicate] of operations) {
    await query(`ALTER TABLE ${database}.${table} DELETE WHERE ${predicate} SETTINGS mutations_sync = 2`);
  }
}

let rolledBack = false;
try {
  await removeFixtures(forwardDatabase);
  await assertViewDefinitions(forwardDatabase, rollbackDatabase);
  assertDestinationCount(await destinationFingerprints(forwardDatabase), 0);
  const catalogBefore = await destinationCatalog(forwardDatabase);

  await insertRepresentativeSources(forwardDatabase, 1);
  const afterForwardInsert = await destinationFingerprints(forwardDatabase);
  assertDestinationCount(afterForwardInsert, 1);

  goose("down");
  rolledBack = true;
  await assertViewDefinitions(rollbackDatabase, forwardDatabase);
  assert.equal(
    await destinationCatalog(rollbackDatabase),
    catalogBefore,
    "rollback changed destination UUIDs or engines"
  );
  assert.deepEqual(
    await destinationFingerprints(rollbackDatabase),
    afterForwardInsert,
    "rollback changed destination rows or hashes"
  );

  await insertRepresentativeSources(rollbackDatabase, 2);
  const afterRollbackInsert = await destinationFingerprints(rollbackDatabase);
  assertDestinationCount(afterRollbackInsert, 2);

  goose("up");
  rolledBack = false;
  await assertViewDefinitions(forwardDatabase, rollbackDatabase);
  assert.equal(
    await destinationCatalog(forwardDatabase),
    catalogBefore,
    "forward-again changed destination UUIDs or engines"
  );
  assert.deepEqual(
    await destinationFingerprints(forwardDatabase),
    afterRollbackInsert,
    "forward-again changed destination rows or hashes"
  );

  await insertRepresentativeSources(forwardDatabase, 3);
  const afterForwardAgainInsert = await destinationFingerprints(forwardDatabase);
  assertDestinationCount(afterForwardAgainInsert, 3);

  await removeFixtures(forwardDatabase);
  assertDestinationCount(await destinationFingerprints(forwardDatabase), 0);
  process.stdout.write(
    "WIN-144 ClickHouse namespace rehearsal conserved destination rows, hashes, UUIDs, and engines across every materialized-view route\n"
  );
} finally {
  if (rolledBack) goose("up");
  try {
    await removeFixtures(forwardDatabase);
  } catch {
    // Preserve the original failure; the empty-store seed will independently
    // reject leaked tenant-scoped fixture rows if cleanup could not run.
  }
}
