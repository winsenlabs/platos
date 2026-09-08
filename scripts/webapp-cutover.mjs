#!/usr/bin/env node
// WIN-267 (M4.1) T5 — THE WEBAPP'S CANONICAL-STORE REACH, MEASURED.
//
// The M2 acceptance clause this serves is "webapp database credentials can be
// removed", and the whole of that clause is one number reaching zero: how many
// operations in `apps/webapp` still go to PostgreSQL directly instead of through
// a core-api contract. This gate measures that number from the tree, attributes
// every one of them to the bounded context that owns the row, and refuses any
// drift from the committed artifact.
//
// ---------------------------------------------------------------------------
// WHY IT HAD TO EXIST BEFORE THE CUTOVER, AND NOT AFTER IT.
//
// NOTHING IN THIS REPOSITORY COUNTS THESE CALL SITES TODAY. `arch-boundaries.mjs`
// is the enforcer that would, and its `DEFAULT_SCAN_ROOTS` deliberately excludes
// `apps/webapp` during the strangler window; `.dependency-cruiser.js` is a
// GENERATED artifact and dependency-cruiser is not a dependency of this
// workspace, so nothing executes it. The denominator of the acceptance clause
// could therefore GROW between two green CI runs and no gate would say so — and
// a cutover whose denominator moves while you are cutting over is a cutover that
// does not finish.
//
// That is the same class of hole as C8 in `scripts/arch/composition-root.mjs`,
// pointing at the other application: a reach that every gate permits because
// every gate is looking somewhere else.
//
// ---------------------------------------------------------------------------
// WHAT IS DERIVED AND WHAT IS DECIDED. Everything on the right-hand side of a
// row is DERIVED, because "an assertion comparing two things you control cannot
// fail":
//
//   the CALL SITES   from the TypeScript compiler's parse of apps/webapp/app —
//                    never a regex, for the reason composition-root.mjs already
//                    paid for once.
//   the DELEGATE     from the property chain, as written.
//   the MODEL        from `modelForDelegate` in scripts/arch/table-ownership.mjs.
//   the OWNER        from `OWNER` in that same module — ADR M0.3 §5.2's
//                    canonical-row ownership map, which four other gates read.
//   the METHOD KIND  from that module's READ/MUTATING/RAW method vocabularies.
//
// The only DECIDED thing is which local identifiers are a Prisma client, and
// even that is derived per-file: the binding imported from the client module
// (matched by RESOLVED PATH, not by spelling), plus the parameter of any `$transaction`
// callback taken off one. So deleting `database.server.ts` — the acceptance
// clause's own instruction — makes this gate report zero by construction, and
// deleting it while leaving a call site behind makes the file fail to resolve
// its client and is reported as an ORPHAN rather than silently dropped.
//
//   node scripts/webapp-cutover.mjs            # regenerate the artifact
//   node scripts/webapp-cutover.mjs --check    # gate, exit 1 on drift
//   node scripts/webapp-cutover.mjs --json

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import {
  MUTATING_DELEGATE_METHODS,
  OWNER,
  RAW_SQL_METHODS,
  READ_DELEGATE_METHODS,
  modelForDelegate,
} from "./arch/table-ownership.mjs";

// The ownership module publishes these as ARRAYS. Membership is asked a lot here,
// so each becomes a Set once rather than a linear scan per call site.
const READS = new Set(READ_DELEGATE_METHODS);
const WRITES = new Set(MUTATING_DELEGATE_METHODS);
const RAW = new Set(RAW_SQL_METHODS);

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/** The tree under measurement. */
export const WEBAPP_ROOT = "apps/webapp/app";

/**
 * The module whose default export IS the canonical client, and the acceptance
 * clause's own target.
 *
 * "delete `app/services/database.server.ts`, which is the acceptance clause
 * 'webapp database credentials can be removed'". Naming it here is what lets the
 * gate report ORPHANS: a call site whose client can no longer be resolved is a
 * cutover that removed the credential and left the query.
 */
export const CLIENT_MODULE_FILE = "apps/webapp/app/services/database.server.ts";

/**
 * A specifier is matched by RESOLVING IT TO A FILE, never by its spelling.
 *
 * THIS GATE'S FIRST DRAFT MATCHED THE STRING `~/services/database.server` AND
 * MISSED AN OPERATION, and it is worth recording which one: the ten route files
 * import the client through the `~/` alias, and `app/services/auth.server.ts`
 * — the one file that is not a route — imports it as `./database.server`. So the
 * first draft measured 14 operations in 10 files where the tree has 15 in 11,
 * and the miss was in the file that resolves the operator's session.
 *
 * That is the SAME failure this tranche's first commit repaired in
 * `tenancy-prisma-only`: a pattern written against one spelling of an import,
 * blind to the other. A gate whose subject is "the rule could not see the
 * import" has no business being written the same way, so this one resolves
 * `./x`, `../x` and `~/x` to a repo-relative path and compares FILES.
 */
const WEBAPP_ALIAS_ROOT = "apps/webapp/app";

