import { createHash } from "node:crypto";
import {
  clickHouseRekeyManifest,
  type ClickHouseRekeyMapping,
  type ExternalRekeySourceModel,
} from "./cutover-external-manifest";
import { clickHouseRunScopedIdentifier } from "./cutover-external";

export const CLICKHOUSE_REHEARSAL_DATABASE = "trigger_dev" as const;

export interface ClickHousePhysicalTablePlan {
  readonly table: string;
  readonly sourceSchemaSha256: string;
  readonly mappings: readonly ClickHouseRekeyMapping[];
}

/**
 * SHA-256 values are over UTF-8 SHOW CREATE TABLE output with trailing
 * whitespace removed after applying internal-packages/clickhouse/schema
 * 001..032 to ClickHouse 25.4. A source mismatch blocks before staging.
 */
const SOURCE_SCHEMA_SHA256 = {
  error_occurrences_v1: "107f13fcbee1239773e64165cf882aac4f5c47b9fc333a983bd0aba635d8980e",
  errors_v1: "2937ab0216bf5d15daad55ff70291e714cbfb63147bf6c36cbecbcd35cfca346",
  llm_metrics_v1: "119458b26e2a510c8558ac85e982a17a11cbe32772b79df931ccf782597565e6",
  metrics_v1: "fb7f2e13de71f53a578598375a2b9366571ef7bd1f81ed70658cd2ca31a30d71",
  platos_spans_v1: "d3eb8f1b29ee807b5ad1bc6fc8b2e1b797cf98e418614453ece07548987912b8",
  task_event_usage_by_hour_v1: "3bcf32b307530790c870507355f213a310752486ba4ca9bb52d82cf10595718e",
  task_event_usage_by_minute_v1: "9941584a5441b7300c9996af725e8e81744951dacbd9abdff4441e7639f8dcbd",
  task_events_search_v1: "824733ca8d288a5f587d642ea7238debcfc60cdcb059bd757b59ec36b52a283c",
  task_events_v1: "1c589bab007c191745e76d9f94a0c23785f3b00eb96fdaabf89b2f21fd8953d8",
  task_events_v2: "90f59dd214be3e5f46cb59c5fe12a512cb199715597fab1f967e19fe6b4cb1cf",
  task_runs_v1: "e4eeb00a428db5d7c7f8856688793bb39632fd0c81c9466162ed49b6b975968d",
  task_runs_v2: "73da10f61dee9c5c02ea8cec9a67367cc2f2afb6b421a44e17023a7e2595af47",
} as const;

export const clickHousePhysicalRekeyPlan = Object.freeze(
  clickHouseRekeyManifest.tables.map((entry) => ({
    table: entry.table,
    sourceSchemaSha256: SOURCE_SCHEMA_SHA256[entry.table as keyof typeof SOURCE_SCHEMA_SHA256],
    mappings: entry.mappings,
  }))
) satisfies readonly ClickHousePhysicalTablePlan[];

export function clickHouseSourceSchemaSha256(showCreate: string): string {
  return createHash("sha256").update(showCreate.trimEnd(), "utf8").digest("hex");
}

const q = (identifier: string): string => `\`${identifier.replaceAll("`", "``")}\``;
const literal = (value: string): string => `'${value.replaceAll("'", "\\'")}'`;

export function clickHouseMappingTableIdentifier(runId: string): string {
  return `cutover_uuid_map__win123_${runId.replaceAll("-", "")}`;
}

export function createMappingTableSql(runId: string): string {
  return `CREATE TABLE ${q(CLICKHOUSE_REHEARSAL_DATABASE)}.${q(clickHouseMappingTableIdentifier(runId))} (
    mapping_version UInt16,
    source_model LowCardinality(String),
    source_id String,
    target_id UUID
  ) ENGINE = MergeTree ORDER BY (source_model, source_id)`;
}

function sourceValue(mapping: ClickHouseRekeyMapping, sourceAlias = "source"): string {
  return mapping.jsonPath
    ? `JSONExtractString(${sourceAlias}.${q(mapping.column)}, ${literal(mapping.jsonPath)})`
    : `toString(${sourceAlias}.${q(mapping.column)})`;
}

function mappingAlias(index: number): string {
  return `mapping_${index}`;
}

function normalizedMappingValue(mapping: ClickHouseRekeyMapping, index: number): string {
  const original = sourceValue(mapping);
  const mapped = mapping.emptyValuePolicy === "PRESERVE_EMPTY"
    ? `if(${original} = '', '', toString(${mappingAlias(index)}.target_id))`
    : mappingAlias(index) + ".target_id";
  return mapping.jsonPath ? `toString(${mapped})` : mapped;
}

