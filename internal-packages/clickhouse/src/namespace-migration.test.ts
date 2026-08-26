import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = join(packageRoot, "schema");
const fixturePath = join(packageRoot, "test-fixtures", "applied-schema-sha256.json");

type FrozenHistory = {
  throughVersion: number;
  files: Record<string, string>;
};

type TableState = {
  uuid: string;
  engine: string;
  rows: string[];
};

type ViewState = {
  destination: string;
  source: string;
};

type DatabaseState = {
  tables: Map<string, TableState>;
  views: Map<string, ViewState>;
};

const physical = (...parts: string[]) => parts.join("");
const viewRoutes = new Map<string, ViewState>([
  [
    physical("mv_", "task", "_event_usage_by_hour_v1"),
    {
      destination: physical("task", "_event_usage_by_hour_v1"),
      source: physical("task", "_event_usage_by_minute_v1"),
    },
  ],
  [
    physical("mv_", "task", "_event_usage_by_minute_v2"),
    {
      destination: physical("task", "_event_usage_by_minute_v1"),
      source: physical("task", "_events_v1"),
    },
  ],
  [
    physical("mv_", "task", "_event_v2_usage_by_minute"),
    {
      destination: physical("task", "_event_usage_by_minute_v1"),
      source: physical("task", "_events_v2"),
    },
  ],
  [
    physical("task", "_events_search_mv_v1"),
    {
      destination: physical("task", "_events_search_v1"),
      source: physical("task", "_events_v2"),
    },
  ],
  ["errors_mv_v1", { destination: "errors_v1", source: physical("task", "_runs_v2") }],
  [
    "error_occurrences_mv_v1",
    { destination: "error_occurrences_v1", source: physical("task", "_runs_v2") },
  ],
  [
    "llm_model_aggregates_mv_v1",
    { destination: "llm_model_aggregates_v1", source: "llm_metrics_v1" },
  ],
]);

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function migration(version: number): string {
  const prefix = `${String(version).padStart(3, "0")}_`;
  const name = readdirSync(schemaRoot).find((entry) => entry.startsWith(prefix));
  if (!name) throw new Error(`missing ClickHouse migration ${version}`);
  return name;
}

function activeHistoricalViews(): Set<string> {
  const active = new Set<string>();
  const statement =
    /CREATE MATERIALIZED VIEW(?: IF NOT EXISTS)?\s+\w+\.(\w+)|DROP (?:TABLE|VIEW) IF EXISTS\s+\w+\.(\w+)/gi;
  for (let version = 1; version <= 33; version += 1) {
    const sql = readFileSync(join(schemaRoot, migration(version)), "utf8").split(
      /-- \+goose Down/i
    )[0];
    for (const match of sql.matchAll(statement)) {
      if (match[1]) active.add(match[1]);
      if (match[2]) active.delete(match[2]);
    }
  }
  return active;
}

function viewDefinitions(sql: string): Map<string, ViewState> {
  const definitions = new Map<string, ViewState>();
  const pattern = /CREATE MATERIALIZED VIEW\s+(\w+)\.(\w+)\s+TO\s+(\w+)\.(\w+)\s+AS\s+([\s\S]*?);/gi;
  for (const match of sql.matchAll(pattern)) {
    const [, database, name, destinationDatabase, destination, query] = match;
    const source = query.match(/\bFROM\s+(\w+)\.(\w+)/i);
    if (!source) throw new Error(`view ${name} has no qualified source`);
    expect(destinationDatabase).toBe(database);
    expect(source[1]).toBe(database);
    definitions.set(name, { destination, source: source[2] });
  }
  return definitions;
}

function applySection(catalog: Map<string, DatabaseState>, sql: string): string {
  const rename = sql.match(/RENAME DATABASE\s+(\w+)\s+TO\s+(\w+)/i);
  if (!rename) throw new Error("migration does not contain a database rename");
  const [, source, target] = rename;
  const sourceState = catalog.get(source);
  if (!sourceState) throw new Error(`source database ${source} is missing`);
  if (catalog.has(target)) throw new Error(`target database ${target} already exists`);

  for (const drop of sql.matchAll(/DROP VIEW IF EXISTS\s+(\w+)\.(\w+)/gi)) {
    expect(drop[1]).toBe(source);
    sourceState.views.delete(drop[2]);
  }
  expect(sourceState.views).toEqual(new Map());

  catalog.delete(source);
  catalog.set(target, sourceState);
  sourceState.views = viewDefinitions(sql);
  expect(sourceState.views).toEqual(viewRoutes);
  return target;
}

