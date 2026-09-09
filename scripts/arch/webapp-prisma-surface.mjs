#!/usr/bin/env node
// WIN-267 (M4.1) R2 / WIN-257 T8 — "WEBAPP DATABASE CREDENTIALS CAN BE REMOVED".
//
//   node scripts/arch/webapp-prisma-surface.mjs           # check, exit 1 on failure
//   node scripts/arch/webapp-prisma-surface.mjs --json    # machine-readable
//   node scripts/arch/webapp-prisma-surface.mjs --report  # every call site, with its file
//
// That clause has never been met, and it had no gate. `database.server.ts` is
// byte-identical to `v1`. This file makes the clause a MEASURED, FALSIFIABLE
// property of the tree in both directions: it fails while the cutover is
// incomplete and the tree pretends otherwise, and it fails the moment the
// cutover completes and the enforcement is not switched on to match.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE FOUND, AND WHY IT EXISTS
//
// The R2 brief said the blind gate was `tenancy-prisma-only`, whose `to`
// pattern was `node_modules/(@prisma/|prisma|@platos/tenancy-database)` — no
// `node_modules/` segment appears in the resolved workspace path, so the rule
// could not see the door it names.
//
// THAT CLAIM IS FALSE AT 5b236cdb. T5 (83b61dc5, "make `tenancy-prisma-only`
// able to see the door it names") already fixed it, and the fixed rule fires on
// all ten webapp files. Measured, not read:
//
//     $ node scripts/arch/arch-boundaries.mjs --scan-root apps/webapp
//     10 boundary violation(s).      # 10 tenancy-prisma-only, 0 webapp-no-prisma
//
// The rule that could not see its own target was the OTHER one:
// `webapp-no-prisma`, whose comment calls it "the M2.2 migration lock" and
// which is the only rule in the set written FOR this cutover. Its `to` side
// spelled `node_modules/@prisma/`, and `arch-boundaries.mjs` does not resolve
// modules — `resolveTargetVirtualPath` maps a non-alias bare specifier to
// `node_modules/<specifier>` verbatim, so the webapp's import arrived as
// `node_modules/@platos/tenancy-database` and matched nothing. Zero of ten.
// The general containment rule was carrying the entire lock and the specific
// one was decorative; the failure was invisible because the two rules overlap
// on exactly the edges that exist today.
//
// CREDIT WHERE IT IS DUE, because overclaiming a find is its own defect: T5 SAW
// this and wrote it down. `scripts/mutations-win267-t5.json` says "`webapp-no-
// prisma` … reports 0, because it cannot see the specifier form … Each rule was
// blind to the half of the shape the other could see", and closed the half its
// own clause covered. R2 closes the other half and pins the relation so the two
// rules cannot come apart again.
//
// SHARPNESS below is the invariant that makes that unrepeatable, and it is
// joined to the live enforcer's own output rather than to a constant: a lock
// written for one tree may not be BLUNTER inside that tree than the general
// rule it exists to sharpen. It goes red on the unfixed rule.
//
// ---------------------------------------------------------------------------
// WHY A COUNT AND NOT A PROHIBITION
//
// The prohibition cannot be turned on yet. Every one of these operations needs
// a REST endpoint, and on THIS base `apps/core-api/src/transports` carries a
// chassis, a health controller and a not-found controller and no route that
// reads or writes tenancy state. R1 (`tejas/win-267-r1-identity-rest` @
// c98b5309) has since landed eight, which cover nine of the seventeen; two more
// have a route they cannot reach, because `GET /environments/:environmentId/
// end-users` takes an id and the webapp has three slugs; and six have no route
// at all, among them `authorizeEnvironmentOperator` and the environment lookup
// that together gate every scoped route the dashboard has.
//
// Adding `apps/webapp` to `DEFAULT_SCAN_ROOTS` today would simply make `pnpm
// audit:arch-boundaries` red with no way to make it green, which is a gate
// nobody can keep. Cutting the nine alone would be worse: it would retire the
// calls a reviewer can see and leave `database.server.ts`, `DATABASE_URL` and a
// live client authenticating every request — the clause still false, and the
// gate reading better.
//
// So the property enforced here is the RATCHET, not the endpoint: the surface
// is measured from the tree, pinned, and the pin is tied to the two physical
// facts that constitute the clause — whether `database.server.ts` exists, and
// whether `DATABASE_URL` is still a required boot credential. When the count
// reaches zero and those two facts have not moved, this file fails. When they
// move and the count has not reached zero, it fails. Neither half can be
// declared done in prose.
//
// ---------------------------------------------------------------------------
// WHAT COUNTS AS AN OPERATION
//
// An AST match through the TypeScript parser, not a text grep — the figure the
// issue once carried ("~117") was a text scan. Measured here: 122 textual
// `database.` references under `apps/webapp`, of which 98 are under
// `apps/webapp/test/` (mock factories and their assertions, which migrate by
// DELETION) and 24 under `apps/webapp/app/`. A gate built on that number would
// have been arguing with itself from its first run.
//
// The binding is DISCOVERED, not assumed: each file is asked which local name
// it imports from `~/services/database.server` (or the relative spelling), and
// only member calls rooted at THAT name count. Renaming the import on the way
// in does not hide a call site.
//
//   database.<model>.<op>(…)      a model operation
//   database.$transaction(…)      an interactive transaction
//   tx.<model>.<op>(…)            a model operation inside that transaction,
//                                 where `tx` is the callback's own parameter
//
// The third form is why the honest figure is 15 and not 12: the two creates
// inside `projects.new`'s `$transaction` are real writes against a real client
// and each needs its own endpoint, but they are not spelled `database.`
// anywhere and a scan for that prefix cannot see them.
//
// ---------------------------------------------------------------------------
// AND A FOURTH FORM, WHICH THE 15 DOES NOT COUNT AND WHICH IS COUNTED HERE.
//
// `<callee>(…, database, …)` and `new <Class>(database, …)` — the client HANDED
// TO SOMETHING ELSE rather than called on. `apps/webapp/app/services/
// auth.server.ts` does this twice, and both are load-bearing:
//
//     new PlatosAuthService(database, { encryptionKey: env.ENCRYPTION_KEY })
//     authorizeEnvironmentOperator(database, operator.authorization, …)
//
// Neither is `database.<model>.<op>(` and neither is a `$transaction`, so the
// brief's figure of 15 — which is EXACTLY RIGHT about what it counts — does not
// see them. They matter because they are the escape hatch that would let this
// gate reach zero operations on a tree where the webapp still holds a live
// `PrismaClient` and still authenticates every request through it. A count that
// could be satisfied that way would be measuring a spelling, not a credential.
// `clientHandOffs` is therefore part of `cutoverComplete`.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { check } from "./arch-boundaries.mjs";
import { DEFAULT_SCAN_ROOTS } from "./arch-boundaries.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The webapp's one door to the canonical client. Deleting it IS the clause. */
const DATABASE_MODULE = "apps/webapp/app/services/database.server.ts";

