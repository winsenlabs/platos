#!/usr/bin/env node
// WIN-260 (M2.5) — FEATURE CODE DOES NOT READ THE AMBIENT ENVIRONMENT.
//
// That sentence is the first line of WIN-260's acceptance. This file is what
// makes it a countable, gateable property rather than a habit.
//
//   node scripts/arch/env-access.mjs          # check, exit 1 on violation
//   node scripts/arch/env-access.mjs --json   # machine-readable
//   node scripts/arch/env-access.mjs --report # every read found, with its file
//
// THE SHAPE IS `tenancy-prisma-only`. ADR M0.3 §15 had to invent that rule in
// M2.3 because nothing pinned the ORM ANYWHERE: `@prisma` was banned from a
// context's domain and application, and a transport, a second adapter or the
// composition root could all have held the client with every gate green. The
// environment was in exactly that position until this file. Nothing said where a
// `process.env` read may live, so the property "feature code does not read it"
// was true, unpinned, and one line away from being false in a package nobody
// would think to check.
//
// IT WAS TRUE WHEN THIS WAS WRITTEN, AND THAT IS THE POINT. The count at the
// head of `ALLOWED` is not a debt to pay down. It is the state of the tree at
// f88c8364, measured rather than assumed, so that the FIRST new read anywhere in
// the V1 packages fails a named case. A gate written after the drift would have
// had to argue about which reads to keep.
//
// ---------------------------------------------------------------------------
// WHAT COUNTS AS A READ
//
// An AST match, so a name in a comment or a string is not one — the four
// mentions of `process.env` in `packages/contexts/**` at f88c8364 are all
// PROSE, in four domain-policy banners explaining why a limit is a parameter
// rather than a variable, and a text scan would have reported the tree as
// already broken and then been weakened until it was quiet.
//
//   process.env.NAME / process.env["NAME"]     the ordinary form
//   process["env"]                             element access on the object
//   globalThis.process.env, global.process.env the two global spellings
//   const { env } = process                    destructured off the process
//   const p = process; p.env                   through a local alias
//   import p from "node:process"; p.env        through the module's default
//   import { env } from "node:process"         the named export; every USE counts
//   import.meta.env                            the bundler-shaped spelling
//
// UNATTRIBUTABLE, AND THEREFORE REFUSED WHEREVER IT APPEARS:
//
//   process[expression]                        a computed key on the process
//
// A computed access cannot be shown to be `env` or shown not to be, so no file
// may do it — including a declared one. Failing closed on the axis that carries
// the evasion is the discipline `scripts/arch/sole-writer.mjs` records after the
// 2026-09-02 verification found six of seven spellings of a Prisma write
// invisible to a matcher that only knew the literal one.
//
// ---------------------------------------------------------------------------
// HONEST LIMITATIONS. These are NOT covered, and nothing this file prints may
// be read as covering them:
//
//   * NAME-DRIVEN, NOT TYPE-DRIVEN. Any expression spelled `process` is assumed
//     to be the Node process. A local parameter named `process` that is not one,
//     with a `.env` property, is an over-approximation and will fail. That
//     direction is deliberate; rename the local. This is the same contract
//     `sole-writer.mjs` states for a receiver spelled like a Prisma delegate.
//   * SHADOWING IS NOT MODELLED. A `process` that a surrounding scope rebound to
//     something else still counts.
//   * ONE FILE AT A TIME. An environment value read in file A and exported to
//     file B is one read, in A. A function that RETURNS `process.env` is
//     likewise one read at its own site — which is exactly the shape
//     `apps/core-api/src/config/environment.ts` is, and why one declared read
//     serves the whole process.
//   * NOTHING AT RUNTIME. `eval`, a dynamic `import()`, a native addon, or a
//     child process that inherits the environment are out of scope by
//     construction. The last of those is not a gap to close: the sixteen
//     declared reads below are all exactly that, a test harness handing a
//     database URL to a migration subprocess it spawned.
//   * THE V1 TREE ONLY. `apps/agent`, `apps/webapp`, `packages/core` and
//     `internal-packages` hold 526 environment reads between them at f88c8364
//     and are NOT scanned. They are the tree M2 is extracting FROM; pointing
//     this rule at them would produce a wall of findings nobody can act on,
//     which is how a gate stops being read. `max-file-lines.mjs` states the same
//     reasoning for the same eleven legacy directories.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The V1 tree. Identical to `SCAN_ROOTS` in `scripts/arch/composition-root.mjs`,
 * and deliberately so: those are the five roots ADR M0.3 §4 calls V1-owned, and
 * two gates that disagreed about what "V1 feature code" means would be two
 * different properties wearing one name.
 */
export const SCAN_ROOTS = Object.freeze([
  "packages/kernel",
  "packages/contexts",
  "packages/adapters",
  "apps/core-api",
  "apps/mcp-stdio",
]);

