// Non-vacuity proof for the webapp cutover meter.
//
// The gate's whole value is a NUMBER that has to reach zero, so every case below
// attacks the number: it must be reproducible from the tree, it must move when
// the tree moves, and it must not be quietly satisfiable by a parser that has
// stopped looking.
//
// THE FIGURE IS CORROBORATED AGAINST A SECOND MECHANISM. `measureCutover` walks
// the TypeScript parse; the corroboration case counts the same operations with a
// byte scan, from the file list up. Two mechanisms that must agree is the same
// shape `arch-boundaries.test.mjs`'s ACCEPTANCE case uses, and for the same
// reason — a parser that goes blind is caught by the disagreement rather than by
// a pin somebody has to remember to move.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { CLIENT_MODULE_FILE, WEBAPP_ROOT, measureCutover } from "./webapp-cutover.mjs";
import { OWNER, modelForDelegate } from "./arch/table-ownership.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const temporary = [];
after(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

/** A copy of the real webapp tree, so mutations run against real code. */
function realTreeCopy() {
  const root = mkdtempSync("/var/tmp/platos-webapp-cutover-");
  temporary.push(root);
  cpSync(join(repositoryRoot, WEBAPP_ROOT), join(root, WEBAPP_ROOT), {
    recursive: true,
    filter: (source) => !/[/\\](node_modules|dist|\.turbo)([/\\]|$)/u.test(source),
  });
  return root;
}

function write(root, path, contents) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf8");
}

test("BASELINE: the live tree reports 15 operations in 11 files, and every row resolves", () => {
  const result = measureCutover(repositoryRoot);
  assert.deepEqual(result.problems, [], result.problems.join("\n"));
  assert.equal(result.operationCount, 15);
  assert.equal(result.fileCount, 11);
  assert.equal(result.clientPresent, true);
  // Every delegate row carries a model AND an owner — an unresolvable row is the
  // one way this meter could count something it does not understand.
  for (const row of result.operations) {
    if (row.delegate === null) continue;
    assert.ok(row.model, `${row.file}:${row.line} ${row.delegate} resolved no model`);
    assert.ok(row.owner, `${row.file}:${row.line} ${row.model} resolved no owner`);
    assert.notEqual(row.kind, "unclassified", `${row.file}:${row.line} ${row.delegate}.${row.method}`);
  }
});

test("CORROBORATION: a byte scan finds the same operations the parse does", () => {
  // Deliberately a different mechanism: no compiler, just the delegate names the
  // ownership map knows, matched against the source of each file the parse
  // implicated. The two have to agree about the SET, not merely the count.
  const result = measureCutover(repositoryRoot);
  for (const row of result.operations) {
    if (row.delegate === null) continue;
    const source = readFileSync(join(repositoryRoot, row.file), "utf8");
    assert.ok(
      source.includes(`${row.delegate}.${row.method}(`),
      `${row.file} does not textually contain ${row.delegate}.${row.method}(`,
    );
    assert.equal(
      OWNER[modelForDelegate(row.delegate)],
      row.owner,
      `${row.delegate} owner disagrees with ADR M0.3 §5.2`,
    );
  }
});

test("the attribution is the ADR's, not this gate's: 10 tenancy, 2 identity-access, 2 secrets", () => {
  // The split is what says which tranche unblocks what, so it is asserted rather
  // than merely printed. `identity-access` and `secrets` are the four operations
  // the composition root cannot serve today.
  const result = measureCutover(repositoryRoot);
  assert.deepEqual(result.byOwner, {
    "<unit-of-work>": 1,
    "identity-access": 2,
    secrets: 2,
    tenancy: 10,
  });
});

test("MUTATION: a NEW canonical-store call in the webapp moves the count", () => {
  // The regression this gate exists for. Nothing else in the repository counts
  // these call sites: `arch-boundaries.mjs` excludes apps/webapp by default and
  // dependency-cruiser is not a dependency of this workspace.
  const root = realTreeCopy();
  write(
    root,
    "apps/webapp/app/routes/_sneak/route.tsx",
    'import { database } from "~/services/database.server";\n' +
      "export async function loader() { return database.organization.findMany({}); }\n",
  );
  const result = measureCutover(root);
  assert.equal(result.operationCount, 16, "a new call site must be counted");
  assert.equal(result.fileCount, 12);
  assert.equal(result.byOwner.tenancy, 11);
});