/** The boot-time credential the clause says can be removed. */
const CREDENTIAL_MODULE = "apps/webapp/app/env.server.ts";
const CREDENTIAL_NAME = "DATABASE_URL";

/**
 * The specifiers that name the database module, in every spelling the tree
 * writes. Operation counting uses the exact set (a call site must be rooted at
 * a binding of THIS module); importer counting uses `namesDatabaseModule`,
 * which also accepts the relative spelling `test/` reaches it by.
 */
const DATABASE_SPECIFIERS = new Set(["~/services/database.server", "./database.server"]);

/** Any specifier that resolves to the database module, by trailing segment. */
function namesDatabaseModule(specifier) {
  return DATABASE_SPECIFIERS.has(specifier) || /(?:^|\/)services\/database\.server$/u.test(specifier);
}

/** The workspace package that re-exports the generated client. */
const TENANCY_PACKAGE = "@platos/tenancy-database";

const SOURCE_EXTENSIONS = /\.(?:ts|tsx)$/u;
const SKIP_DIRECTORIES = new Set(["node_modules", "build", "dist", ".cache", "public"]);

// ---------------------------------------------------------------------------
// THE PINS — the state of the tree at 5b236cdb, measured rather than assumed.
//
// ARITHMETIC. 12 `database.<model>.<op>(` call sites + 1 `database.$transaction`
// + 2 model operations on that transaction's own callback parameter = 15
// operations, spread over 11 files: 10 route modules and `auth.server.ts`.
// Reproduced twice, by this parser and by hand against the brief's figure.
//
// These are a DEBT, and unlike `env-access.mjs`'s allow-list they are meant to
// reach zero. `MONOTONE` below is what stops them being edited upward: raising
// a pin is a deliberate two-place edit that a reviewer sees.
// ---------------------------------------------------------------------------
const PINS = Object.freeze({
  /** `database.<model>.<op>(` + `$transaction` + operations on its callback. */
  operations: 15,
  /**
   * The client passed as an ARGUMENT rather than called on — both in
   * `auth.server.ts`, and both the webapp's authentication path.
   */
  clientHandOffs: 2,
  /** Files under `apps/webapp/app` holding at least one of those operations. */
  operationFiles: 11,
  /**
   * Files with an `import` of the database module: the 11 above, plus
   * `test/persistedStateGate.integration.test.ts`, which reaches it by the
   * relative spelling to drive a real database in the persisted-state gate.
   */
  moduleImporters: 12,
  /**
   * Files that name the module in a `vi.mock(...)` factory instead of importing
   * it. These are the 98 references the issue's "~117" was mostly counting, and
   * they migrate by DELETION, not by routing: a double for a module that no
   * longer exists is dead weight, so they are counted apart from the real
   * surface rather than inflating it.
   */
  mockDoubles: 2,
  /** Files under `apps/webapp` importing the canonical client package. */
  clientImporters: 10,
  /** Live `arch-boundaries` verdict over `apps/webapp`, per rule. */
  violations: Object.freeze({ "tenancy-prisma-only": 10, "webapp-no-prisma": 10 }),
});