function resolveSpecifier(fromFile, specifier) {
  let candidate;
  if (specifier.startsWith("~/")) {
    candidate = `${WEBAPP_ALIAS_ROOT}/${specifier.slice(2)}`;
  } else if (specifier.startsWith(".")) {
    const parts = `${fromFile.slice(0, fromFile.lastIndexOf("/"))}/${specifier}`.split("/");
    const stack = [];
    for (const part of parts) {
      if (part === "." || part === "") continue;
      if (part === "..") stack.pop();
      else stack.push(part);
    }
    candidate = stack.join("/");
  } else {
    return null;
  }
  // Extensions are omitted in source; compare against every shape the tree uses.
  for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    if (`${candidate}${suffix}` === CLIENT_MODULE_FILE) return CLIENT_MODULE_FILE;
  }
  return null;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx"];
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", ".turbo", "coverage"]);

const OUT = "docs/audits/M4.1-webapp-cutover.json";

function listSourceFiles(root, dir) {
  const found = [];
  const walk = (absolute) => {
    if (!existsSync(absolute)) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(join(absolute, entry.name));
      } else if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        found.push(relative(root, join(absolute, entry.name)).split("\\").join("/"));
      }
    }
  };
  walk(join(root, dir));
  return found.sort();
}

function parse(path, source) {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, kind);
}

/**
 * The local names bound to the canonical client in this file.
 *
 * Two sources, and the second is the one a hand count misses. The first is the
 * import of the client module — resolved to a FILE, see resolveSpecifier — under
 * whatever local name the file chose. The
 * second is the PARAMETER of a `$transaction` callback invoked on one of those:
 * inside `database.$transaction(async (tx) => …)`, `tx` is the same client, and
 * the two creates the webapp performs inside that callback are canonical writes
 * that name `database` nowhere.
 */
function clientBindings(path, file) {
  const names = new Set();
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      resolveSpecifier(path, node.moduleSpecifier.text) !== null
    ) {
      const clause = node.importClause;
      if (clause?.name !== undefined) names.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) names.add(element.name.text);
      }
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  // Second pass: `<client>.$transaction(callback)` binds the callback's first
  // parameter to the same client. Run to a fixpoint so a nested transaction —
  // which Prisma permits — is followed too.
  let grew = true;
  while (grew) {
    grew = false;
    const collect = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "$transaction" &&
        ts.isIdentifier(node.expression.expression) &&
        names.has(node.expression.expression.text)
      ) {
        const callback = node.arguments[0];
        if (
          callback !== undefined &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        ) {
          const parameter = callback.parameters[0];
          if (parameter !== undefined && ts.isIdentifier(parameter.name) && !names.has(parameter.name.text)) {
            names.add(parameter.name.text);
            grew = true;
          }
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(file);
  }
  return names;
}