const SOURCE_EXTENSION = /\.(?:cts|mts|tsx?)$/u;
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", ".turbo", "generated", "coverage"]);

/** The module specifiers whose `env` export is the ambient environment. */
const PROCESS_MODULES = new Set(["node:process", "process"]);

/**
 * THE SINGLE DOCUMENTED EXCEPTION, plus the test harnesses that spawn a child.
 *
 * `role` separates the two, because they are two different claims:
 *
 *   `configuration` — the exception WIN-260's acceptance names. It is ONE FILE,
 *   not one directory: a directory-shaped exception grows a second reader the
 *   week after it is written and nothing goes red.
 *
 *   `test-support` — a suite or a harness that hands an inherited environment to
 *   a subprocess it spawns. These are not feature code and never run in a
 *   deployed process, but they are pinned to an EXACT count rather than exempted,
 *   because "it is a test file" is the sentence under which a real read would
 *   eventually be parked.
 *
 * `reads` is exact in both directions. A file that gains a read fails ENV-002; a
 * file that loses one fails ENV-003, so a pin cannot outlive the read it
 * describes and quietly license a future one.
 */
export const ALLOWED = Object.freeze([
  Object.freeze({
    path: "apps/core-api/src/config/environment.ts",
    role: "configuration",
    reads: 1,
    why: "The one environment read in the core-api deployable. It copies and freezes the ambient environment once, at startup, and hands it to the configuration contract as an ordinary value; every section module below it is a pure function over that value.",
  }),
  Object.freeze({
    path: "apps/mcp-stdio/src/environment.ts",
    role: "configuration",
    reads: 1,
    // FOUND BY THIS GATE ON ITS FIRST RUN. `apps/mcp-stdio/src/main.ts` held an
    // inline `process.env` exactly as `apps/core-api/src/main.ts` did, and no
    // rule in the repository had ever looked at it. It is a separate deployable
    // with a separate process edge, and ADR M0.3 §5.1 rule (j) is the reason it
    // may not borrow core-api's reader, so it has one of its own.
    why: "The one environment read in the stdio deployable. Rule (j) makes apps/core-api the single composition root, so this binary may not import that tree; it takes its own frozen copy and hands it to loadStdioConfiguration.",
  }),
  Object.freeze({
    path: "apps/core-api/src/config/platform.test.ts",
    role: "test-support",
    reads: 1,
    why: "The declared reader's own evidence. Proving that it returns a frozen SNAPSHOT rather than the live view means changing the ambient environment after the call and reading the copy back, which cannot be done without one read of the real thing.",
  }),
  Object.freeze({
    path: "apps/core-api/src/process.test.ts",
    role: "test-support",
    reads: 2,
    why: "The executable process evidence spawns the BUILT binary with a bare environment and forwards only PATH, so an inherited PLATOS_* variable from a developer's shell cannot change what the fail-closed cases prove.",
  }),
  Object.freeze({
    path: "apps/mcp-stdio/src/main.test.ts",
    role: "test-support",
    reads: 1,
    why: "The stdio binary's executable evidence spawns the built artifact with a bare environment and forwards only PATH, for the same reason its core-api counterpart does.",
  }),
  ...[
    "harness",
    "agents-harness",
    "channels-harness",
    "conversations-harness",
    "cost-harness",
    "eventing-harness",
    "files-harness",
    "governance-harness",
    "jobs-harness",
    "memory-harness",
    "privacy-harness",
    "providers-harness",
    "skills-harness",
    "tools-harness",
  ].map((name) =>
    Object.freeze({
      path: `packages/adapters/postgres-tenancy/src/${name}.ts`,
      role: "test-support",
      // `harness.ts` applies the migrations twice — once per baseline it sets up —
      // so it carries two spawns where its thirteen siblings carry one.
      reads: name === "harness" ? 2 : 1,
      why: "Real-PostgreSQL integration harness. It applies the repository's OWN migrations by spawning the ORM's CLI, which reads DATABASE_URL from the environment it is given, so the container's URL is layered over the inherited one.",
    }),
  ),
  Object.freeze({
    path: "packages/adapters/postgres-tenancy/src/json-columns.integration.test.ts",
    role: "test-support",
    reads: 1,
    why: "Applies migrations against the harness container in the same way, from the suite rather than from a shared harness, because it is the one suite that inspects the column types the migrations produced.",
  }),
]);

const allowedByPath = new Map(ALLOWED.map((entry) => [entry.path, entry]));

/** Every violation code this gate can raise. Distinct, so two cannot be confused. */
export const VIOLATION_CODES = Object.freeze({
  UNDECLARED: "ENV-001",
  ABOVE_PIN: "ENV-002",
  BELOW_PIN: "ENV-003",
  MISSING_FILE: "ENV-004",
  CENSUS_DRIFT: "ENV-005",
  UNATTRIBUTABLE: "ENV-006",
});

