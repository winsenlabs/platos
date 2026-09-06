#!/usr/bin/env node
// The TRANSACTION-OUTCOME assertion: `UnitOfWork.run` REFUSES a callback whose
// answer is a `Result`, and nothing casts its way past the refusal.
//
// WHY A GATE FOR SOMETHING THE COMPILER ALREADY DOES.
//
// `packages/kernel/src/ports/unit-of-work.ts` spells the rule as a type:
// `run`'s callback returns `NotResult<Value>`, which is `never` when `Value` is
// a `Result`, so the 112 call sites that once resolved with an error — and
// therefore COMMITTED — no longer compile. That is a real mechanism and `tsc`
// enforces it on every build.
//
// It is also INVISIBLE. Nothing in this repository would go red if the
// `NotResult` were quietly dropped back to `Value`: the tree would simply
// compile again, all 1,690-odd suites would stay green, and the defect that
// `cost-monitoring` shipped — a threshold event committed with no delivery rows
// beside it — would become writable again in one character of diff. A guard
// nothing can turn red is a guard that is not there, and a TYPE guard is the
// easiest kind to lose that way, because losing it looks like nothing at all.
//
// So this gate compiles PROBES against the real kernel source and asserts what
// the compiler answered. Mutate the signature and X1 goes red by name.
//
//   node scripts/arch/transaction-outcome.mjs          # check, exit 1 on violation
//   node scripts/arch/transaction-outcome.mjs --json   # machine-readable
//
// WHAT IT IS JOINED TO, WHICH IS THE POINT. The probes are compiled by the
// TypeScript compiler against `packages/kernel/src/ports/unit-of-work.ts` ON
// DISK. Neither the compiler's answer nor that file is something this gate
// controls, so a mutation of either shows up here. An assertion comparing two
// things the same author owns cannot fail; this one can.
//
// TWO RULES, TWO CODES, because they are two different failures. X1 says the
// type stopped meaning anything. X2 says the type still means something and a
// call site walked around it. A reader told only "TRANSACTION_OUTCOME" would
// have to go and find out which.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The port under assertion. Read from disk; never reproduced here. */
export const PORT_PATH = "packages/kernel/src/ports/unit-of-work.ts";

/**
 * The ONE file entitled to drop the refusal.
 *
 * `runResult` cannot discharge it — `Value` is a bare type parameter and
 * `NotResult<Value>` stays deferred on one — so the kernel holds an
 * `UnconstrainedUnitOfWork` view for its own single call. Anywhere else, the
 * same move is a way around the mechanism rather than the mechanism's own
 * plumbing.
 */
export const ESCAPE_OWNER = PORT_PATH;

/**
 * The methods whose callback return position carries the refusal.
 *
 * `run` is the kernel port's. `atomic` is `TenancyTransactions`' pass-through to
 * it, which carries `NotResult<Value>` for the same reason and would otherwise
 * be the way around a refusal that still holds.
 */
export const CONSTRAINED_METHODS = new Set(["run", "atomic"]);

export const RULES = [
  { id: "X1", description: "UnitOfWork.run must REFUSE a callback whose answer is a Result, and accept every other shape" },
  { id: "X2", description: "no call site may cast the receiver of .run( or .atomic( to walk around that refusal" },
];

const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".turbo", "coverage"]);

/**
 * The FIVE V1 roots, the same five `scripts/arch/composition-root.mjs` walks.
 *
 * `apps/agent` is deliberately NOT among them. It is the pre-V1 deployable, it
 * does not import `@platos/kernel`, and its `.run(` calls belong to a scheduling
 * runtime that has nothing to do with this port — naming them here would fail
 * honest code and force an exception list, which is how a gate stops meaning
 * anything.
 */
const SCANNED_ROOTS = ["packages/kernel", "packages/contexts", "packages/adapters", "apps/core-api", "apps/mcp-stdio"];

// ---------------------------------------------------------------------------
// X1 — the probes.
// ---------------------------------------------------------------------------

/**
 * Eight probes: one that MUST be refused, and seven that must NOT be.
 *
 * The seven are not padding. `NotResult` discriminates structurally on
 * `{ readonly ok: boolean }`, and a discrimination that is too WIDE is as much a
 * defect as one that is too narrow: it would refuse honest callbacks and push
 * their authors back towards a bespoke carrier, which is the thing this whole
 * dimension exists to stop. A gate that only pinned the refusal would pass
 * happily if `NotResult<Value>` were mutated to plain `never`, which refuses
 * everything.
 */
