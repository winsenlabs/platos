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

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function migration(version: number): string {
  const prefix = `${String(version).padStart(3, "0")}_`;
  const name = readdirSync(schemaRoot).find((entry) => entry.startsWith(prefix));
  if (!name) throw new Error(`missing ClickHouse migration ${version}`);
  return name;
}

function applyRename(catalog: Map<string, Map<string, string>>, sql: string): void {
  const statement = sql.match(/RENAME DATABASE\s+(\w+)\s+TO\s+(\w+)/i);
  if (!statement) throw new Error("migration does not contain a database rename");
  const [, source, target] = statement;
  const sourceTables = catalog.get(source);
  if (!sourceTables) throw new Error(`source database ${source} is missing`);
  if (catalog.has(target)) throw new Error(`target database ${target} already exists`);
  catalog.delete(source);
  catalog.set(target, sourceTables);
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

  test("rehearses forward, rollback, and forward-again without losing rows", () => {
    const sql = readFileSync(join(schemaRoot, migration(34)), "utf8");
    const [up, down] = sql.split(/-- \+goose Down/i);
    const source = up.match(/RENAME DATABASE\s+(\w+)\s+TO/i)?.[1];
    if (!source) throw new Error("forward source database is missing");

    const rows = new Map([
      ["metrics_v1", sha256("metric-row-1\nmetric-row-2")],
      ["platos_spans_v1", sha256("span-row-1")],
      [["task", "_runs_v2"].join(""), sha256("private-external-runtime-row")],
    ]);
    const expected = [...rows.entries()];
    const catalog = new Map([[source, rows]]);

    applyRename(catalog, up);
    expect([...catalog.get("platos_telemetry")!.entries()]).toEqual(expected);
    expect(catalog.has(source)).toBe(false);

    applyRename(catalog, down);
    expect([...catalog.get(source)!.entries()]).toEqual(expected);
    expect(catalog.has("platos_telemetry")).toBe(false);

    applyRename(catalog, up);
    expect([...catalog.get("platos_telemetry")!.entries()]).toEqual(expected);
  });
});
