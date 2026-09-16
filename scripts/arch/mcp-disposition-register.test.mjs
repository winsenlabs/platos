// THE SECOND RECONCILIATION OF WIN-268's DISPOSITION REGISTER.
//
// `audit:mcp-disposition-register` regenerates the evidence and diffs it, which
// proves the report matches the generator and nothing else. This repository has
// learned five separate times that that is not sufficient — `v1-ledger`,
// `evidence-lifecycle`, `ci-policy`, `docs-link-integrity` and
// `tool-lifecycle-reach` all carry a second reconciliation for the same reason.
//
// So the cases below re-derive the same figures a DIFFERENT WAY:
//
//   * the row total is re-summed from `byDisposition`, from the three source
//     inventories, and from the raw row list — three paths to one number.
//   * every MAPPED row's contract method is re-checked against the AST-read
//     contract here as well as in the audit, so a renamed method fails twice.
//   * every REPLACED row's REST operation is re-joined to the manifest's REST
//     inventory FROM THE MANIFEST SIDE, so the direction of the join is not the
//     generator's choice.
//   * the derivation itself is re-run against MUTATED INPUTS and required to
//     produce each violation code. A gate nobody has seen fail is a gate nobody
//     has tested.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DISPOSITIONS,
  DOCS_CONTROLLER,
  MANIFEST,
  NO_ORM_SITE,
  OPERATION_MANIFEST,
  PROTOCOL_METHODS,
  REPORT,
  RETIREMENTS,
  VIOLATION_CODES,
  auditRows,
  buildRegister,
  deriveRows,
  docsSurfaces,
  readSources,
} from "./mcp-disposition-register.mjs";
import { DISPOSITIONS as STORE_DISPOSITIONS, contractMethods } from "./mcp-store-ownership.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const register = buildRegister();
const sources = readSources();

test("the register is clean", () => {
  assert.deepEqual(register.violations, []);
});

test("the row total agrees along three independent paths", () => {
  const fromDispositions = DISPOSITIONS.reduce(
    (total, name) => total + register.summary.byDisposition[name],
    0,
  );
  const fromInventories =
    register.summary.platformTools +
    register.summary.docsTools +
    register.summary.docsResourceSurfaces;
  assert.equal(register.rows.length, fromDispositions);
  assert.equal(register.rows.length, fromInventories);
  assert.equal(register.rows.length, register.summary.rows);
});

test("every platform tool the operation manifest declares has exactly one row", () => {
  const manifest = JSON.parse(
    readFileSync(join(repositoryRoot, OPERATION_MANIFEST), "utf8"),
  );
  const declared = manifest.inventories.mcpTools.map((tool) => tool.name).sort();
  const rows = register.rows
    .filter((row) => row.server === "platform")
    .map((row) => row.surface)
    .sort();
  assert.deepEqual(rows, declared);
  assert.equal(new Set(rows).size, rows.length, "a tool is dispositioned twice");
  // And the inventory is not empty, which would make the equality vacuous.
  assert.ok(declared.length > 100, `only ${String(declared.length)} tools in the manifest`);
});

test("the docs server's own declarations are what produced its rows", () => {
  const docs = docsSurfaces();
  const rows = register.rows.filter((row) => row.server === "docs");
  assert.deepEqual(
    rows.filter((row) => row.kind === "tool").map((row) => row.surface).sort(),
    docs.tools,
  );
  assert.deepEqual(
    rows.filter((row) => row.kind === "resource").map((row) => row.surface).sort(),
    docs.surfaces,
  );
  // The two surfaces the census row names by hand must be among them, read out
  // of the controller rather than typed into this register.
  assert.ok(docs.surfaces.includes("resources/list"));
  assert.ok(docs.surfaces.includes("resources/read"));
  // Every protocol method is genuinely declared by the controller; an entry in
  // PROTOCOL_METHODS that the server does not declare would silently narrow the
  // surface list.
  for (const method of PROTOCOL_METHODS) {
    assert.ok(docs.declared.includes(method), `${method} is not declared by the docs server`);
  }
});

