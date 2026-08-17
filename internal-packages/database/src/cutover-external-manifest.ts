import { createHash } from "node:crypto";
import { CUTOVER_ID_MAPPING_VERSION } from "./cutover-id";

export type ExternalRekeySourceModel =
  | "Organization"
  | "Project"
  | "RuntimeEnvironment"
  | "PlatosAgent"
  | "PlatosAgentThread";

export interface ClickHouseRekeyMapping {
  readonly column: string;
  readonly jsonPath?: string;
  readonly sourceModel: ExternalRekeySourceModel;
  readonly emptyValuePolicy: "BLOCK" | "PRESERVE_EMPTY";
  readonly missingMappingPolicy: "BLOCK";
}

export interface ClickHouseRekeyTableManifest {
  readonly table: string;
  readonly strategy: "SHADOW_COPY_ATOMIC_SWAP";
  readonly mappings: readonly ClickHouseRekeyMapping[];
}

export interface ClickHouseRekeyManifest {
  readonly formatVersion: 1;
  readonly mappingVersion: typeof CUTOVER_ID_MAPPING_VERSION;
  readonly database: "trigger_dev";
  readonly unknownTableOrColumnPolicy: "BLOCK";
  readonly tables: readonly ClickHouseRekeyTableManifest[];
}

const scopeMappings = [
  ["environment_id", "RuntimeEnvironment"],
  ["organization_id", "Organization"],
  ["project_id", "Project"],
] as const;

const scope = (): ClickHouseRekeyMapping[] =>
  scopeMappings.map(([column, sourceModel]) => ({
    column,
    sourceModel,
    emptyValuePolicy: "BLOCK",
    missingMappingPolicy: "BLOCK",
  }));

/**
 * Current physical ClickHouse row stores whose retained Postgres identities
 * change to deterministic UUIDs during WIN-123. Materialized views are paused
 * and recreated by a future executor; they do not contain rows of their own.
 * Trigger run/span identifiers and the hashed platos_spans_v1.user_id are not
 * Postgres identity-map values and are intentionally absent.
 */
export const currentClickHouseRekeyCatalog = Object.freeze({
  error_occurrences_v1: scope(),
  errors_v1: scope(),
  llm_metrics_v1: scope(),
  metrics_v1: scope(),
  platos_spans_v1: [
    {
      column: "agent_id",
      sourceModel: "PlatosAgent",
      emptyValuePolicy: "PRESERVE_EMPTY",
      missingMappingPolicy: "BLOCK",
    },
    {
      column: "attrs",
      jsonPath: "platos.agent.id",
      sourceModel: "PlatosAgent",
      emptyValuePolicy: "PRESERVE_EMPTY",
      missingMappingPolicy: "BLOCK",
    },
    {
      column: "attrs",
      jsonPath: "platos.env.id",
      sourceModel: "RuntimeEnvironment",
      emptyValuePolicy: "BLOCK",
      missingMappingPolicy: "BLOCK",
    },
    {
      column: "attrs",
      jsonPath: "platos.org.id",
      sourceModel: "Organization",
      emptyValuePolicy: "BLOCK",
      missingMappingPolicy: "BLOCK",
    },
    {
      column: "attrs",
      jsonPath: "platos.project.id",
      sourceModel: "Project",
      emptyValuePolicy: "BLOCK",
      missingMappingPolicy: "BLOCK",
    },
    {
      column: "attrs",
      jsonPath: "platos.thread.id",
      sourceModel: "PlatosAgentThread",
      emptyValuePolicy: "PRESERVE_EMPTY",
      missingMappingPolicy: "BLOCK",
    },
    ...scope(),
    {
      column: "thread_id",
      sourceModel: "PlatosAgentThread",
      emptyValuePolicy: "PRESERVE_EMPTY",
      missingMappingPolicy: "BLOCK",
    },
  ],
  task_event_usage_by_hour_v1: scope(),
  task_event_usage_by_minute_v1: scope(),
  task_events_search_v1: scope(),
  task_events_v1: scope(),
  task_events_v2: scope(),
  task_runs_v1: scope(),
  task_runs_v2: scope(),
} as const satisfies Readonly<Record<string, readonly ClickHouseRekeyMapping[]>>);

/** Checked-in operational mapping input. Validation never infers aliases. */
export const clickHouseRekeyManifest = {
  formatVersion: 1,
  mappingVersion: CUTOVER_ID_MAPPING_VERSION,
  database: "trigger_dev",
  unknownTableOrColumnPolicy: "BLOCK",
  tables: Object.entries(currentClickHouseRekeyCatalog).map(([table, mappings]) => ({
    table,
    strategy: "SHADOW_COPY_ATOMIC_SWAP" as const,
    mappings,
  })),
} as const satisfies ClickHouseRekeyManifest;

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const JSON_PATH = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const SOURCE_MODELS = new Set<ExternalRekeySourceModel>([
  "Organization",
  "Project",
  "RuntimeEnvironment",
  "PlatosAgent",
  "PlatosAgentThread",
]);

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
}