/**
 * The file census, READ BACK from a scan rather than computed here.
 *
 * A scan that silently stopped walking — a renamed root, a directory the skip
 * list swallowed, a permission error the walker caught — would otherwise report
 * a clean tree, which is the failure mode a containment gate cannot afford.
 *
 * ARITHMETIC. The tree at `f88c8364` scanned 1493, the same number
 * `scripts/arch/arch-boundaries.mjs` and `scripts/arch/composition-root.mjs` read
 * back over the same five roots. WIN-260 adds TEN files: seven configuration
 * modules and two suites under `apps/core-api/src/config/`, and one environment
 * reader under `apps/mcp-stdio/src/`. 1493 + 10 = 1503.
 */
export const EXPECTED_FILE_COUNT = 1503;

function listSourceFiles(root) {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSION.test(entry.name)) continue;
      found.push(relative(repositoryRoot, full).split("\\").join("/"));
    }
  };
  walk(join(repositoryRoot, root));
  return found;
}

/** Collect the local names that hold the process object in one source file. */
function collectProcessAliases(source) {
  const aliases = new Set();
  const namedEnvImports = new Set();

  const isProcessModule = (node) =>
    ts.isStringLiteral(node.moduleSpecifier) && PROCESS_MODULES.has(node.moduleSpecifier.text);

  const visitImports = (node) => {
    if (ts.isImportDeclaration(node) && isProcessModule(node)) {
      const clause = node.importClause;
      if (clause?.name !== undefined) aliases.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) aliases.add(bindings.name.text);
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (imported === "env") namedEnvImports.add(element.name.text);
          if (imported === "default") aliases.add(element.name.text);
        }
      }
    }
    ts.forEachChild(node, visitImports);
  };
  visitImports(source);

  // A second pass so `const p = process` is seen wherever it sits, and so an
  // alias of an alias resolves. Two passes are enough for every form in the
  // tree; a chain longer than that is named in the limitations above.
  for (let pass = 0; pass < 2; pass += 1) {
    const visitLocals = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer !== undefined &&
        ts.isIdentifier(node.name) &&
        isProcessExpression(node.initializer, aliases)
      ) {
        aliases.add(node.name.text);
      }
      ts.forEachChild(node, visitLocals);
    };
    visitLocals(source);
  }

  return { aliases, namedEnvImports };
}

/** Is this expression the process object, by any spelling this gate models? */
function isProcessExpression(node, aliases) {
  if (ts.isParenthesizedExpression(node)) return isProcessExpression(node.expression, aliases);
  if (ts.isIdentifier(node)) return node.text === "process" || aliases.has(node.text);
  if (ts.isPropertyAccessExpression(node) && node.name.text === "process") {
    return ts.isIdentifier(node.expression) && (node.expression.text === "globalThis" || node.expression.text === "global");
  }
  return false;
}

function isImportMeta(node) {
  return ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword;
}

/**
 * Every environment read in one file, with its line.
 *
 * `kind` is reported so a violation says WHICH spelling was used; a reader
 * chasing ENV-001 needs to know whether they are looking at `process.env` or at
 * a named import three files away.
 */
export function findEnvironmentReads(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const { aliases, namedEnvImports } = collectProcessAliases(source);
  const reads = [];

  const at = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const push = (node, kind) => reads.push({ path, line: at(node), kind, text: node.getText(source).slice(0, 80) });

  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "env") {
      if (isProcessExpression(node.expression, aliases)) push(node, "process.env");
      else if (isImportMeta(node.expression)) push(node, "import.meta.env");
    } else if (ts.isElementAccessExpression(node) && isProcessExpression(node.expression, aliases)) {
      const argument = node.argumentExpression;
      if (ts.isStringLiteral(argument)) {
        if (argument.text === "env") push(node, "process['env']");
      } else {
        // Fail closed on the axis that carries the evasion: a computed key on
        // the process object cannot be shown to be `env` OR shown not to be.
        push(node, "computed-process-key");
      }
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isObjectBindingPattern(node.name) &&
      isProcessExpression(node.initializer, aliases) &&
      node.name.elements.some((element) => (element.propertyName ?? element.name).getText(source) === "env")
    ) {
      push(node, "destructured-env");
    } else if (
      ts.isIdentifier(node) &&
      namedEnvImports.has(node.text) &&
      !ts.isImportSpecifier(node.parent) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      push(node, "named-env-import");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
}

/**
 * Read the tree: every source file under the five roots, and every environment
 * read in each. Separate from `judge` so the judgement can be exercised against
 * a scan this file did not produce — which is the only way to see a violation
 * code that the live tree, by design, never raises.
 */