function sourceFromAndJoins(plan: ClickHousePhysicalTablePlan, runId: string): string {
  const mappingTable = `${q(CLICKHOUSE_REHEARSAL_DATABASE)}.${q(clickHouseMappingTableIdentifier(runId))}`;
  return `${q(CLICKHOUSE_REHEARSAL_DATABASE)}.${q(plan.table)} AS source\n${plan.mappings
    .map((mapping, index) => `${mapping.emptyValuePolicy === "PRESERVE_EMPTY" ? "LEFT" : "INNER"} JOIN ${mappingTable} AS ${mappingAlias(index)}
      ON ${mappingAlias(index)}.mapping_version = 1
     AND ${mappingAlias(index)}.source_model = ${literal(mapping.sourceModel)}
     AND ${mappingAlias(index)}.source_id = ${sourceValue(mapping)}`)
    .join("\n")}`;
}

export function mappingPreflightSql(plan: ClickHousePhysicalTablePlan, runId: string): string {
  const references = plan.mappings.map((mapping) => {
    const value = sourceValue(mapping);
    const filter = mapping.emptyValuePolicy === "PRESERVE_EMPTY" ? ` WHERE ${value} != ''` : "";
    return `SELECT ${literal(mapping.sourceModel)} AS source_model, ${value} AS source_id
      FROM ${q(CLICKHOUSE_REHEARSAL_DATABASE)}.${q(plan.table)} AS source${filter}`;
  });
  return `SELECT count() AS missing_count FROM (
    SELECT DISTINCT source_model, source_id FROM (${references.join("\nUNION ALL\n")})
  ) AS reference
  LEFT ANTI JOIN ${q(CLICKHOUSE_REHEARSAL_DATABASE)}.${q(clickHouseMappingTableIdentifier(runId))} AS mapping
    ON mapping.mapping_version = 1
   AND mapping.source_model = reference.source_model
   AND mapping.source_id = reference.source_id`;
}

function regexp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function targetDdlSql(
  plan: ClickHousePhysicalTablePlan,
  runId: string,
  sourceShowCreate: string,
  sourceColumns: readonly ClickHouseColumnShape[]
): string {
  const shadow = clickHouseRunScopedIdentifier(plan.table, "shadow", runId);
  const directUuidColumns = [...new Set(plan.mappings
    .filter((mapping) => !mapping.jsonPath && mapping.emptyValuePolicy === "BLOCK")
    .map((mapping) => mapping.column))];
  const sourceNames = [
    `CREATE TABLE ${CLICKHOUSE_REHEARSAL_DATABASE}.${plan.table}`,
    `CREATE TABLE ${q(CLICKHOUSE_REHEARSAL_DATABASE)}.${q(plan.table)}`,
    `CREATE TABLE ${q(plan.table)}`,
  ];
  const sourceName = sourceNames.find((candidate) => sourceShowCreate.startsWith(candidate));
  if (!sourceName) throw new TypeError("ClickHouse source DDL table identity is invalid");
  let target = `${sourceName.replace(/CREATE TABLE .+/, `CREATE TABLE ${q(CLICKHOUSE_REHEARSAL_DATABASE)}.${q(shadow)}`)}${sourceShowCreate.slice(sourceName.length)}`;
  for (const column of directUuidColumns) {
    const sourceType = sourceColumns.find((entry) => entry.name === column)?.type;
    if (!sourceType) throw new TypeError("ClickHouse source DDL is missing a mapped column");
    const declaration = new RegExp(`(${regexp(q(column))}\\s+)${regexp(sourceType)}(?=\\s|,)`, "g");
    const matches = target.match(declaration);
    if (matches?.length !== 1) throw new TypeError("ClickHouse source DDL mapped column is ambiguous");
    target = target.replace(declaration, "$1UUID");
  }
  return target;
}

function attrsProjection(plan: ClickHousePhysicalTablePlan): string | undefined {
  const mappings = plan.mappings
    .map((mapping, index) => ({ mapping, index }))
    .filter(({ mapping }) => mapping.jsonPath);
  if (mappings.length === 0) return undefined;
  let expression = `source.${q(mappings[0]!.mapping.column)}`;
  for (const { mapping, index } of mappings) {
    expression = `JSONMergePatch(${expression}, toJSONString(map(${literal(mapping.jsonPath!)}, ${normalizedMappingValue(mapping, index)})))`;
  }
  return expression;
}

export interface ClickHouseColumnShape {
  readonly name: string;
  readonly type: string;
  readonly defaultKind: string;
  readonly defaultExpression: string;
}

function normalizedProjection(
  plan: ClickHousePhysicalTablePlan,
  columns: readonly ClickHouseColumnShape[],
  finalizeAggregates: boolean
): readonly string[] {
  const direct = new Map(plan.mappings
    .map((mapping, index) => ({ mapping, index }))
    .filter(({ mapping }) => !mapping.jsonPath)
    .map(({ mapping, index }) => [mapping.column, normalizedMappingValue(mapping, index)]));
  const attrs = attrsProjection(plan);
  return columns.map((column) =>
    direct.get(column.name) ??
    (column.name === "attrs" && attrs
      ? attrs
      : finalizeAggregates ? payloadChecksumExpression("source", column) : `source.${q(column.name)}`)
  );
}