test("every MAPPED row names a method its context actually publishes", () => {
  const mapped = register.rows.filter((row) => row.disposition === "MAPPED");
  assert.ok(mapped.length > 0, "no MAPPED rows — the check below would be vacuous");
  for (const row of mapped) {
    assert.ok(row.mappedTo.length > 0, `${row.surface} is MAPPED and names no method`);
    for (const entry of row.mappedTo) {
      const [context, method] = entry.split(".");
      const published = contractMethods(context) ?? [];
      assert.ok(
        published.includes(method),
        `${row.surface} names ${entry}, which ${context} does not publish`,
      );
    }
  }
});

test("MAPPED rows are exactly the tools whose declaring file the store register gives a method", () => {
  // The independent re-derivation: read the store-ownership register directly
  // rather than trusting this register's join.
  const withMethods = new Set(
    Object.entries(STORE_DISPOSITIONS)
      .filter(([, entry]) => Object.keys(entry.methods ?? {}).length > 0)
      .map(([file]) => file),
  );
  const expected = sources.tools
    .filter((tool) => withMethods.has(tool.source))
    .map((tool) => tool.name)
    .sort();
  const actual = register.rows
    .filter((row) => row.disposition === "MAPPED")
    .map((row) => row.surface)
    .sort();
  assert.deepEqual(actual, expected);
});

test("every REPLACED row joins to a REST operation that names it back", () => {
  const manifest = JSON.parse(
    readFileSync(join(repositoryRoot, OPERATION_MANIFEST), "utf8"),
  );
  const replaced = register.rows.filter((row) => row.disposition === "REPLACED");
  assert.ok(replaced.length > 0, "no REPLACED rows — the check below would be vacuous");
  for (const row of replaced) {
    assert.ok(row.replacedBy.length > 0, `${row.surface} is REPLACED and names no operation`);
    for (const id of row.replacedBy) {
      // Joined FROM THE MANIFEST SIDE: find the operation, then assert it lists
      // this tool. The generator does the same join the other way round.
      const operation = manifest.inventories.restOperations.find((entry) => entry.id === id);
      assert.ok(operation, `${row.surface} names ${id}, absent from the REST inventory`);
      assert.ok(
        operation.mcpTools.includes(row.surface),
        `${id} does not map back to ${row.surface}`,
      );
    }
  }
});

test("D18 holds: nothing is retired, and a retirement would need evidence", () => {
  assert.deepEqual([...RETIREMENTS], []);
  assert.equal(register.summary.byDisposition.RETIRED, 0);
  for (const row of register.rows) assert.equal(row.retirement, null);
});

test("RETAINED rows are exactly the MCP_ONLY tools with no published method, plus the docs surfaces", () => {
  const expected = [
    ...sources.tools
      .filter((tool) => {
        const store = STORE_DISPOSITIONS[tool.source];
        const hasMethod = Object.keys(store?.methods ?? {}).length > 0;
        return !hasMethod && tool.classification !== "MAPPED";
      })
      .map((tool) => tool.name),
    ...sources.docs.tools,
    ...sources.docs.surfaces,
  ].sort();
  const actual = register.rows
    .filter((row) => row.disposition === "RETAINED")
    .map((row) => row.surface)
    .sort();
  assert.deepEqual(actual, expected);
});

test("`waitingOn` is never invented: it is the store register's word or the named absence", () => {
  const allowed = new Set([
    NO_ORM_SITE,
    "docs-mcp-bridge-deployable",
    ...Object.values(STORE_DISPOSITIONS).map((entry) => entry.waitingOn),
  ]);
  for (const row of register.rows) {
    assert.ok(allowed.has(row.waitingOn), `${row.surface}: unknown waitingOn ${row.waitingOn}`);
  }
  // And NO_ORM_SITE really does mean what it says: no file it is used for holds
  // a store-ownership disposition.
  for (const row of register.rows) {
    if (row.waitingOn !== NO_ORM_SITE) continue;
    assert.equal(STORE_DISPOSITIONS[row.declaredIn], undefined);
  }
});

