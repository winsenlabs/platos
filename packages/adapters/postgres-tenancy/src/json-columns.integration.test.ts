// The JSON decode boundary, measured against a real PostgreSQL.
//
// WIN-258 T7. `json-columns.test.ts` reconciles the census against files; this
// suite reconciles it against a DATABASE, and then tries to break the decoders
// with rows no TypeScript object could have produced.
//
// *** EVERY MALFORMED ROW HERE IS WRITTEN OUT OF BAND, BY `prisma db execute`.
// Not by building a bad object and handing it to a store — that only proves a
// function can be called with a bad argument, which was never in doubt. The
// writes below go through the Prisma CLI on a connection this adapter's pool
// never touches, so nothing in the write path can sanitise them and the value
// the decoder sees is the value the database is holding.
//
// THE SUITE SPLITS IN TWO, AND THE SPLIT IS THE FINDING.
//
//   REACHABLE. `Macro_steps_json_root` pins the ROOT of the column to an array
//   and says NOTHING about an element's members, so a step with no tool, and a
//   step whose `params` are not an object, are both storable by any writer. Both
//   are written here and read back through the port, and the second is the
//   coercion T7 found: it used to read back as `{}` and replay the tool with no
//   parameters at all.
//
//   REFUSED BY THE DATABASE. Every object-rooted column's CHECK refuses the
//   out-of-band write itself, with SQLSTATE 23514 naming the constraint. Those
//   decoders therefore CANNOT be turned red through a committed row, and this
//   suite says so by making the database do the refusing in front of a witness.
//   That is why `mutations-json.json` DECLARES them rather than counting them:
//   an unfalsifiable guard recorded as a kill is a lie about the evidence.
//
// THE PROJECTIONS ARE PINNED AGAINST THE EMITTED SQL, not against a row shape.
// The client's query log is the only place a SELECT list exists.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { EnvironmentScope } from "@platos/context-agents/application/ports/index.js";

import {
  AGENT_COLUMNS,
  BINDING_COLUMNS,
  CLUSTER_COLUMNS,
  MACRO_COLUMNS,
  TEMPLATE_COLUMNS,
  VERSION_COLUMNS,
} from "./agents-rows.js";
import {
  HOME_ENVIRONMENT,
  scopeOf,
  startAgentsHarness,
  type AgentsHarness,
  type SeededAgent,
} from "./agents-harness.js";
import { JSON_COLUMNS, jsonColumnKey, type JsonRoot } from "./json-columns.js";

let harness: AgentsHarness;
let agent: SeededAgent;
const SCOPE: EnvironmentScope = scopeOf(HOME_ENVIRONMENT);

const packageRoot = process.cwd();
const databasePackage = resolve(packageRoot, "../../../internal-packages/tenancy-database");
const prismaBinary = resolve(packageRoot, "../../../node_modules/.bin/prisma");
const scratch = mkdtempSync(resolve(tmpdir(), "pl-t7-json-"));

/**
 * Run one statement through the Prisma CLI, on its own connection.
 *
 * `db execute` takes a FILE and not a string, which is why the scratch directory
 * exists. The CLI's exit status is the signal: a refused statement exits
 * non-zero with the driver's message on stderr, and that message is what the
 * refusal cases below read the SQLSTATE and the constraint name out of.
 */