export const PROBES = [
  {
    id: "result",
    expect: "refused",
    label: "a callback answering with a Result — the shape that COMMITS",
    body: "const answer = await unitOfWork.run(async () => ok(1));",
  },
  {
    id: "result-union",
    expect: "refused",
    label: "a callback answering with a Result union — the same shape wearing a null",
    body: "const answer = await unitOfWork.run(async (): Promise<Result<number> | null> => null);",
  },
  {
    id: "void",
    expect: "accepted",
    label: "a callback answering with nothing",
    body: "const answer = await unitOfWork.run(async () => {});",
  },
  {
    id: "undefined",
    expect: "accepted",
    label: "a callback answering with undefined",
    body: "const answer = await unitOfWork.run(async () => undefined);",
  },
  {
    id: "null-union",
    expect: "accepted",
    label: "a callback answering with a record or null",
    body: "const answer = await unitOfWork.run(async (): Promise<{ id: string } | null> => null);",
  },
  {
    id: "array",
    expect: "accepted",
    label: "a callback answering with an array",
    body: "const answer = await unitOfWork.run(async () => [1, 2, 3]);",
  },
  {
    id: "record",
    expect: "accepted",
    label: "a callback answering with an ordinary record",
    body: "const answer = await unitOfWork.run(async () => ({ id: 'x' }));",
  },
  {
    id: "scope",
    expect: "accepted",
    label: "a callback answering with something read off the transaction scope",
    body: "const answer = await unitOfWork.run(async (transaction) => transaction.transactionId);",
  },
];

const PROBE_FILE = "__transaction-outcome-probe.ts";

function probeSource(body, portModule) {
  return [
    `import type { Result } from ${JSON.stringify(`${portModule}/../vo/error.js`)};`,
    `import { ok } from ${JSON.stringify(`${portModule}/../vo/error.js`)};`,
    `import type { UnitOfWork } from ${JSON.stringify(`${portModule}/unit-of-work.js`)};`,
    "",
    "declare const unitOfWork: UnitOfWork;",
    "",
    "export async function probe(): Promise<unknown> {",
    `  ${body}`,
    "  return typeof answer === 'undefined' ? null : answer;",
    "}",
  ].join("\n");
}

const COMPILER_OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2022.d.ts"],
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  noUncheckedIndexedAccess: true,
};

/**
 * Compile ONE probe and answer what the compiler said.
 *
 * Each probe gets its own program so a refusal in one cannot mask an acceptance
 * in another — the failure mode of a single program with eight statements in it.
 */
function compileProbe(root, probe) {
  const portDirectory = join(root, dirname(PORT_PATH));
  const probePath = join(portDirectory, PROBE_FILE);
  const text = probeSource(probe.body, ".");
  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (name) => (resolve(name) === resolve(probePath) ? text : readFile(name));
  host.fileExists = (name) => (resolve(name) === resolve(probePath) ? true : fileExists(name));
  const program = ts.createProgram([probePath], COMPILER_OPTIONS, host);
  const source = program.getSourceFile(probePath);
  const diagnostics = source === undefined ? [] : [...program.getSemanticDiagnostics(source), ...program.getSyntacticDiagnostics(source)];
  return {
    loaded: source !== undefined,
    diagnostics: diagnostics.map((d) => ({
      code: `TS${d.code}`,
      message: ts.flattenDiagnosticMessageText(d.messageText, " "),
    })),
  };
}

/**
 * The port must actually have RESOLVED.
 *
 * TS2307 is "cannot find module". If the kernel moved, or the probe's import
 * specifier rotted, every `refused` probe would still report a diagnostic and
 * this gate would go green on a refusal it never actually saw. That is the
 * vacuous pass this check exists to refuse.
 */
const UNRESOLVED = "TS2307";