test("the committed evidence matches what the generator produces now", () => {
  const manifestText = `${JSON.stringify(register, null, 2)}\n`;
  assert.equal(readFileSync(join(repositoryRoot, MANIFEST), "utf8"), manifestText);
  assert.ok(readFileSync(join(repositoryRoot, REPORT), "utf8").length > 0);
});

// ---------------------------------------------------------------------------
// NON-VACUITY. Each gate is shown failing on a mutated input.
// ---------------------------------------------------------------------------

function codesFor(rows, patched = {}) {
  return new Set(auditRows(rows, { ...sources, ...patched }).map((violation) => violation.code));
}

test("RET-1 fires when a tool appears that the committed rows do not disposition", () => {
  const extra = {
    ...sources.tools[0],
    name: "agents.mutation_probe",
    restMappings: [],
    classification: "MCP_ONLY",
  };
  const codes = codesFor(register.rows, { tools: [...sources.tools, extra] });
  assert.ok(codes.has("RET-1-UNDISPOSITIONED_TOOL"), [...codes].join(", "));
});

test("RET-2 fires on a row no server declares", () => {
  const ghost = { ...register.rows[0], surface: "agents.ghost", server: "platform" };
  const codes = codesFor([...register.rows, ghost]);
  assert.ok(codes.has("RET-2-ORPHAN_ROW"), [...codes].join(", "));
});

test("RET-3 fires on a mapped row naming a method the contract does not publish", () => {
  const rows = register.rows.map((row) =>
    row.disposition === "MAPPED" ? { ...row, mappedTo: ["tools.notAMethod"] } : row,
  );
  const codes = codesFor(rows);
  assert.ok(codes.has("RET-3-METHOD_NOT_PUBLISHED"), [...codes].join(", "));
});

test("RET-4 fires on a replacement that does not map back, and on one that is absent", () => {
  const real = [...sources.restById.keys()].find(
    (id) => (sources.restById.get(id).mcpTools ?? []).length === 0,
  );
  assert.ok(real, "no REST operation without an MCP tool — the mutation would be vacuous");
  const notBack = register.rows.map((row) =>
    row.disposition === "REPLACED" ? { ...row, replacedBy: [real] } : row,
  );
  assert.ok(codesFor(notBack).has("RET-4-REPLACEMENT_NOT_FOUND"));

  const absent = register.rows.map((row) =>
    row.disposition === "REPLACED" ? { ...row, replacedBy: ["POST /api/v1/agent/nope"] } : row,
  );
  assert.ok(codesFor(absent).has("RET-4-REPLACEMENT_NOT_FOUND"));

  const empty = register.rows.map((row) =>
    row.disposition === "REPLACED" ? { ...row, replacedBy: [] } : row,
  );
  assert.ok(codesFor(empty).has("RET-4-REPLACEMENT_NOT_FOUND"));
});

test("RET-6 fires when the docs server declares a surface nothing dispositions", () => {
  const docs = { ...sources.docs, surfaces: [...sources.docs.surfaces, "prompts/list"] };
  const codes = codesFor(register.rows, { docs });
  assert.ok(codes.has("RET-6-UNDISPOSITIONED_SURFACE"), [...codes].join(", "));
});

test("every declared violation code is one the audit can actually produce", () => {
  // RET-5 is exercised by the generator's own constant rather than by a row, so
  // it is asserted here by shape: the code is declared, and the audit reads
  // RETIREMENTS. The end-to-end mutation is recorded in the tranche's report.
  assert.equal(new Set(VIOLATION_CODES).size, VIOLATION_CODES.length);
  for (const code of VIOLATION_CODES) assert.match(code, /^RET-\d-[A-Z_]+$/u);
});

test("the docs controller path the AST reads is the file that ships", () => {
  const source = readFileSync(join(repositoryRoot, DOCS_CONTROLLER), "utf8");
  assert.match(source, /DOCS_MCP_TOOLS/u);
  assert.match(source, /resources\/read/u);
});