export function copyProjectionSql(
  plan: ClickHousePhysicalTablePlan,
  runId: string,
  columns: readonly ClickHouseColumnShape[]
): string {
  const shadow = clickHouseRunScopedIdentifier(plan.table, "shadow", runId);
  const insertable = columns.filter((column) => !["MATERIALIZED", "ALIAS"].includes(column.defaultKind));
  const projections = normalizedProjection(plan, insertable, false);
  return `INSERT INTO ${q(CLICKHOUSE_REHEARSAL_DATABASE)}.${q(shadow)} (${insertable.map((column) => q(column.name)).join(", ")})
SELECT ${projections.join(",\n       ")}
FROM ${sourceFromAndJoins(plan, runId)}`;
}

function tupleChecksumSql(input: {
  readonly from: string;
  readonly expressions: readonly string[];
  readonly types: readonly string[];
}): string {
  if (input.expressions.length !== input.types.length) {
    throw new TypeError("ClickHouse checksum expressions and types must align");
  }
  const framed = input.expressions.flatMap((expression, index) => [literal(input.types[index]!), expression]);
  return `SELECT
    toString(count()) AS row_count,
    lower(hex(SHA256(arrayStringConcat(arraySort(groupArray(row_sha256)), '')))) AS rows_sha256
  FROM (
    SELECT lower(hex(SHA256(toJSONString(tuple(${framed.join(", ")}))))) AS row_sha256
    FROM ${input.from}
  )`;
}

function payloadChecksumExpression(alias: string, column: ClickHouseColumnShape): string {
  const value = `${alias}.${q(column.name)}`;
  return column.type.startsWith("AggregateFunction(") ? `finalizeAggregation(${value})` : value;
}

export function sourceChecksumSql(
  plan: ClickHousePhysicalTablePlan,
  runId: string,
  columns: readonly ClickHouseColumnShape[],
  normalized: boolean
): string {
  if (!normalized) {
    return tupleChecksumSql({
      from: `${q(CLICKHOUSE_REHEARSAL_DATABASE)}.${q(plan.table)} AS source`,
      expressions: columns.map((column) => payloadChecksumExpression("source", column)),
      types: columns.map((column) => column.type),
    });
  }
  return tupleChecksumSql({
    from: sourceFromAndJoins(plan, runId),
    expressions: normalizedProjection(plan, columns, true),
    types: columns.map((column) => {
      const directMapping = plan.mappings.find((mapping) => !mapping.jsonPath && mapping.column === column.name);
      return directMapping?.emptyValuePolicy === "BLOCK" ? "UUID" : column.type;
    }),
  });
}

export function targetChecksumSql(
  table: string,
  columns: readonly ClickHouseColumnShape[],
  runId?: string
): string {
  const actualTable = runId ? clickHouseRunScopedIdentifier(table, "shadow", runId) : table;
  return tupleChecksumSql({
    from: `${q(CLICKHOUSE_REHEARSAL_DATABASE)}.${q(actualTable)} AS target`,
    expressions: columns.map((column) => payloadChecksumExpression("target", column)),
    types: columns.map((column) => column.type),
  });
}

export function identityChecksumSql(
  plan: ClickHousePhysicalTablePlan,
  runId: string,
  side: "SOURCE_NORMALIZED" | "TARGET_SHADOW"
): string {
  if (side === "SOURCE_NORMALIZED") {
    return tupleChecksumSql({
      from: sourceFromAndJoins(plan, runId),
      expressions: plan.mappings.map((mapping, index) => normalizedMappingValue(mapping, index)),
      types: plan.mappings.map((mapping) => mapping.emptyValuePolicy === "BLOCK" && !mapping.jsonPath ? "UUID" : "String"),
    });
  }
  const shadow = clickHouseRunScopedIdentifier(plan.table, "shadow", runId);
  return tupleChecksumSql({
    from: `${q(CLICKHOUSE_REHEARSAL_DATABASE)}.${q(shadow)} AS target`,
    expressions: plan.mappings.map((mapping) => {
      if (mapping.jsonPath) {
        return `JSONExtractString(target.${q(mapping.column)}, ${literal(mapping.jsonPath)})`;
      }
      return mapping.emptyValuePolicy === "BLOCK"
        ? `target.${q(mapping.column)}`
        : `toString(target.${q(mapping.column)})`;
    }),
    types: plan.mappings.map((mapping) => mapping.emptyValuePolicy === "BLOCK" && !mapping.jsonPath ? "UUID" : "String"),
  });
}

export const clickHousePhysicalPlanSourceModels = Object.freeze(
  [...new Set(clickHousePhysicalRekeyPlan.flatMap((plan) => plan.mappings.map((entry) => entry.sourceModel)))]
) satisfies readonly ExternalRekeySourceModel[];