function destinationCatalog(database: DatabaseState): Array<[string, string, string, string[]]> {
  const destinations = new Set([...viewRoutes.values()].map((route) => route.destination));
  return [...database.tables]
    .filter(([name]) => destinations.has(name))
    .map(([name, table]) => [name, table.uuid, table.engine, [...table.rows]] as const)
    .sort(([left], [right]) => left.localeCompare(right));
}

function insertThroughSources(database: DatabaseState, phase: string): void {
  for (const [name, route] of database.views) {
    expect(database.tables.has(route.source), `${name} source`).toBe(true);
    const destination = database.tables.get(route.destination);
    expect(destination, `${name} destination`).toBeDefined();
    destination!.rows.push(sha256(`${phase}:${name}:${route.source}:${route.destination}`));
  }
}

describe("WIN-144 ClickHouse namespace migration", () => {
  test("keeps every already-applied migration byte-identical", () => {
    const frozen = JSON.parse(readFileSync(fixturePath, "utf8")) as FrozenHistory;
    expect(frozen.throughVersion).toBe(33);
    expect(Object.keys(frozen.files)).toHaveLength(frozen.throughVersion);

    for (let version = 1; version <= frozen.throughVersion; version += 1) {
      const name = migration(version);
      expect(sha256(readFileSync(join(schemaRoot, name))), name).toBe(frozen.files[name]);
    }
  });

  test("rewires every materialized view in forward and rollback definitions", () => {
    const sql = readFileSync(join(schemaRoot, migration(34)), "utf8");
    const [up, down] = sql.split(/-- \+goose Down/i);

    expect([...activeHistoricalViews()].sort()).toEqual([...viewRoutes.keys()].sort());
    expect(viewDefinitions(up)).toEqual(viewRoutes);
    expect(viewDefinitions(down)).toEqual(viewRoutes);
    expect(up).not.toMatch(/CREATE MATERIALIZED VIEW[^;]*\bPOPULATE\b/is);
    expect(down).not.toMatch(/CREATE MATERIALIZED VIEW[^;]*\bPOPULATE\b/is);
    const statementIndex = (section: string, pattern: RegExp) => section.search(pattern);
    expect(statementIndex(up, /^DROP VIEW/m)).toBeLessThan(
      statementIndex(up, /^RENAME DATABASE/m)
    );
    expect(statementIndex(up, /^RENAME DATABASE/m)).toBeLessThan(
      statementIndex(up, /^CREATE MATERIALIZED VIEW/m)
    );
    expect(statementIndex(down, /^DROP VIEW/m)).toBeLessThan(
      statementIndex(down, /^RENAME DATABASE/m)
    );
    expect(statementIndex(down, /^RENAME DATABASE/m)).toBeLessThan(
      statementIndex(down, /^CREATE MATERIALIZED VIEW/m)
    );
  });

  test("rehearses source-to-destination routing across forward, rollback, and forward-again", () => {
    const sql = readFileSync(join(schemaRoot, migration(34)), "utf8");
    const [up, down] = sql.split(/-- \+goose Down/i);
    const source = up.match(/RENAME DATABASE\s+(\w+)\s+TO/i)?.[1];
    if (!source) throw new Error("forward source database is missing");

    const sourceNames = new Set([...viewRoutes.values()].map((route) => route.source));
    const destinationNames = new Set([...viewRoutes.values()].map((route) => route.destination));
    const tables = new Map<string, TableState>();
    for (const name of new Set([...sourceNames, ...destinationNames])) {
      tables.set(name, {
        uuid: sha256(`uuid:${name}`).slice(0, 32),
        engine: destinationNames.has(name) ? "aggregate-destination" : "source",
        rows: destinationNames.has(name) ? [sha256(`existing:${name}`)] : [],
      });
    }
    const catalog = new Map<string, DatabaseState>([
      [source, { tables, views: new Map(viewRoutes) }],
    ]);
    const initialDestinations = destinationCatalog(catalog.get(source)!);

    const target = applySection(catalog, up);
    expect(destinationCatalog(catalog.get(target)!)).toEqual(initialDestinations);
    insertThroughSources(catalog.get(target)!, "forward");
    const afterForward = destinationCatalog(catalog.get(target)!);

    const rollback = applySection(catalog, down);
    expect(destinationCatalog(catalog.get(rollback)!)).toEqual(afterForward);
    insertThroughSources(catalog.get(rollback)!, "rollback");
    const afterRollback = destinationCatalog(catalog.get(rollback)!);

    const forwardAgain = applySection(catalog, up);
    expect(destinationCatalog(catalog.get(forwardAgain)!)).toEqual(afterRollback);
    insertThroughSources(catalog.get(forwardAgain)!, "forward-again");

    for (const [, , engine, rows] of destinationCatalog(catalog.get(forwardAgain)!)) {
      expect(engine).toBe("aggregate-destination");
      expect(rows.length).toBeGreaterThanOrEqual(4);
    }
  });
});
