#!/usr/bin/env node
// The AMBIENT-TIME assertion: a context's domain and application read time,
// randomness and scheduling only through a port.
//
// WHY THIS GATE DID NOT EXIST AND HAD TO.
//
// ADR M0.3 §4 declares a `Clock` port and every context's `dependencies.ts`
// takes one. `tenancy`'s says it outright — "Time and identity are PORTS, not
// ambient functions. No `new Date()` and no random identifier back inside a use
// case" — and `secrets` and `tools` say the same in their own words. All four
// statements were PROSE. Nothing checked them. `scripts/arch/boundary-rules.mjs`
// is an import-graph checker and `Date` is a global: there is no import to ban,
// so the one rule set that could have carried this could not express it.
//
// The tree happened to be clean when this was written, and that is the argument
// FOR the gate rather than against it. A discipline four files describe and
// nothing enforces is a discipline that survives exactly as long as the people
// who remember it, and the first violation is invisible — a use case that reads
// the wall clock passes every test that runs at any instant, and fails only the
// one nobody wrote, at the boundary of a billing period or a token expiry.
//
// WHAT IT BUYS, CONCRETELY. `governance` caught version attribution stamping
// the LIVE binding rather than the version under review, and it caught it
// because the clock was injected and a suite could put the two instants either
// side of the write. That case is unwritable against `Date.now()`.
//
//   node scripts/arch/ambient-time.mjs          # check, exit 1 on violation
//   node scripts/arch/ambient-time.mjs --json   # machine-readable
//
// SCOPE, AND WHY THE KERNEL IS NOT IN IT. `packages/kernel` is held to the same
// bar by `scripts/arch/kernel-content.mjs` rule K4, which is stricter still —
// it refuses `new Date(...)` with arguments, `process`, `crypto` and the rest.
// Repeating it here would give one violation two names in two reports.
//
// ADAPTERS ARE DELIBERATELY OUT OF SCOPE. An adapter is where infrastructure
// lives: `process-ports.ts` implements the `Clock` with `new Date()` and must,
// the postgres adapter times a pool wait, the shutdown sequence measures a
// budget. Naming them here would either fail honest code or need an exception
// list, and an exception list is how a gate stops meaning anything.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The two layers of every context. The onion's inside. */
export const SCANNED_LAYERS = ["domain", "application"];

export const CONTEXTS_ROOT = "packages/contexts";

const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".turbo", "coverage"]);

/**
 * The five rules, with five ids.
 *
 * They are five and not one because they are five different substitutions. A
 * reader who has just been told "T4: draws a random number" knows to reach for
 * `IdGenerator`; a reader told "AMBIENT_INFRASTRUCTURE" has to go and find out
 * which of five things they did. Two guards returning the same code cannot be
 * told apart, and that is how two defects hid behind one code in `privacy` and
 * in `identity-access`.
 */
export const RULES = [
  { id: "T1", description: "calls Date.now(); take the instant from the Clock port" },
  { id: "T2", description: "constructs new Date() with no argument; that is the wall clock wearing a constructor" },
  { id: "T3", description: "calls performance.now(); a monotonic clock is still a clock" },
  { id: "T4", description: "calls Math.random(); take identity from the IdGenerator port" },
  { id: "T5", description: "schedules with setTimeout/setInterval; scheduling belongs to an adapter" },
];

const SCHEDULERS = new Set(["setTimeout", "setInterval", "setImmediate"]);

function listScannedFiles(root) {
  const found = [];
  const contextsRoot = join(root, CONTEXTS_ROOT);
  if (!statSync(contextsRoot, { throwIfNoEntry: false })?.isDirectory()) return found;

  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(child);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        found.push(child);
      }
    }
  };

  for (const context of readdirSync(contextsRoot, { withFileTypes: true })) {
    if (!context.isDirectory() || SKIP_DIRECTORIES.has(context.name)) continue;
    for (const layer of SCANNED_LAYERS) {
      const layerRoot = join(contextsRoot, context.name, layer);
      if (!statSync(layerRoot, { throwIfNoEntry: false })?.isDirectory()) continue;
      walk(layerRoot);
    }
  }
  return found.sort();
}

/**
 * A REAL AST WALK over the TypeScript parser, not a regex.
 *
 * A regex cannot tell `Date.now()` in code from `Date.now()` inside a comment
 * explaining why the code does not call it — and four of this repository's
 * context headers contain exactly that sentence. A regex gate would have failed
 * on the prose that describes the rule it enforces.
 */
export function analyzeSource(virtualPath, text) {
  const sourceFile = ts.createSourceFile(virtualPath, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const violations = [];
  const report = (rule, node, message) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({ rule, path: virtualPath, line: line + 1, message });
  };

  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const object = node.expression.text;
      const member = node.name.text;
      if (object === "Date" && member === "now") {
        report("T1", node, "calls Date.now(); the instant is an input, taken from the Clock port");
      }
      if (object === "performance" && member === "now") {
        report("T3", node, "calls performance.now(); a monotonic reading is still a reading and belongs to an adapter");
      }
      if (object === "Math" && member === "random") {
        report("T4", node, "calls Math.random(); identity and randomness come from the IdGenerator port");
      }
    }

    // `new Date()` with NO argument is the wall clock. `new Date(value)` is
    // DECODING — a stored timestamp, a computed due instant — and is allowed,
    // because forbidding it would leave a use case unable to name any instant at
    // all, including one the Clock handed it.
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Date" &&
      (node.arguments === undefined || node.arguments.length === 0)
    ) {
      report("T2", node, "constructs new Date() with no argument; that is Date.now() wearing a constructor");
    }

    // A CALL, not a mere mention: a type position (`ReturnType<typeof setTimeout>`)
    // names the scheduler without scheduling anything.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && SCHEDULERS.has(node.expression.text)) {
      report(
        "T5",
        node,
        `calls ${node.expression.text}(); scheduling is infrastructure and belongs behind a port`,
      );
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

export function checkAmbientTime(root = repositoryRoot) {
  const files = listScannedFiles(root);
  const violations = [];
  for (const absolute of files) {
    const virtualPath = relative(root, absolute).split("\\").join("/");
    violations.push(...analyzeSource(virtualPath, readFileSync(absolute, "utf8")));
  }
  return { fileCount: files.length, violations };
}

function main() {
  const result = checkAmbientTime();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.violations.length > 0 || result.fileCount === 0 ? 1 : 0;
    return;
  }

  // A SCAN THAT FOUND NOTHING TO SCAN IS NOT A PASS. A renamed directory, a
  // moved layer or a broken walk would otherwise report "ok: 0 violations" for
  // ever, which is the failure mode every green gate should be asked about
  // first.
  if (result.fileCount === 0) {
    process.stdout.write(
      `FAIL: ambient-time scan is vacuous; no source file found under ${CONTEXTS_ROOT}/*/{${SCANNED_LAYERS.join(",")}}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (result.violations.length === 0) {
    process.stdout.write(
      `ambient-time: scanned ${result.fileCount} file(s) under ${CONTEXTS_ROOT}/*/{${SCANNED_LAYERS.join(",")}}\n` +
        `ok: ${result.fileCount} file(s) read time, randomness and scheduling only through a port (${RULES.length} rules).\n`,
    );
    process.exitCode = 0;
    return;
  }

  for (const violation of result.violations) {
    process.stdout.write(`${violation.rule} ${violation.path}:${violation.line} — ${violation.message}\n`);
  }
  process.stdout.write(`\n${result.violations.length} ambient-time violation(s).\n`);
  process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith("ambient-time.mjs")) main();
