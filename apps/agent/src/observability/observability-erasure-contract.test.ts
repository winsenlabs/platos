/**
 * The DDL and the erasure plan are one contract, enforced here.
 *
 * WIN-131 built the erasure side against tables that did not exist yet, so its
 * acceptance was vacuous on four of its five tables: the schema probe found
 * nothing and skipped them. WIN-133 creates them, which means those code paths
 * go live — and the failure mode is quiet. A renamed column does not break a
 * query; it makes `effectiveTable()` mark the table unaddressable, and the
 * receipt then says "schema drift" instead of "erased". This file is the test
 * that turns that into a red build.
 *
 * It reads the committed .sql rather than a running ClickHouse deliberately:
 * the schema is the artifact under review, and per the issue owner this
 * milestone does not stand an instance up.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  CLICKHOUSE_ERASURE_PLAN,
  OBSERVABILITY_DATABASE as ERASURE_OBSERVABILITY_DATABASE,
} from "../privacy/clickhouse-erasure";
import {
  ERASURE_URL_VARIABLES,
  ErasureClickhouse,
  parseClickhouseEndpoint,
  readErasureClickhouseUrl,
} from "../privacy/clickhouse";
import {
  OBSERVABILITY_DATABASE,
  OBSERVABILITY_TABLES,
  OBSERVABILITY_URL_VARIABLES,
  parseObservabilityEndpoint,
  readObservabilityUrl,
} from "./observability-config";

const ddlPath = resolve(
  __dirname,
  "../../../../internal-packages/clickhouse/schema/033_create_platos_observability_v1.sql",
);
const ddl = readFileSync(ddlPath, "utf8");

/** Column names declared inside one CREATE TABLE body. */
function columnsOf(table: string): Set<string> {
  const start = ddl.indexOf(`CREATE TABLE IF NOT EXISTS ${OBSERVABILITY_DATABASE}.${table}\n(`);
  expect(start, `${table} is not created by the DDL`).toBeGreaterThan(-1);
  const body = ddl.slice(start, ddl.indexOf("ENGINE =", start));
  const columns = new Set<string>();
  for (const line of body.split("\n")) {
    const match = /^\s{2}([a-z_][a-z0-9_]*)\s+[A-Za-z]/.exec(line);
    // Skip INDEX declarations, which match the shape of a column otherwise.
    if (match && !line.trimStart().startsWith("INDEX ")) columns.add(match[1]);
  }
  return columns;
}

const plan = CLICKHOUSE_ERASURE_PLAN.filter((spec) => spec.database === OBSERVABILITY_DATABASE);

describe("the DDL and the erasure plan name the same database", () => {
  test("both modules agree on platos_observability, independently", () => {
    expect(OBSERVABILITY_DATABASE).toBe("platos_observability");
    expect(ERASURE_OBSERVABILITY_DATABASE).toBe(OBSERVABILITY_DATABASE);
    expect(ddl).toContain(`CREATE DATABASE IF NOT EXISTS ${OBSERVABILITY_DATABASE}`);
  });

  test("the plan covers every table the projection writes", () => {
    expect(plan.map((spec) => spec.table).sort()).toEqual([...OBSERVABILITY_TABLES].sort());
  });

  test("no database, table or column carries trigger vocabulary", () => {
    // Zero trigger residue in NAMING. Prose is exempt — the header explains
    // what the database is deliberately not called — so comments are stripped
    // before the check, which is also what keeps this assertion about
    // identifiers rather than about wording.
    const identifiers = ddl
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .toLowerCase();
    const forbidden = [
      "platos_telemetry",
      "task_run",
      "taskrun",
      "waitpoint",
      "checkpoint",
      ["worker", ["deploy", "ment"].join("")].join("_"),
      "queue_concurrency",
      "attempt_number",
    ];
    for (const word of forbidden) {
      expect(identifiers, `DDL names ${word}`).not.toContain(word);
    }
  });
});