test("MUTATION: the RELATIVE import shape is followed, not just the `~/` alias", () => {
  // The miss this gate's own first draft made. `app/services/auth.server.ts`
  // imports the client as `./database.server`, and a first draft that matched the
  // alias string reported 14 in 10 where the tree has 15 in 11 — losing the file
  // that resolves the operator's session.
  const root = realTreeCopy();
  write(
    root,
    "apps/webapp/app/services/sneak.server.ts",
    'import { database } from "./database.server";\n' +
      "export const rows = () => database.project.findMany({});\n",
  );
  const alias = measureCutover(root).operationCount;
  assert.equal(alias, 16, "a relative import of the client must be followed");
});

test("MUTATION: a write inside a $transaction callback is attributed, not lost", () => {
  // The two creates in `projects.new` name `database` nowhere — they are called
  // on the callback's parameter. A meter that followed only the imported binding
  // would report 13 and call the cutover 87% done.
  const root = realTreeCopy();
  write(
    root,
    "apps/webapp/app/routes/_txn/route.tsx",
    'import { database } from "~/services/database.server";\n' +
      "export const act = () => database.$transaction(async (tx) => {\n" +
      "  await tx.organization.create({ data: {} });\n" +
      "  await tx.project.create({ data: {} });\n" +
      "});\n",
  );
  const result = measureCutover(root);
  // 15 + the $transaction itself + the two creates inside it.
  assert.equal(result.operationCount, 18);
  assert.equal(result.byOwner.tenancy, 12);
  assert.equal(result.byOwner["<unit-of-work>"], 2);
});

test("ACCEPTANCE: deleting the client module with a call site left behind is a FAILURE", () => {
  // The acceptance clause is "webapp database credentials can be removed", and
  // the failure mode it invites is removing the credential and leaving the
  // query. That is not a green run: it is an orphan, reported by name.
  const root = realTreeCopy();
  rmSync(join(root, CLIENT_MODULE_FILE));
  const result = measureCutover(root);
  assert.equal(result.clientPresent, false);
  // The operations are STILL COUNTED, and that is the point. Specifier
  // resolution is a path computation rather than a filesystem probe, so removing
  // the module does not make its importers invisible — it makes them a
  // contradiction, which the gate names with both halves in one sentence. A
  // meter that had lost sight of the queries the moment the credential went
  // would report a completed cutover over fifteen broken call sites.
  assert.equal(result.operationCount, 15);
  assert.ok(
    result.problems.some(
      (problem) => problem.includes("is deleted but") && problem.includes("canonical-store operation"),
    ),
    `expected the deleted-client contradiction, got: ${result.problems.join("\n")}`,
  );
});

test("ACCEPTANCE: a completed cutover reports zero and no client module", () => {
  // What DONE looks like, asserted so the gate cannot only ever say "not yet".
  // Every importer goes with the module, which is what the cutover does.
  const root = realTreeCopy();
  const result = measureCutover(root);
  for (const path of result.files) rmSync(join(root, path));
  rmSync(join(root, CLIENT_MODULE_FILE), { force: true });
  const done = measureCutover(root);
  assert.equal(done.operationCount, 0);
  assert.equal(done.clientPresent, false);
  assert.deepEqual(done.problems, []);
});

test("an unclassified delegate method is REPORTED rather than silently counted as a read", () => {
  // `table-ownership.mjs` owns the read/write vocabulary. A method it does not
  // know is a method whose blast radius this gate cannot state, and guessing
  // "read" would understate exactly the operations that matter most.
  const root = realTreeCopy();
  write(
    root,
    "apps/webapp/app/routes/_odd/route.tsx",
    'import { database } from "~/services/database.server";\n' +
      "export const go = () => database.organization.subscribe({});\n",
  );
  const result = measureCutover(root);
  assert.ok(
    result.problems.some((problem) => problem.includes("neither a read nor a mutation")),
    result.problems.join("\n"),
  );
});