export function scan() {
  const files = SCAN_ROOTS.flatMap((scanRoot) => listSourceFiles(scanRoot));
  const readsByFile = new Map();

  for (const path of files) {
    const text = readFileSync(join(repositoryRoot, path), "utf8");
    // A cheap pre-filter. Every spelling this gate models contains the three
    // letters, so a file without them cannot hold a read, and the parser is
    // skipped for the roughly fourteen hundred files that do not.
    if (!text.includes("env")) continue;
    const reads = findEnvironmentReads(path, text);
    if (reads.length === 0) continue;
    readsByFile.set(path, reads);
  }
  return { files, readsByFile };
}

export function judge({ files, readsByFile }, expectedFileCount = EXPECTED_FILE_COUNT) {
  let totalReads = 0;
  for (const reads of readsByFile.values()) totalReads += reads.length;

  const violations = [];

  for (const [path, reads] of [...readsByFile].sort(([a], [b]) => a.localeCompare(b))) {
    const unattributable = reads.filter((read) => read.kind === "computed-process-key");
    for (const read of unattributable) {
      violations.push({
        code: VIOLATION_CODES.UNATTRIBUTABLE,
        path,
        line: read.line,
        message: `a computed key on the process object cannot be shown to be env or not to be: ${read.text}`,
      });
    }

    const declaration = allowedByPath.get(path);
    if (declaration === undefined) {
      for (const read of reads) {
        if (read.kind === "computed-process-key") continue;
        violations.push({
          code: VIOLATION_CODES.UNDECLARED,
          path,
          line: read.line,
          message: `reads the ambient environment (${read.kind}); feature code must take configuration as an argument. The one declared reader is apps/core-api/src/config/environment.ts.`,
        });
      }
      continue;
    }

    const counted = reads.filter((read) => read.kind !== "computed-process-key").length;
    if (counted > declaration.reads) {
      violations.push({
        code: VIOLATION_CODES.ABOVE_PIN,
        path,
        line: 0,
        message: `declares ${String(declaration.reads)} environment read(s) and now holds ${String(counted)}`,
      });
    } else if (counted < declaration.reads) {
      violations.push({
        code: VIOLATION_CODES.BELOW_PIN,
        path,
        line: 0,
        message: `declares ${String(declaration.reads)} environment read(s) and now holds ${String(counted)}; a pin that outlives its read licenses a future one`,
      });
    }
  }

  const fileSet = new Set(files);
  for (const entry of ALLOWED) {
    if (fileSet.has(entry.path)) continue;
    violations.push({
      code: VIOLATION_CODES.MISSING_FILE,
      path: entry.path,
      line: 0,
      message: "is declared here but is not a source file under the scanned roots",
    });
  }
  for (const entry of ALLOWED) {
    if (readsByFile.has(entry.path) || !fileSet.has(entry.path)) continue;
    violations.push({
      code: VIOLATION_CODES.BELOW_PIN,
      path: entry.path,
      line: 0,
      message: `declares ${String(entry.reads)} environment read(s) and now holds 0`,
    });
  }

  if (files.length !== expectedFileCount) {
    violations.push({
      code: VIOLATION_CODES.CENSUS_DRIFT,
      path: "scripts/arch/env-access.mjs",
      line: 0,
      message: `EXPECTED_FILE_COUNT is ${String(expectedFileCount)} and the scan read back ${String(files.length)}`,
    });
  }

  const declaredReads = ALLOWED.reduce((sum, entry) => sum + entry.reads, 0);
  return {
    fileCount: files.length,
    readCount: totalReads,
    declaredReads,
    filesWithReads: readsByFile.size,
    reads: [...readsByFile.values()].flat(),
    violations,
  };
}

export function analyse() {
  return judge(scan());
}

function main(argv) {
  const result = analyse();
  if (argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.violations.length === 0 ? 0 : 1;
    return;
  }
  if (argv.includes("--report")) {
    for (const read of result.reads) console.log(`  ${read.path}:${String(read.line)} ${read.kind}`);
  }
  console.log(
    `env-access: scanned ${String(result.fileCount)} source file(s) under ${SCAN_ROOTS.join(", ")}; ` +
      `${String(result.readCount)} environment read(s) in ${String(result.filesWithReads)} file(s), ` +
      `${String(result.declaredReads)} declared`,
  );
  for (const violation of result.violations) {
    const where = violation.line > 0 ? `${violation.path}:${String(violation.line)}` : violation.path;
    console.log(`${violation.code} ${where}: ${violation.message}`);
  }
  if (result.violations.length > 0) {
    console.log(`FAIL: ${String(result.violations.length)} environment-access violation(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "ok: the only environment read in V1 feature code is the declared configuration reader; " +
      "every test-support read matches its pin exactly.",
  );
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) main(process.argv.slice(2));