/**
 * The clause's two physical facts, as they stand at the pin.
 *
 * `credentialRequired` is read off `env.server.ts`: the webapp's zod schema
 * declares `DATABASE_URL: z.string().min(1)` with no default, so the process
 * cannot boot without a database credential in its environment. That is the
 * sentence the clause proposes to make false.
 */
const CLAUSE_AT_PIN = Object.freeze({ databaseModuleExists: true, credentialRequired: true });

function listSourceFiles(absoluteDirectory) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry);
      let stats;
      try {
        stats = statSync(abs);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry)) walk(abs);
      } else if (SOURCE_EXTENSIONS.test(entry)) {
        out.push(abs);
      }
    }
  };
  walk(absoluteDirectory);
  return out.sort();
}

function parse(absoluteFile, source) {
  return ts.createSourceFile(absoluteFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/**
 * The local names this file binds to the database module.
 *
 * Returns a set because a file may bind more than one (`import { database as a,
 * database as b }`), and asking the AST rather than assuming the name
 * `database` is what makes renaming the import on the way in useless as a way
 * around the count.
 */
function databaseBindings(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!DATABASE_SPECIFIERS.has(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    else for (const element of bindings.elements) names.add(element.name.text);
  }
  return names;
}

/** True when `node` is `<root>.<something>`, for the given root identifier name. */
function rootedAt(node, name) {
  return ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;
}

/**
 * Every database operation in one file, with the client each is rooted at.
 *
 * The transaction client is tracked by BINDING, not by name: the callback's
 * first parameter is read off the `$transaction` call's own argument list, so a
 * callback that names it `tx`, `trx` or `transaction` is counted identically
 * and a file cannot drop below the pin by renaming a parameter.
 */
function operationsIn(sourceFile, bindings) {
  const found = [];
  const transactionClients = new Set();

  const line = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const calleeLabel = (callee) =>
    ts.isPropertyAccessExpression(callee) ? `${callee.name.text}()` : "(expression)()";

  const visit = (node) => {
    // `new PlatosAuthService(database, …)` is a NewExpression, not a call, and a
    // walk that only looked at calls would miss the one that CONSTRUCTS the
    // webapp's authentication service out of the client.
    if (ts.isNewExpression(node)) {
      for (const argument of node.arguments ?? []) {
        if (ts.isIdentifier(argument) && bindings.has(argument.text)) {
          found.push({
            kind: "client-hand-off",
            client: argument.text,
            member: `new ${ts.isIdentifier(node.expression) ? node.expression.text : "(expression)"}()`,
            line: line(node),
          });
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;

      // database.$transaction(cb) — and the client its callback receives.
      for (const name of bindings) {
        if (rootedAt(callee, name) && callee.name.text === "$transaction") {
          found.push({ kind: "transaction", client: name, member: "$transaction", line: line(node) });
          const [first] = node.arguments;
          if (first && (ts.isArrowFunction(first) || ts.isFunctionExpression(first))) {
            const [parameter] = first.parameters;
            if (parameter && ts.isIdentifier(parameter.name)) transactionClients.add(parameter.name.text);
          }
        }
      }

      // <callee>(…, database, …) — the client handed to something else. Judged
      // on the ARGUMENTS, so it never collides with the two forms above: those
      // are decided by the callee.
      for (const argument of node.arguments) {
        if (ts.isIdentifier(argument) && bindings.has(argument.text)) {
          found.push({
            kind: "client-hand-off",
            client: argument.text,
            member: ts.isIdentifier(callee) ? `${callee.text}()` : calleeLabel(callee),
            line: line(node),
          });
        }
      }

      // <client>.<model>.<op>(…) — two levels, so `$transaction` above (one
      // level) is never double-counted here.
      if (ts.isPropertyAccessExpression(callee) && ts.isPropertyAccessExpression(callee.expression)) {
        const root = callee.expression.expression;
        if (ts.isIdentifier(root) && (bindings.has(root.text) || transactionClients.has(root.text))) {
          found.push({
            kind: "model-operation",
            client: root.text,
            member: `${callee.expression.name.text}.${callee.name.text}`,
            line: line(node),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

/**
 * Files under `absoluteDirectory` naming the database module in a `vi.mock`
 * factory rather than importing it — a test double, which the cutover removes
 * by deleting rather than by routing.
 */
function mockDoublesOf(absoluteDirectory) {
  const out = [];
  for (const absolute of listSourceFiles(absoluteDirectory)) {
    let source;
    try {
      source = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    const sourceFile = parse(absolute, source);
    let hit = false;
    const visit = (node) => {
      if (
        !hit &&
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "vi" &&
        node.expression.name.text === "mock"
      ) {
        const [first] = node.arguments;
        if (first && ts.isStringLiteral(first) && namesDatabaseModule(first.text)) hit = true;
      }
      if (!hit) ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (hit) out.push(relative(repositoryRoot, absolute).split("\\").join("/"));
  }
  return out.sort();
}

/** Files under `absoluteDirectory` importing `specifier`, repository-relative. */
function importersOf(absoluteDirectory, matches) {
  const out = [];
  for (const absolute of listSourceFiles(absoluteDirectory)) {
    let source;
    try {
      source = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    const sourceFile = parse(absolute, source);
    const hit = sourceFile.statements.some(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        matches(statement.moduleSpecifier.text),
    );
    if (hit) out.push(relative(repositoryRoot, absolute).split("\\").join("/"));
  }
  return out.sort();
}

export function measure(root = repositoryRoot) {
  const appDirectory = join(root, "apps/webapp/app");
  const webappDirectory = join(root, "apps/webapp");

  const sites = [];
  for (const absolute of listSourceFiles(appDirectory)) {
    let source;
    try {
      source = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    const sourceFile = parse(absolute, source);
    const bindings = databaseBindings(sourceFile);
    if (bindings.size === 0) continue;
    const file = relative(root, absolute).split("\\").join("/");
    for (const operation of operationsIn(sourceFile, bindings)) sites.push({ file, ...operation });
  }
  const handOffs = sites.filter((s) => s.kind === "client-hand-off");
  const operations = sites.filter((s) => s.kind !== "client-hand-off");

  const moduleImporters = importersOf(webappDirectory, namesDatabaseModule);
  const mockDoubles = mockDoublesOf(webappDirectory);
  const clientImporters = importersOf(webappDirectory, (s) => s === TENANCY_PACKAGE || s.startsWith(`${TENANCY_PACKAGE}/`));

  // The LIVE enforcer over the real tree — not a fixture and not a restatement
  // of the rule. `webapp-no-prisma` is scoped `^apps/webapp/`, so this is the
  // whole population that rule can ever judge.
  const verdict = check(root, { scanRoots: ["apps/webapp"] });
  const violations = {};
  for (const violation of verdict.violations) {
    violations[violation.rule] = (violations[violation.rule] ?? 0) + 1;
  }

  const databaseModuleExists = existsSync(join(root, DATABASE_MODULE));
  let credentialRequired = false;
  const credentialPath = join(root, CREDENTIAL_MODULE);
  if (existsSync(credentialPath)) {
    credentialRequired = readFileSync(credentialPath, "utf8").includes(CREDENTIAL_NAME);
  }

  return {
    root,
    sites,
    operations: operations.length,
    clientHandOffs: handOffs,
    operationFiles: [...new Set(operations.map((s) => s.file))].sort(),
    moduleImporters,
    mockDoubles,
    clientImporters,
    violations,
    scannedFiles: verdict.fileCount,
    webappInDefaultScanRoots: DEFAULT_SCAN_ROOTS.includes("apps/webapp"),
    databaseModuleExists,
    credentialRequired,
  };
}

export function evaluate(measured) {
  const failures = [];
  const fail = (id, message) => failures.push({ id, message });

  const tenancy = measured.violations["tenancy-prisma-only"] ?? 0;
  const webapp = measured.violations["webapp-no-prisma"] ?? 0;

  // SHARPNESS. The load-bearing case, and the one this tranche exists for.
  // Joined to the enforcer's own output on both sides, so it cannot be
  // satisfied by agreeing with a constant. A lock written for `apps/webapp`
  // that fires on fewer edges inside `apps/webapp` than the general containment
  // rule is not enforcing the migration; it is being carried by the rule it was
  // supposed to sharpen, and it will go silent the moment that rule's home
  // changes.
  if (webapp < tenancy) {
    fail(
      "sharpness",
      `webapp-no-prisma fires on ${webapp} edge(s) inside apps/webapp where tenancy-prisma-only fires on ${tenancy}; ` +
        "the M2.2 migration lock is blunter inside its own tree than the general containment rule",
    );
  }

  // MONOTONE. The pins are a debt. A pin may be lowered as the cutover lands;
  // raising one silently would let the surface grow back under a green gate.
  if (measured.clientHandOffs.length > PINS.clientHandOffs) {
    fail(
      "monotone-hand-offs",
      `${measured.clientHandOffs.length} file-level hand-off(s) of the client, above the pin of ${PINS.clientHandOffs}`,
    );
  }
  if (measured.operations > PINS.operations) {
    fail("monotone-operations", `${measured.operations} database operation(s) in apps/webapp/app, above the pin of ${PINS.operations}`);
  }
  if (measured.clientImporters.length > PINS.clientImporters) {
    fail(
      "monotone-client-importers",
      `${measured.clientImporters.length} file(s) import ${TENANCY_PACKAGE}, above the pin of ${PINS.clientImporters}`,
    );
  }

  // DRIFT. Equality in the other direction: work that lands must move the pin,
  // so a reviewer reads the new figure rather than inferring it.
  for (const [key, pinned] of [
    ["operations", PINS.operations],
    ["operationFiles", PINS.operationFiles],
    ["clientHandOffs", PINS.clientHandOffs],
    ["moduleImporters", PINS.moduleImporters],
    ["mockDoubles", PINS.mockDoubles],
    ["clientImporters", PINS.clientImporters],
  ]) {
    const live = Array.isArray(measured[key]) ? measured[key].length : measured[key];
    if (live !== pinned) fail(`pin-${key}`, `${key}: measured ${live}, pinned ${pinned}`);
  }
  for (const [rule, pinned] of Object.entries(PINS.violations)) {
    const live = measured.violations[rule] ?? 0;
    if (live !== pinned) fail(`pin-violations-${rule}`, `${rule}: measured ${live} violation(s) in apps/webapp, pinned ${pinned}`);
  }

  // THE CLAUSE, BOTH DIRECTIONS. Deleting the file is not the same as proving
  // nothing needs it, and neither is leaving it in place while claiming the
  // work is done. These four cases make each half of the clause fail on the
  // other half's evidence.
  const cutoverComplete =
    measured.operations === 0 &&
    measured.clientHandOffs.length === 0 &&
    measured.clientImporters.length === 0 &&
    measured.moduleImporters.length === 0;

  if (cutoverComplete && measured.databaseModuleExists) {
    fail("clause-module", `no operation remains, but ${DATABASE_MODULE} is still in the tree; deleting it IS the clause`);
  }
  if (!cutoverComplete && !measured.databaseModuleExists) {
    fail(
      "clause-module-premature",
      `${DATABASE_MODULE} has been deleted while ${measured.operations} operation(s) and ` +
        `${measured.clientImporters.length} client import(s) remain`,
    );
  }
  if (cutoverComplete && measured.credentialRequired) {
    fail(
      "clause-credential",
      `no operation remains, but ${CREDENTIAL_MODULE} still names ${CREDENTIAL_NAME}; ` +
        "the credential the clause removes is still a boot requirement",
    );
  }
  if (cutoverComplete && !measured.webappInDefaultScanRoots) {
    fail(
      "clause-scan-root",
      "the cutover is complete but apps/webapp is still outside DEFAULT_SCAN_ROOTS, so pnpm audit:arch-boundaries " +
        "would not notice it coming back",
    );
  }
  if (!cutoverComplete && measured.webappInDefaultScanRoots) {
    fail(
      "clause-scan-root-premature",
      `apps/webapp is in DEFAULT_SCAN_ROOTS while ${measured.operations} operation(s) remain; ` +
        "pnpm audit:arch-boundaries cannot be green",
    );
  }

  // VACUITY. A scan that found nothing would satisfy every case above.
  if (measured.scannedFiles === 0) {
    fail("vacuous", "the apps/webapp scan reached zero source files; the selectors have drifted");
  }

  return failures;
}

export { PINS, CLAUSE_AT_PIN, DATABASE_MODULE, CREDENTIAL_MODULE, CREDENTIAL_NAME, TENANCY_PACKAGE };

function main() {
  const argv = process.argv.slice(2);
  const measured = measure();
  const failures = evaluate(measured);

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ...measured, root: undefined, failures }, null, 2)}\n`);
  } else {
    const tenancy = measured.violations["tenancy-prisma-only"] ?? 0;
    const webapp = measured.violations["webapp-no-prisma"] ?? 0;
    process.stdout.write(
      `webapp-prisma-surface: ${measured.operations} operation(s) + ` +
        `${measured.clientHandOffs.length} client hand-off(s) across ${measured.operationFiles.length} file(s); ` +
        `${measured.moduleImporters.length} import ${DATABASE_MODULE.split("/").pop()} ` +
        `(+${measured.mockDoubles.length} mock it), ` +
        `${measured.clientImporters.length} import ${TENANCY_PACKAGE}\n` +
        `  arch-boundaries over apps/webapp (${measured.scannedFiles} file(s)): ` +
        `tenancy-prisma-only ${tenancy}, webapp-no-prisma ${webapp}\n` +
        `  clause: ${DATABASE_MODULE.split("/").pop()} ${measured.databaseModuleExists ? "present" : "deleted"}, ` +
        `${CREDENTIAL_NAME} ${measured.credentialRequired ? "required at boot" : "not referenced"}, ` +
        `apps/webapp ${measured.webappInDefaultScanRoots ? "in" : "outside"} DEFAULT_SCAN_ROOTS\n`,
    );
    if (argv.includes("--report")) {
      for (const site of measured.sites) {
        process.stdout.write(`    ${site.file}:${site.line}  ${site.client}.${site.member}  (${site.kind})\n`);
      }
    }
    if (failures.length === 0) {
      process.stdout.write("ok: the webapp's database surface matches its pin and the clause's two halves agree.\n");
    } else {
      for (const failure of failures) process.stdout.write(`FAIL [${failure.id}] ${failure.message}\n`);
      process.stdout.write(`\n${failures.length} failure(s).\n`);
    }
  }

  process.exitCode = failures.length > 0 ? 1 : 0;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