function outOfBand(sql: string): { readonly ok: boolean; readonly output: string } {
  const file = resolve(scratch, `stmt-${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(file, sql, "utf8");
  try {
    execFileSync(prismaBinary, ["db", "execute", "--url", harness.databaseUrl, "--file", file], {
      cwd: databasePackage,
      env: { ...process.env, DATABASE_URL: harness.databaseUrl },
      stdio: "pipe",
    });
    return { ok: true, output: "" };
  } catch (error) {
    const failure = error as { stderr?: Buffer; stdout?: Buffer; message?: string };
    return {
      ok: false,
      output: `${failure.stderr?.toString() ?? ""}${failure.stdout?.toString() ?? ""}${failure.message ?? ""}`,
    };
  }
}

/** A SQL string literal. Every value here is fixture JSON, never a caller's. */
function quoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Rewrite one row's JSON column out of band, keyed on its primary key. */
function setJson(model: string, column: string, id: string, json: string) {
  return outOfBand(
    `UPDATE "${model}" SET "${column}" = ${quoted(json)}::jsonb WHERE "id" = ${quoted(id)};`,
  );
}

beforeAll(async () => {
  harness = await startAgentsHarness();
  agent = await harness.seedAgent({ slug: "t7-json" });
}, 240_000);

afterAll(async () => {
  await harness?.stop();
});

describe("the census, reconciled against the live catalog", () => {
  test("every `_json_root` CHECK the census names is IN the database, and no other is", async () => {
    // `pg_constraint` and not the migration text: a migration that was written
    // and never applied is a claim, and this suite's job is to stop the census
    // resting on one.
    const rows = (await harness.client.$queryRawUnsafe(`
      SELECT rel.relname AS model, con.conname AS name, pg_get_constraintdef(con.oid) AS body
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE nsp.nspname = 'public' AND con.contype = 'c' AND con.conname LIKE '%\\_json\\_root'
      ORDER BY con.conname
    `)) as readonly { readonly model: string; readonly name: string; readonly body: string }[];

    const live = new Map<string, { readonly root: JsonRoot; readonly nullable: boolean }>();
    for (const row of rows) {
      const roots = [...new Set([...row.body.matchAll(/'(object|array)'/gu)].map((hit) => hit[1]))];
      const column = row.name.slice(row.model.length + 1, -"_json_root".length);
      live.set(`${row.model}.${column}`, {
        root: roots.sort().join("|") as JsonRoot,
        nullable: /IS NULL/u.test(row.body),
      });
    }

    expect([...live.keys()].sort()).toEqual(JSON_COLUMNS.map(jsonColumnKey).sort());
    for (const contract of JSON_COLUMNS) {
      expect([jsonColumnKey(contract), live.get(jsonColumnKey(contract))]).toEqual([
        jsonColumnKey(contract),
        { root: contract.root, nullable: contract.nullable },
      ]);
    }
  });

  test("the CHECKs are NOT `NOT VALID`: PostgreSQL is enforcing all forty-nine", async () => {
    // A constraint added `NOT VALID` sits in the catalog and binds new rows only.
    // The census claims the root is a fact about EVERY row, so the distinction is
    // the difference between that claim and a weaker one.
    const rows = (await harness.client.$queryRawUnsafe(`
      SELECT count(*)::int AS pending
      FROM pg_constraint con
      WHERE con.contype = 'c' AND con.conname LIKE '%\\_json\\_root' AND con.convalidated = false
    `)) as readonly { readonly pending: number }[];
    expect(rows[0]?.pending).toBe(0);
  });
});

describe("the interior a CHECK does not reach, written out of band", () => {
  test("a step whose params are an ARRAY is stored, and is REFUSED on the way back", async () => {
    const macro = await harness.seedMacro({ name: "t7-params-array" });
    const written = setJson("Macro", "steps", macro.macroId, '[{"tool":"send","params":["a","b"]}]');
    // THE DATABASE ACCEPTS IT. That is the finding: the root is an array, which
    // is all `Macro_steps_json_root` asks, and an element's members are nobody's
    // business but the decoder's.
    expect(written.ok).toBe(true);

    await expect(harness.scaffolding.findMacro(SCOPE, macro.macroId)).rejects.toThrow(
      /step 0 carries a JSON array where params is an object/u,
    );
    // AND THE ROW IS STILL THERE. A refusal that had deleted or rewritten it
    // would be a repair, and this store does not repair rows it cannot read.
    const [held] = (await harness.client.$queryRawUnsafe(
      `SELECT "steps"::text AS steps FROM "Macro" WHERE "id" = ${quoted(macro.macroId)}`,
    )) as readonly { readonly steps: string }[];
    expect(held?.steps).toContain('"params": ["a", "b"]');
  });

  test("a step whose params are a STRING reads back as a refusal, not as no parameters", async () => {
    // The regression, stated as the value the old reader produced. Kept as a case
    // rather than a comment so an edit that reintroduces the coercion has to
    // delete an assertion naming it.
    const macro = await harness.seedMacro({ name: "t7-params-string" });
    expect(setJson("Macro", "steps", macro.macroId, '[{"tool":"send","params":"oops"}]').ok).toBe(true);
    await expect(harness.scaffolding.findMacro(SCOPE, macro.macroId)).rejects.toThrow(
      /step 0 carries string where params is an object/u,
    );
  });

  test("a step that names no tool is stored, and is REFUSED with its own code", async () => {
    const macro = await harness.seedMacro({ name: "t7-no-tool" });
    expect(setJson("Macro", "steps", macro.macroId, '[{"params":{}}]').ok).toBe(true);
    await expect(harness.scaffolding.findMacro(SCOPE, macro.macroId)).rejects.toThrow(
      /step 0 names no tool/u,
    );
  });

  test("a LISTING refuses the page rather than answering with one blank macro", async () => {
    // `listMacros` reads the same rows. A decoder that answered a default inside
    // the `map` would hand an operator a page in which one macro had silently
    // lost its steps, which is the outcome this refusal exists to prevent.
    const macro = await harness.seedMacro({ name: "t7-listing", shared: true });
    expect(setJson("Macro", "steps", macro.macroId, '[{"tool":"send","params":9}]').ok).toBe(true);
    await expect(harness.scaffolding.listMacros(SCOPE, { actorId: null, limit: 50 })).rejects.toThrow(
      /step 0 carries number where params is an object/u,
    );
  });
});

describe("the roots a CHECK does reach: the DATABASE does the refusing", () => {
  test("Macro.steps cannot hold a scalar root", async () => {
    const macro = await harness.seedMacro({ name: "t7-root-steps" });
    const refusal = setJson("Macro", "steps", macro.macroId, '"not an array"');
    expect(refusal.ok).toBe(false);
    // 23514 AND the constraint's own name. Matching the message alone would pass
    // on any failed statement, including one that failed on a misspelled table.
    expect(refusal.output).toContain("23514");
    expect(refusal.output).toContain("Macro_steps_json_root");
  });

  test("Macro.paramSchema cannot hold an array root", async () => {
    const macro = await harness.seedMacro({ name: "t7-root-schema" });
    const refusal = setJson("Macro", "paramSchema", macro.macroId, "[1,2]");
    expect(refusal.ok).toBe(false);
    expect(refusal.output).toContain("Macro_paramSchema_json_root");
  });

  test("AgentCluster.metadata cannot hold a number root", async () => {
    const cluster = await harness.seedCluster({ slug: "t7-root-cluster" });
    const refusal = setJson("AgentCluster", "metadata", cluster.clusterId, "3");
    expect(refusal.ok).toBe(false);
    expect(refusal.output).toContain("AgentCluster_metadata_json_root");
  });

  test("PostmanTemplate.sessionContext cannot hold an array root", async () => {
    const template = await harness.seedTemplate({ name: "t7-root-template", agent });
    const refusal = setJson("PostmanTemplate", "sessionContext", template.templateId, "[]");
    expect(refusal.ok).toBe(false);
    expect(refusal.output).toContain("PostmanTemplate_sessionContext_json_root");
  });

  test("Event.payload cannot be INSERTED with an array root", () => {
    // The kernel outbox's column, refused on the way IN rather than on an update,
    // because the drain's own reader is the one this evidence stands behind.
    const refusal = outOfBand(
      `INSERT INTO "Event" ("id", "environmentId", "eventType", "subjectId", "payload", "createdAt")
       VALUES (gen_random_uuid(), ${quoted(HOME_ENVIRONMENT)}, 't7.probe', NULL, '[]'::jsonb, now());`,
    );
    expect(refusal.ok).toBe(false);
    expect(refusal.output).toContain("Event_payload_json_root");
  });

  test("the refusals are the CHECKs and not the columns: a valid root is accepted", async () => {
    // The other half of every pair above. Without it they would all pass on a
    // database in which those columns simply refused every write.
    const cluster = await harness.seedCluster({ slug: "t7-root-good" });
    expect(setJson("AgentCluster", "metadata", cluster.clusterId, '{"ok":true}').ok).toBe(true);
    expect(
      outOfBand(
        `INSERT INTO "Event" ("id", "environmentId", "eventType", "subjectId", "payload", "createdAt")
         VALUES (gen_random_uuid(), ${quoted(HOME_ENVIRONMENT)}, 't7.probe', NULL, '{}'::jsonb, now());`,
      ).ok,
    ).toBe(true);
  });
});

describe("the selectors name their columns to the client", () => {
  /** The SELECT list of the last statement the client sent that reads one table. */
  function selectedColumns(table: string): readonly string[] {
    const statement = [...harness.statements()]
      .reverse()
      .find((text) => text.startsWith("SELECT") && text.includes(`"public"."${table}"`));
    expect(statement).toBeDefined();
    const list = /SELECT (.*?) FROM/su.exec(statement ?? "")?.[1] ?? "";
    return [...list.matchAll(/"[^"]+"\."[^"]+"\."([^"]+)"/gu)].map((hit) => hit[1] ?? "");
  }

  test("a macro listing reads the ten columns `MacroRow` declares and no other", async () => {
    await harness.seedMacro({ name: "t7-select-macro", shared: true });
    harness.resetStatements();
    // The listing refuses on the malformed rows above, so the read is made
    // through `findMacro` on a row this case owns; the SELECT list is the same
    // projection either way.
    const macro = await harness.seedMacro({ name: "t7-select-only" });
    harness.resetStatements();
    await harness.scaffolding.findMacro(SCOPE, macro.macroId);
    expect(new Set(selectedColumns("Macro"))).toEqual(new Set(Object.keys(MACRO_COLUMNS)));
  });

  test("a version listing names the seventeen columns the envelope is built from", async () => {
    harness.resetStatements();
    await harness.repository.listVersions(agent.agent.agentId);
    expect(new Set(selectedColumns("AgentVersion"))).toEqual(new Set(Object.keys(VERSION_COLUMNS)));
  });

  test("a bound read names each relation's columns, and stops at them", async () => {
    harness.resetStatements();
    await harness.repository.findBoundAgent(SCOPE, agent.agent.agentId);
    expect(new Set(selectedColumns("AgentBinding"))).toEqual(new Set(Object.keys(BINDING_COLUMNS)));
    expect(new Set(selectedColumns("Agent"))).toEqual(new Set(Object.keys(AGENT_COLUMNS)));
    expect(new Set(selectedColumns("AgentVersion"))).toEqual(new Set(Object.keys(VERSION_COLUMNS)));
  });

  test("a cluster listing names the eight columns `AgentClusterRow` declares", async () => {
    harness.resetStatements();
    await harness.repository.listClusters(SCOPE);
    expect(new Set(selectedColumns("AgentCluster"))).toEqual(new Set(Object.keys(CLUSTER_COLUMNS)));
  });

  test("a template listing names the ten columns `PostmanTemplateRow` declares", async () => {
    harness.resetStatements();
    await harness.scaffolding.listTemplatesFor(SCOPE, agent.agent.agentId);
    expect(new Set(selectedColumns("PostmanTemplate"))).toEqual(new Set(Object.keys(TEMPLATE_COLUMNS)));
  });
});