describe("every table erasure addresses is addressable", () => {
  for (const spec of plan) {
    test(`${spec.table} carries the columns the mutation needs`, () => {
      const columns = columnsOf(spec.table);
      // `effectiveTable()` requires organization_id plus at least one locator,
      // or it sets addressable=false and the receipt reports schema drift.
      expect(columns.has("organization_id"), "organization_id").toBe(true);
      for (const column of spec.subjectIdColumns) {
        expect(columns.has(column), `${spec.table}.${column}`).toBe(true);
      }
      expect(columns.has(spec.threadColumn!), `${spec.table}.${spec.threadColumn}`).toBe(true);
      expect(columns.has(spec.subjectHashColumn!), `${spec.table}.${spec.subjectHashColumn}`)
        .toBe(true);
    });

    test(`${spec.table} carries every column the mutation clears`, () => {
      const columns = columnsOf(spec.table);
      expect(spec.action.kind).toBe("clear");
      if (spec.action.kind !== "clear") return;
      for (const cleared of spec.action.columns) {
        expect(columns.has(cleared.name), `${spec.table}.${cleared.name}`).toBe(true);
      }
    });
  }
});

describe("identity columns can actually be emptied", () => {
  test("no identity column is MATERIALIZED or defaulted to a non-empty value", () => {
    // Verification asserts no row STILL CARRIES identity via
    // `coalesce(col, '') != ''`. A MATERIALIZED or non-empty-DEFAULT identity
    // column would repopulate itself and make that count a lie.
    const identityColumns = new Set<string>();
    for (const spec of plan) {
      for (const column of spec.subjectIdColumns) identityColumns.add(column);
      if (spec.action.kind === "clear") {
        for (const cleared of spec.action.columns) identityColumns.add(cleared.name);
      }
    }
    expect(identityColumns.size).toBeGreaterThan(0);

    for (const line of ddl.split("\n")) {
      const match = /^\s{2}([a-z_][a-z0-9_]*)\s+/.exec(line);
      if (!match || !identityColumns.has(match[1])) continue;
      expect(line, `${match[1]} is MATERIALIZED`).not.toContain("MATERIALIZED");
      const defaulted = /\bDEFAULT\s+(\S+)/.exec(line);
      if (defaulted) {
        expect(defaulted[1], `${match[1]} defaults to a non-empty value`).toBe("''");
      }
    }
  });

  test("the plan clears the plaintext columns to NULL, and the DDL makes them Nullable", () => {
    const turns = plan.find((spec) => spec.table === "turns_v1");
    expect(turns?.action.kind).toBe("clear");
    if (turns?.action.kind !== "clear") return;
    const nulled = turns.action.columns.filter((c) => c.to === "NULL").map((c) => c.name);
    expect(nulled).toEqual(["user_display_name", "user_email"]);
    for (const column of nulled) {
      expect(ddl).toMatch(new RegExp(`^\\s{2}${column} Nullable\\(String\\)`, "m"));
    }
  });

  test("only turns_v1 declares plaintext identity, matching the plan", () => {
    // Adding a plaintext identity column anywhere else requires adding it to
    // CLICKHOUSE_ERASURE_PLAN and to its negative verification test in the same
    // change. This is the assertion that notices when it was not.
    for (const table of OBSERVABILITY_TABLES) {
      const columns = columnsOf(table);
      const plaintext = [...columns].filter(
        (column) => column.includes("email") || column.includes("display_name")
          || column.includes("phone") || column.includes("handle"),
      );
      expect(plaintext.sort(), `${table} plaintext identity columns`).toEqual(
        table === "turns_v1" ? ["user_display_name", "user_email"] : [],
      );
    }
  });
});

