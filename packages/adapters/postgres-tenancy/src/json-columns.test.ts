// The census in `json-columns.ts`, reconciled against the three things it
// claims to describe: the Prisma schema, the migrations' CHECK text, and the
// decoder symbols this package actually carries.
//
// THIS SUITE READS FILES RATHER THAN IMPORTING THEM, and that is the point. A
// registry that imported the schema would be describing whatever the generated
// client happens to expose; one that imported each decoder would pass on a
// symbol re-exported from somewhere else. Both drifts are exactly what a census
// is for, so every join below is made against the TEXT on disk.
//
// It runs in the unit suite and needs no container: the migrations are files.
// `json-columns.integration.test.ts` makes the fourth join — against
// `pg_constraint` on a live database — because a migration that was never
// applied is a claim and not a constraint.

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  AGENT_COLUMNS,
  BINDING_COLUMNS,
  CLUSTER_COLUMNS,
  MACRO_COLUMNS,
  SKILL_COLUMNS,
  TEMPLATE_COLUMNS,
  VERSION_COLUMNS,
} from "./agents-rows.js";
import { JSON_COLUMNS, jsonColumnKey, type JsonRoot } from "./json-columns.js";
import { EVENT_SELECT } from "./outbox-store.js";
import { TOOL_SELECT } from "./tools-catalogue.js";
import { CONFIG_SELECT } from "./tools-mcp.js";
import { AUDIT_SELECT, CALL_SELECT } from "./tools-transcript.js";

const packageRoot = process.cwd();
const repositoryRoot = resolve(packageRoot, "../../..");
const prismaRoot = resolve(repositoryRoot, "internal-packages/tenancy-database/prisma");