export function checkProbes(root = repositoryRoot) {
  const violations = [];
  const observed = [];
  for (const probe of PROBES) {
    const { loaded, diagnostics } = compileProbe(root, probe);
    const unresolved = diagnostics.filter((d) => d.code === UNRESOLVED);
    const refused = diagnostics.length > 0;
    observed.push({ id: probe.id, expect: probe.expect, refused, codes: diagnostics.map((d) => d.code) });
    if (!loaded || unresolved.length > 0) {
      violations.push({
        rule: "X1",
        path: PORT_PATH,
        line: 1,
        message: `probe ${probe.id} did not resolve the port; this gate would pass vacuously (${unresolved.map((d) => d.message).join("; ") || "probe file not in program"})`,
      });
      continue;
    }
    if (probe.expect === "refused" && !refused) {
      violations.push({
        rule: "X1",
        path: PORT_PATH,
        line: 1,
        message: `run ACCEPTED ${probe.label}; an error Result returned there resolves the callback, and a resolved callback COMMITS`,
      });
    }
    if (probe.expect === "accepted" && refused) {
      violations.push({
        rule: "X1",
        path: PORT_PATH,
        line: 1,
        message: `run REFUSED ${probe.label}; the refusal is too wide and pushes honest callbacks back towards a bespoke carrier (${diagnostics.map((d) => d.code).join(", ")})`,
      });
    }
  }
  return { violations, observed };
}

// ---------------------------------------------------------------------------
// X2 — nothing casts its way past the refusal.
// ---------------------------------------------------------------------------

function listScannedFiles(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const child = join(directory, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) found.push(child);
    }
  };
  for (const scanned of SCANNED_ROOTS) {
    const absolute = join(root, scanned);
    if (statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) walk(absolute);
  }
  return found.sort();
}

/**
 * A REAL AST WALK, not a regex.
 *
 * The prose in `unit-of-work.ts` and in three context headers describes the cast
 * it forbids, in the sentence explaining why it is forbidden. A regex gate would
 * fail on the documentation of its own rule.
 */
export function analyzeSource(virtualPath, text) {
  const sourceFile = ts.createSourceFile(virtualPath, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const violations = [];
  const visit = (node) => {
    // `(x as Something).run(...)` — an assertion standing where the refusal
    // would otherwise apply.
    //
    // `atomic` IS IN THE SET FOR THE SAME REASON `run` IS. It is
    // `TenancyTransactions`' pass-through to `run` and it carries the same
    // `NotResult` constraint, so a cast of ITS receiver drops the refusal just
    // as completely. That hole was real: `atomic` shipped without the constraint
    // and three of the store's own writes were going through it.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      CONSTRAINED_METHODS.has(node.expression.name.text)
    ) {
      let receiver = node.expression.expression;
      while (ts.isParenthesizedExpression(receiver)) receiver = receiver.expression;
      if (ts.isAsExpression(receiver) || ts.isTypeAssertionExpression(receiver)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push({
          rule: "X2",
          path: virtualPath,
          line: line + 1,
          message: `casts the receiver of .${node.expression.name.text}( ; that drops the NotResult refusal at this call site. Use runResult (or atomicResult) when the answer is a Result`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

export function checkCasts(root = repositoryRoot) {
  const files = listScannedFiles(root);
  const violations = [];
  for (const absolute of files) {
    const virtualPath = relative(root, absolute).split("\\").join("/");
    if (virtualPath === ESCAPE_OWNER) continue;
    violations.push(...analyzeSource(virtualPath, readFileSync(absolute, "utf8")));
  }
  return { fileCount: files.length, violations };
}

export function checkTransactionOutcome(root = repositoryRoot) {
  const probes = checkProbes(root);
  const casts = checkCasts(root);
  return {
    fileCount: casts.fileCount,
    probeCount: PROBES.length,
    observed: probes.observed,
    violations: [...probes.violations, ...casts.violations],
  };
}

function main() {
  const result = checkTransactionOutcome();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.violations.length > 0 || result.fileCount === 0 ? 1 : 0;
    return;
  }

  // A SCAN THAT FOUND NOTHING TO SCAN IS NOT A PASS.
  if (result.fileCount === 0) {
    process.stdout.write(`FAIL: transaction-outcome scan is vacuous; no source file found under ${SCANNED_ROOTS.join(", ")}\n`);
    process.exitCode = 1;
    return;
  }

  if (result.violations.length === 0) {
    process.stdout.write(
      `transaction-outcome: ${result.probeCount} probe(s) compiled against ${PORT_PATH}, ${result.fileCount} file(s) scanned for casts\n` +
        `ok: run refuses a Result-valued callback and accepts every other shape, and no call site casts around it (${RULES.length} rules).\n`,
    );
    process.exitCode = 0;
    return;
  }

  for (const violation of result.violations) {
    process.stdout.write(`${violation.rule} ${violation.path}:${violation.line} — ${violation.message}\n`);
  }
  process.stdout.write(`\n${result.violations.length} transaction-outcome violation(s).\n`);
  process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith("transaction-outcome.mjs")) main();