describe("the writer and the eraser resolve the same endpoint", () => {
  // They deliberately do not import each other: the module whose only job is
  // destroying data must not depend on the runtime that produces it. The cost
  // is that the two resolutions can drift, and a writer pointing at a store the
  // eraser never probes is a store that quietly retains erased people.
  const cases = [
    "http://default:pwd@clickhouse:8123?secure=false",
    "https://user%40platos:p%3Fwd@host:8443/",
    "https://proxy.example/clickhouse/",
    "clickhouse://host:9000",
    "",
  ];

  for (const raw of cases) {
    test(`agree on "${raw || "(empty)"}"`, () => {
      expect(parseObservabilityEndpoint(raw)).toEqual(parseClickhouseEndpoint(raw));
    });
  }

  test("the eraser reads every variable the writer may have written through", () => {
    // The writer's precedence list is the superset; if the eraser did not read
    // one of them, an installation configured through it would be unerasable.
    expect([...ERASURE_URL_VARIABLES]).toEqual([...OBSERVABILITY_URL_VARIABLES]);
  });

  // The previous version of this pinned the variable NAMES by grepping the
  // eraser's source text. That is green for a resolver that reads all three
  // names in the right order and still disagrees about which one wins — which
  // is exactly what a `??` chain does, because compose passes an unset variable
  // through as the empty string and `??` treats "" as a value. These exercise
  // precedence and blank-handling instead of spelling.
  const environments: Array<{ name: string; env: Record<string, string | undefined> }> = [
    { name: "nothing set", env: {} },
    { name: "every variable blank", env: blankAll() },
    {
      name: "the dedicated variable wins over the legacy ones",
      env: {
        PLATOS_OBSERVABILITY_CLICKHOUSE_URL: "http://dedicated:8123",
        PLATOS_OTEL_CLICKHOUSE_URL: "http://otel:8123",
        CLICKHOUSE_URL: "http://webapp:8123",
      },
    },
    {
      // The compose shape that broke this: the dedicated variable is declared
      // and unset, so it arrives as "". A nullish chain resolves to "" and the
      // eraser reports not_provisioned — settling the erasure — while the
      // writer is putting names and emails into the OTEL endpoint.
      name: "a blank dedicated variable falls through to the OTEL endpoint",
      env: {
        PLATOS_OBSERVABILITY_CLICKHOUSE_URL: "",
        PLATOS_OTEL_CLICKHOUSE_URL: "http://ch:8123",
        CLICKHOUSE_URL: "",
      },
    },
    {
      name: "whitespace is blank too",
      env: { PLATOS_OBSERVABILITY_CLICKHOUSE_URL: "   ", CLICKHOUSE_URL: "http://webapp:8123" },
    },
    {
      name: "only the webapp variable is set",
      env: { CLICKHOUSE_URL: "http://default:pwd@webapp:8123?secure=false" },
    },
  ];

  for (const { name, env } of environments) {
    test(`writer and eraser resolve the same endpoint: ${name}`, () => {
      const writer = readObservabilityUrl(env);
      const eraser = readErasureClickhouseUrl(env);
      expect(eraser).toEqual(writer);
      // `configured` is what decides not_provisioned on one side and "queue the
      // projection" on the other, so the booleans have to agree too.
      expect(eraser !== null).toBe(writer !== null);
      expect(parseClickhouseEndpoint(eraser?.raw)).toEqual(
        parseObservabilityEndpoint(writer?.raw),
      );
    });
  }

  test("the live eraser resolves the endpoint the writer chose, not an empty one", () => {
    // ErasureClickhouse reads process.env in its constructor, so the empty-
    // string case has to be exercised through the real object as well as
    // through the pure function.
    const previous = { ...process.env };
    try {
      process.env.PLATOS_OBSERVABILITY_CLICKHOUSE_URL = "";
      process.env.PLATOS_OTEL_CLICKHOUSE_URL = "http://ch:8123";
      delete process.env.CLICKHOUSE_URL;
      expect(new ErasureClickhouse().available).toBe(true);
    } finally {
      for (const name of OBSERVABILITY_URL_VARIABLES) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
    }
  });
});

/** Every endpoint variable declared and empty — the compose default. */
function blankAll(): Record<string, string | undefined> {
  return Object.fromEntries(OBSERVABILITY_URL_VARIABLES.map((name) => [name, ""]));
}