function mappingKey(mapping: Pick<ClickHouseRekeyMapping, "column" | "jsonPath">): string {
  return `${mapping.column}\u0000${mapping.jsonPath ?? ""}`;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function assertValidClickHouseRekeyManifest(value: unknown): asserts value is ClickHouseRekeyManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("ClickHouse rekey manifest must be an object");
  }
  const manifest = value as Record<string, unknown>;
  assertExactKeys(
    manifest,
    ["formatVersion", "mappingVersion", "database", "unknownTableOrColumnPolicy", "tables"],
    "ClickHouse rekey manifest"
  );
  if (
    manifest.formatVersion !== 1 ||
    manifest.mappingVersion !== CUTOVER_ID_MAPPING_VERSION ||
    manifest.database !== "trigger_dev" ||
    manifest.unknownTableOrColumnPolicy !== "BLOCK" ||
    !Array.isArray(manifest.tables)
  ) {
    throw new TypeError("ClickHouse rekey manifest header is invalid");
  }

  const expectedTables = Object.keys(currentClickHouseRekeyCatalog).sort(compareUtf8);
  const seenTables = new Set<string>();
  for (const rawTable of manifest.tables) {
    if (!rawTable || typeof rawTable !== "object" || Array.isArray(rawTable)) {
      throw new TypeError("ClickHouse rekey table entry must be an object");
    }
    const table = rawTable as Record<string, unknown>;
    assertExactKeys(table, ["table", "strategy", "mappings"], "ClickHouse rekey table entry");
    if (
      typeof table.table !== "string" ||
      !IDENTIFIER.test(table.table) ||
      table.strategy !== "SHADOW_COPY_ATOMIC_SWAP" ||
      !Array.isArray(table.mappings)
    ) {
      throw new TypeError("ClickHouse rekey table entry is invalid");
    }
    if (!Object.hasOwn(currentClickHouseRekeyCatalog, table.table) || seenTables.has(table.table)) {
      throw new TypeError("ClickHouse rekey manifest contains an unknown or duplicate table");
    }
    seenTables.add(table.table);

    const expectedMappings = currentClickHouseRekeyCatalog[
      table.table as keyof typeof currentClickHouseRekeyCatalog
    ];
    const expectedByKey = new Map(expectedMappings.map((mapping) => [mappingKey(mapping), mapping]));
    const seenMappings = new Set<string>();
    const actualMappingOrder: string[] = [];
    for (const rawMapping of table.mappings) {
      if (!rawMapping || typeof rawMapping !== "object" || Array.isArray(rawMapping)) {
        throw new TypeError("ClickHouse rekey mapping must be an object");
      }
      const mapping = rawMapping as Record<string, unknown>;
      assertExactKeys(
        mapping,
        mapping.jsonPath === undefined
          ? ["column", "sourceModel", "emptyValuePolicy", "missingMappingPolicy"]
          : ["column", "jsonPath", "sourceModel", "emptyValuePolicy", "missingMappingPolicy"],
        "ClickHouse rekey mapping"
      );
      if (
        typeof mapping.column !== "string" ||
        !IDENTIFIER.test(mapping.column) ||
        (mapping.jsonPath !== undefined &&
          (typeof mapping.jsonPath !== "string" || !JSON_PATH.test(mapping.jsonPath))) ||
        typeof mapping.sourceModel !== "string" ||
        !SOURCE_MODELS.has(mapping.sourceModel as ExternalRekeySourceModel) ||
        (mapping.emptyValuePolicy !== "BLOCK" && mapping.emptyValuePolicy !== "PRESERVE_EMPTY") ||
        mapping.missingMappingPolicy !== "BLOCK"
      ) {
        throw new TypeError("ClickHouse rekey mapping is invalid");
      }
      const key = mappingKey(mapping as unknown as ClickHouseRekeyMapping);
      actualMappingOrder.push(key);
      const expected = expectedByKey.get(key);
      if (!expected || seenMappings.has(key)) {
        throw new TypeError("ClickHouse rekey manifest contains an unknown or duplicate column mapping");
      }
      if (
        mapping.sourceModel !== expected.sourceModel ||
        mapping.emptyValuePolicy !== expected.emptyValuePolicy ||
        mapping.missingMappingPolicy !== expected.missingMappingPolicy
      ) {
        throw new TypeError("ClickHouse rekey column mapping does not match the current catalog");
      }
      seenMappings.add(key);
    }
    if (seenMappings.size !== expectedByKey.size) {
      throw new TypeError("ClickHouse rekey manifest is missing a required column mapping");
    }
    const expectedMappingOrder = expectedMappings.map(mappingKey).sort(compareUtf8);
    if (actualMappingOrder.some((key, index) => key !== expectedMappingOrder[index])) {
      throw new TypeError("ClickHouse rekey mappings must use canonical UTF-8 order");
    }
  }
  if (seenTables.size !== expectedTables.length) {
    throw new TypeError("ClickHouse rekey manifest is missing a required current table");
  }

  const actualOrder = manifest.tables.map((entry) => (entry as Record<string, unknown>).table as string);
  if (actualOrder.some((table, index) => table !== expectedTables[index])) {
    throw new TypeError("ClickHouse rekey manifest tables must use canonical UTF-8 order");
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareUtf8(left, right))
        .map(([key, entry]) => [key, stable(entry)])
    );
  }
  return value;
}

export function clickHouseRekeyManifestSha256(manifest: unknown = clickHouseRekeyManifest): string {
  assertValidClickHouseRekeyManifest(manifest);
  return createHash("sha256").update(JSON.stringify(stable(manifest)), "utf8").digest("hex");
}