const lineOf = (file, node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

/**
 * Every canonical-store operation this file performs, as the tree has them.
 *
 * THREE SHAPES, and each is an operation the acceptance clause has to account
 * for: `client.<delegate>.<method>(…)`, `client.$transaction(…)` — a unit of
 * work, counted once in its own right because it is what makes the writes inside
 * it atomic — and `client.$queryRaw`-family calls, which no delegate name covers.
 */
function operationsIn(path, file, clients) {
  const rows = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      const method = callee.name.text;
      const receiver = callee.expression;

      // client.$transaction(...) / client.$queryRaw(...)
      if (ts.isIdentifier(receiver) && clients.has(receiver.text)) {
        if (method === "$transaction") {
          rows.push({ file: path, line: lineOf(file, node), client: receiver.text, delegate: null, method, model: null, owner: null, kind: "unit-of-work" });
        } else if (RAW.has(method)) {
          rows.push({ file: path, line: lineOf(file, node), client: receiver.text, delegate: null, method, model: null, owner: null, kind: "raw-sql" });
        }
      }

      // client.<delegate>.<method>(...)
      if (
        ts.isPropertyAccessExpression(receiver) &&
        ts.isIdentifier(receiver.expression) &&
        clients.has(receiver.expression.text)
      ) {
        const delegate = receiver.name.text;
        const model = modelForDelegate(delegate);
        const kind = READS.has(method)
          ? "read"
          : WRITES.has(method)
            ? "write"
            : "unclassified";
        rows.push({
          file: path,
          line: lineOf(file, node),
          client: receiver.expression.text,
          delegate,
          method,
          model,
          owner: model === null ? null : (OWNER[model] ?? null),
          kind,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return rows;
}

/** A file that imports the client module but resolves no binding from it. */
function importsClientModule(path, file) {
  let found = false;
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      resolveSpecifier(path, node.moduleSpecifier.text) !== null
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

export function measureCutover(root = repositoryRoot) {
  const files = listSourceFiles(root, WEBAPP_ROOT);
  const operations = [];
  const problems = [];

  for (const path of files) {
    const source = readFileSync(join(root, path), "utf8");
    const file = parse(path, source);
    const clients = clientBindings(path, file);
    if (clients.size === 0) {
      // A file that imports the module and binds nothing from it is either dead
      // or a shape this gate cannot read. Either way it is REPORTED, never
      // shrugged at — a silent zero is how a denominator goes missing.
      if (importsClientModule(path, file)) {
        problems.push(`${path} imports ${CLIENT_MODULE_FILE} but binds no client this gate can follow`);
      }
      continue;
    }
    operations.push(...operationsIn(path, file, clients));
  }

  for (const row of operations) {
    if (row.kind === "unclassified") {
      problems.push(
        `${row.file}:${row.line} calls \`${row.delegate}.${row.method}\`, which is neither a read nor a` +
          ` mutation in scripts/arch/table-ownership.mjs; classify it there rather than here`,
      );
    }
    if (row.delegate !== null && row.model === null) {
      problems.push(
        `${row.file}:${row.line} names delegate \`${row.delegate}\`, which maps to no model in the` +
          ` canonical schema; the ownership map and the webapp disagree about what exists`,
      );
    }
    if (row.model !== null && row.owner === null) {
      problems.push(`${row.file}:${row.line} touches ${row.model}, which ADR M0.3 §5.2 assigns no owner`);
    }
  }

  // The acceptance clause's own target. Present is the state under measurement;
  // absent with operations still standing is a cutover that removed the
  // credential and left the queries.
  const clientPresent = existsSync(join(root, CLIENT_MODULE_FILE));
  if (!clientPresent && operations.length > 0) {
    problems.push(
      `${CLIENT_MODULE_FILE} is deleted but ${operations.length} canonical-store operation(s) remain in ${WEBAPP_ROOT}`,
    );
  }

  const byOwner = {};
  for (const row of operations) {
    // A `$transaction` owns no ROW — it is the unit of work that makes the writes
    // inside it atomic — so it is grouped by what it IS rather than filed under a
    // label that reads like a defect in the ownership map.
    const owner = row.owner ?? `<${row.kind}>`;
    byOwner[owner] = (byOwner[owner] ?? 0) + 1;
  }
  const touchedFiles = [...new Set(operations.map((row) => row.file))].sort();

  return {
    root,
    scannedFiles: files.length,
    clientPresent,
    operationCount: operations.length,
    fileCount: touchedFiles.length,
    files: touchedFiles,
    byOwner: Object.fromEntries(Object.entries(byOwner).sort(([a], [b]) => a.localeCompare(b))),
    operations: operations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    problems,
  };
}

function artifactOf(result) {
  return {
    $note:
      "GENERATED by scripts/webapp-cutover.mjs. The M2 acceptance clause 'webapp database" +
      " credentials can be removed' is this file reporting operationCount 0 and clientPresent" +
      " false. Every field is derived from the tree and from ADR M0.3 §5.2's ownership map.",
    issue: "WIN-267",
    clause: "M2 — webapp database credentials can be removed",
    scannedFiles: result.scannedFiles,
    clientPresent: result.clientPresent,
    operationCount: result.operationCount,
    fileCount: result.fileCount,
    byOwner: result.byOwner,
    files: result.files,
    operations: result.operations.map(({ file, line, delegate, method, model, owner, kind }) => ({
      file,
      line,
      delegate,
      method,
      model,
      owner,
      kind,
    })),
  };
}

function main() {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1] ?? ".") : repositoryRoot;
  const result = measureCutover(root);
  const artifact = artifactOf(result);
  const outPath = join(root, OUT);

  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.problems.length > 0) process.exitCode = 1;
    return;
  }

  if (!process.argv.includes("--check")) {
    writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    process.stdout.write(`webapp-cutover: wrote ${OUT}\n`);
  }

  process.stdout.write(
    `webapp-cutover: ${result.operationCount} canonical-store operation(s) in ${result.fileCount} file(s)` +
      ` across ${result.scannedFiles} scanned; ${CLIENT_MODULE_FILE} ${result.clientPresent ? "present" : "DELETED"}\n`,
  );
  for (const [owner, count] of Object.entries(result.byOwner)) {
    process.stdout.write(`  ${owner.padEnd(18)} ${String(count).padStart(3)}\n`);
  }
  for (const problem of result.problems) process.stdout.write(`FAIL ${problem}\n`);

  if (process.argv.includes("--check")) {
    if (!existsSync(outPath)) {
      process.stdout.write(`FAIL ${OUT} is missing; run node scripts/webapp-cutover.mjs\n`);
      process.exitCode = 1;
      return;
    }
    const committed = readFileSync(outPath, "utf8");
    const current = `${JSON.stringify(artifact, null, 2)}\n`;
    if (committed !== current) {
      process.stdout.write(
        `FAIL ${OUT} disagrees with the tree; run node scripts/webapp-cutover.mjs and commit the result\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  if (result.problems.length > 0) {
    process.exitCode = 1;
    return;
  }
  if (result.operationCount === 0 && !result.clientPresent) {
    process.stdout.write("ok: the cutover is COMPLETE — no canonical-store reach and no client module\n");
  } else {
    process.stdout.write("ok: the reach is exactly what the committed artifact records\n");
  }
}

if (process.argv[1] && process.argv[1].endsWith("webapp-cutover.mjs")) main();