/** Every `<field> Json` declaration in one Prisma schema file, keyed `Model.field`. */
function jsonFieldsOf(file: string): Map<string, boolean> {
  const found = new Map<string, boolean>();
  let model: string | null = null;
  for (const raw of readFileSync(resolve(prismaRoot, file), "utf8").split("\n")) {
    const line = raw.trim();
    const declaration = /^model\s+(\w+)\s*\{/u.exec(line);
    if (declaration) {
      model = declaration[1] ?? null;
      continue;
    }
    if (line === "}") {
      model = null;
      continue;
    }
    const field = /^(\w+)\s+Json(\?)?(\s|$)/u.exec(line);
    if (model !== null && field) found.set(`${model}.${field[1]}`, field[2] === "?");
  }
  return found;
}

/** Every `_json_root` CHECK in every migration, with the roots and the null arm it admits. */
function jsonRootChecks(): Map<string, { readonly root: JsonRoot; readonly nullable: boolean }> {
  const migrations = resolve(prismaRoot, "migrations");
  const found = new Map<string, { root: JsonRoot; nullable: boolean }>();
  for (const entry of readdirSync(migrations, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // Newlines are folded first: several of the CHECKs are wrapped across three
    // lines, and a per-line scan silently misses exactly those.
    const sql = readFileSync(resolve(migrations, entry.name, "migration.sql"), "utf8").replace(
      /\s+/gu,
      " ",
    );
    const pattern = /CONSTRAINT "(\w+)_(\w+)_json_root" CHECK \((.*?)\);/gu;
    for (const match of sql.matchAll(pattern)) {
      const [, model = "", column = "", body = ""] = match;
      const roots = [...body.matchAll(/'(object|array)'/gu)].map((hit) => hit[1]);
      // NOT sorted: the CHECK's own order is the contract's order, and
      // `IN ('object', 'array')` is how the two dual-root columns are written.
      found.set(`${model}.${column}`, {
        root: [...new Set(roots)].join("|") as JsonRoot,
        nullable: body.includes("IS NULL"),
      });
    }
  }
  return found;
}

/** The `Model.column` keys of the census, in the order the census declares them. */
const censusKeys = JSON_COLUMNS.map(jsonColumnKey);

describe("the census names every Json column and nothing else", () => {
  test("it agrees with schema.prisma and end-user.prisma, joined", () => {
    const declared = new Map([...jsonFieldsOf("schema.prisma"), ...jsonFieldsOf("end-user.prisma")]);
    expect([...declared.keys()].sort()).toEqual([...censusKeys].sort());
  });

  test("it names each column exactly once", () => {
    expect(new Set(censusKeys).size).toBe(censusKeys.length);
  });

  // Grouped and not alphabetised WITHIN a model: `AdminAudit.before` is declared
  // ahead of `AdminAudit.after` because that is the order the pair is written and
  // read in, and a reader looking for one of them finds the other beside it.
  test("it is grouped by model, models in order, each model's rows contiguous", () => {
    const models = JSON_COLUMNS.map((contract) => contract.model);
    const firstSeen = models.filter((model, index) => models.indexOf(model) === index);
    expect(firstSeen).toEqual([...firstSeen].sort((left, right) => left.localeCompare(right)));
    for (const model of firstSeen) {
      const positions = models.flatMap((seen, index) => (seen === model ? [index] : []));
      expect(positions.at(-1)! - positions[0]!).toBe(positions.length - 1);
    }
  });
});

describe("the census agrees with the migrations that pin the roots", () => {
  const checks = jsonRootChecks();

  test("every Json column carries a `_json_root` CHECK", () => {
    expect([...checks.keys()].sort()).toEqual([...censusKeys].sort());
  });

  // ONE CASE OVER FORTY-NINE COLUMNS, not forty-nine cases. `test.each` over a
  // computed table has no statically visible row count, and
  // `scripts/arch/test-case-census.mjs` refuses one for exactly that reason: a
  // census that cannot count a suite's cases cannot notice one going missing.
  // The column name is carried INTO each assertion so a failure still names the
  // column that failed.
  test("every census root and null arm is the CHECK's own", () => {
    for (const contract of JSON_COLUMNS) {
      const key = jsonColumnKey(contract);
      expect([key, checks.get(key)]).toEqual([
        key,
        { root: contract.root, nullable: contract.nullable },
      ]);
    }
  });

  test("the CHECK's null arm is the schema's own optionality", () => {
    const declared = new Map([...jsonFieldsOf("schema.prisma"), ...jsonFieldsOf("end-user.prisma")]);
    for (const contract of JSON_COLUMNS) {
      expect([jsonColumnKey(contract), declared.get(jsonColumnKey(contract))]).toEqual([
        jsonColumnKey(contract),
        contract.nullable,
      ]);
    }
  });
});

describe("every named decoder exists where the census says it does", () => {
  /** `<module>.<symbol>` resolved to the file the symbol has to be declared in. */
  function moduleFileOf(decoder: string): string {
    const module = decoder.slice(0, decoder.lastIndexOf("."));
    return module.includes("/")
      ? resolve(repositoryRoot, "packages", `${module}.ts`)
      : resolve(packageRoot, "src", `${module}.ts`);
  }

  // One case again, and for the same reason as the roots above.
  test("every named decoder is a symbol declared in the module named", () => {
    for (const contract of JSON_COLUMNS) {
      if (contract.decoder === "") continue;
      const symbol = contract.decoder.slice(contract.decoder.lastIndexOf(".") + 1);
      const source = readFileSync(moduleFileOf(contract.decoder), "utf8");
      // `function` and not `export function`: a decoder private to its module is
      // still the boundary, and requiring an export would push modules to widen
      // their surface for the census's benefit.
      expect([contract.decoder, new RegExp(`\\bfunction ${symbol}\\b`, "u").test(source)]).toEqual([
        contract.decoder,
        true,
      ]);
    }
  });

  test("a decoder is named exactly when the disposition implies one", () => {
    for (const contract of JSON_COLUMNS) {
      const named = contract.decoder !== "";
      const expected = contract.disposition !== "unowned" && contract.disposition !== "unprojected";
      expect([jsonColumnKey(contract), named]).toEqual([jsonColumnKey(contract), expected]);
    }
  });

  test("an owner is named exactly when a store owns the write", () => {
    for (const contract of JSON_COLUMNS) {
      const owned = contract.owner !== "-";
      expect([jsonColumnKey(contract), owned]).toEqual([
        jsonColumnKey(contract),
        contract.disposition !== "unowned",
      ]);
    }
  });

  test("every note says something, and says it once", () => {
    const notes = JSON_COLUMNS.map((contract) => contract.note);
    for (const note of notes) expect(note.length).toBeGreaterThan(30);
    // Repeated notes are allowed only where the census itself says "the same
    // decoder on another row"; a note repeated anywhere else is a row somebody
    // pasted rather than argued for.
    const repeated = notes.filter((note, index) => notes.indexOf(note) !== index);
    for (const note of repeated) expect(note).toMatch(/the same (decoder|envelope|table|function)/u);
  });
});

describe("the column maps are the SCHEMA's column list, not their own", () => {
  // WIN-258 T7, AND THE SWEEP FOUND THIS ONE. The projection assertions in the
  // integration suite compare the emitted SELECT list against the map, which is
  // circular: dropping a column from a map shrinks BOTH sides and the assertion
  // stays green. The map has to be joined to something that is not itself, and
  // the schema is the only such thing. Dropping `environmentId` from
  // `MACRO_COLUMNS` goes red HERE.
  const models = new Set([...readFileSync(resolve(prismaRoot, "schema.prisma"), "utf8").matchAll(/^model\s+(\w+)\s*\{/gmu)].map((hit) => hit[1] ?? ""));

  /** Every field of one model that is a COLUMN rather than a relation. */
  function columnsOf(model: string): readonly string[] {
    const body = new RegExp(`^model ${model} \\{$([\\s\\S]*?)^\\}$`, "mu").exec(
      readFileSync(resolve(prismaRoot, "schema.prisma"), "utf8"),
    )?.[1];
    expect(body).toBeDefined();
    return (body ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\w+\s+\S/u.test(line) && !line.startsWith("@@"))
      .map((line) => line.split(/\s+/u))
      .filter(([, type = ""]) => !models.has(type.replace(/[?[\]]/gu, "")))
      .map(([field = ""]) => field);
  }

  test.each([
    ["Agent", AGENT_COLUMNS],
    ["AgentBinding", BINDING_COLUMNS],
    ["AgentCluster", CLUSTER_COLUMNS],
    ["AgentVersion", VERSION_COLUMNS],
    ["AgentSkill", SKILL_COLUMNS],
    ["Macro", MACRO_COLUMNS],
    ["PostmanTemplate", TEMPLATE_COLUMNS],
    ["Event", EVENT_SELECT],
    ["Tool", TOOL_SELECT],
    ["EntityMcpConfig", CONFIG_SELECT],
    ["ToolCall", CALL_SELECT],
    ["ToolCallAudit", AUDIT_SELECT],
  ] as const)("%s's map names every column the model has", (model, map) => {
    expect([...Object.keys(map)].sort()).toEqual([...columnsOf(model)].sort());
  });
});

describe("the counts the census is quoted by", () => {
  test("forty-nine columns, and the disposition split that WIN-258 reports", () => {
    expect(JSON_COLUMNS.length).toBe(49);
    const split: Record<string, number> = {};
    for (const contract of JSON_COLUMNS) {
      split[contract.disposition] = (split[contract.disposition] ?? 0) + 1;
    }
    expect(split).toEqual({
      refuse: 26,
      carry: 13,
      delegate: 6,
      unprojected: 2,
      unowned: 2,
    });
  });

  test("the two dual-root columns are the two the audit trail's results live in", () => {
    const dual = JSON_COLUMNS.filter((contract) => contract.root === "object|array").map(
      jsonColumnKey,
    );
    expect(dual).toEqual(["ToolCall.result", "ToolCallAudit.result"]);
  });
});
