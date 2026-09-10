#!/usr/bin/env node
// THE WIN-272 (M4.6) MUTATION DRIVER. Re-runnable, not described.
//
// It applies each row of `scripts/win272-mutation-plan.json` to the working tree,
// runs only the suites that row names, records whether any of them FAILED, and
// puts the file back. The ledger it writes is `scripts/mutations-win272-m46.json`.
//
// -----------------------------------------------------------------------------
// THREE WAYS TO GET THIS WRONG, ALL OF THEM PAID FOR BY THE PREVIOUS TRANCHE AND
// ALL OF THEM WRONG IN THE SURVIVING-LOOKS-LIKE-GOOD-NEWS DIRECTION
//
//   (1) A PIPE HIDES THE EXIT STATUS. `execSync("suite | tail")` reports TAIL's
//       status, which is 0 whatever the suite did — WIN-271's first driver recorded
//       0 of 19 killed for exactly that reason. Nothing here pipes: `spawnSync`
//       runs the runner directly and the child's own `status` is what decides.
//
//   (2) A SOURCE MUTATION OF A PACKAGE CONSUMED THROUGH `dist/` MUTATES A FILE
//       NOTHING READS. `@platos/kernel` resolves to `dist` for `redis-streams` and
//       for `apps/core-api`, so a kernel mutation is invisible to those suites
//       until the package is rebuilt. Every kernel row DECLARES its rebuild and
//       this driver REFUSES a row that mutates `packages/kernel` without one — a
//       missing rebuild would otherwise be reported as a survivor.
//
//   (3) A FAILING-CASE PATTERN WRITTEN AGAINST ANSI BYTES FINDS NOTHING. pnpm does
//       not hand a child's output back on `execSync`'s error object, so a driver
//       that matched on colours recorded kills with no case name. `spawnSync`
//       captures both streams itself and the pattern is stripped of escape
//       sequences before it is searched.
//
// -----------------------------------------------------------------------------
// WHAT A KILL IS, AND WHAT IT IS NOT
//
// A KILL is a suite the runner reports as FAILED. A row whose suites all pass is a
// SURVIVOR and is recorded as one — this driver never reasons about whether a
// survivor "would have" been caught.
//
// TWO OUTCOMES ARE COUNTED APART FROM A KILL, and both separations were forced by a
// row of this very plan.
//
//   `refused-by-compiler` — the mutation does not typecheck. A type error is
//   evidence the TYPE LAYER holds, not evidence a case noticed, and collapsing the
//   two would let this driver claim behavioural coverage it does not have. M04's
//   first draft was one.
//
//   `timed-out` — the suite never returned. M20's first draft left the credential
//   fence's `remaining` NEGATIVE, which collapsed the pump's block window to one
//   millisecond and busy-looped against a real Redis; two runners sat at 99% CPU for
//   over an hour. `spawnSync` reports a timeout with a NULL status, and null is not
//   zero — so a `status !== 0` test alone would have recorded that hang as a kill.
//
//   node scripts/run-win272-mutations.mjs                 # every row
//   node scripts/run-win272-mutations.mjs --no-container  # skip the rows needing Docker
//   node scripts/run-win272-mutations.mjs --only M10,M22

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const PLAN_PATH = "scripts/win272-mutation-plan.json";
const LEDGER_PATH = "scripts/mutations-win272-m46.json";

/**
 * How each named suite is run. NO PIPES, and each one is the command a human would
 * type — a driver that invented a narrower selection could pass a mutation the real
 * gate would catch.
 */
const SUITES = {
  kernel: {
    command: ["pnpm", "--filter", "@platos/kernel", "exec", "vitest", "run", "src/vo/stream-frame.test.ts"],
    container: false,
  },
  "core-api-unit": {
    command: ["pnpm", "--filter", "@platos/core-api", "test"],
    container: false,
  },
  "redis-streams-integration": {
    command: ["pnpm", "test:redis-streams:integration"],
    container: true,
  },
  "core-api-integration": {
    command: [
      "pnpm", "--filter", "@platos/core-api", "exec", "vitest", "run",
      "src/composition/stream-lane.integration.test.ts",
      "--no-file-parallelism", "--testTimeout=180000", "--hookTimeout=300000",
    ],
    container: true,
  },
};

const ANSI = /\[[0-9;]*m/gu;

/**
 * How long one suite may take before the driver stops waiting.
 *
 * SHORTER THAN A KILL IS PATIENT FOR, AND A DISTINCT VERDICT, because a mutation
 * that HANGS a suite is not a mutation that KILLS it. The first draft of M20 left
 * `remaining` negative, which collapsed the pump's block window to one millisecond
 * and busy-looped against a real Redis; two orphaned runners sat at 99% CPU for over
 * an hour on the mini. With only a thirty-minute ceiling and a `status !== 0` test,
 * the eventual timeout would have been recorded as a KILL — coverage the sweep does
 * not have. Ten minutes is well past the slowest honest row (the trim case writes
 * 10,010 frames) and well short of an hour.
 */
const SUITE_DEADLINE_MS = 600_000;

function run(command, { timeoutMs = SUITE_DEADLINE_MS } = {}) {
  const [program, ...rest] = command;
  const result = spawnSync(program, rest, {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    env: process.env,
    // NO SHELL AND NO PIPE. See hazard (1).
    shell: false,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.replace(ANSI, "");
  // `spawnSync` reports a timeout by setting `error` and leaving `status` null, and
  // a null status is not zero — so a driver that only asked `status !== 0` would call
  // a hang a kill. The two are separated here and stay separated in the ledger.
  const timedOut = result.error !== undefined && /ETIMEDOUT|timed out/iu.test(String(result.error));
  return { status: result.status, output, timedOut };
}

/** The failing case names the runner printed, so a kill can be attributed. */
function failedCaseNames(output) {
  const names = [];
  for (const line of output.split("\n")) {
    const failure = /^\s*(?:×|✕)\s+(.*?)(?:\s+\d+ms)?$/u.exec(line);
    if (failure !== null && failure[1] !== undefined) names.push(failure[1].trim());
    const nodeTest = /^✖\s+(.*?)\s+\(/u.exec(line.trim());
    if (nodeTest !== null && nodeTest[1] !== undefined) names.push(nodeTest[1].trim());
  }
  return [...new Set(names)].slice(0, 6);
}

function looksLikeCompileRefusal(output) {
  return /error TS\d+|Transform failed|Expression expected|Unexpected token/u.test(output);
}

function main() {
  const plan = JSON.parse(readFileSync(join(repositoryRoot, PLAN_PATH), "utf8"));
  const skipContainer = process.argv.includes("--no-container");
  const onlyFlag = process.argv.find((argument) => argument.startsWith("--only="));
  const only = onlyFlag === undefined ? null : new Set(onlyFlag.slice("--only=".length).split(","));

  const results = [];
  for (const mutation of plan.mutations) {
    if (only !== null && !only.has(mutation.id)) continue;
    if (mutation.container === true && skipContainer) {
      results.push({ id: mutation.id, verdict: "skipped-no-container", subject: mutation.subject });
      process.stdout.write(`${mutation.id} SKIPPED (needs a container)\n`);
      continue;
    }
    // HAZARD (2), REFUSED RATHER THAN SURVIVED.
    if (mutation.file.startsWith("packages/kernel/") && (mutation.rebuild ?? []).length === 0) {
      throw new Error(
        `${mutation.id} mutates the kernel and declares no rebuild; every consumer reads it through dist/`,
      );
    }

    const absolute = join(repositoryRoot, mutation.file);
    const original = readFileSync(absolute, "utf8");
    const occurrences = original.split(mutation.find).length - 1;
    if (occurrences !== 1) {
      throw new Error(`${mutation.id} anchor matches ${String(occurrences)} time(s) in ${mutation.file}`);
    }

    writeFileSync(absolute, original.replace(mutation.find, mutation.replace));
    let verdict = "SURVIVED";
    let killedBy = null;
    let cases = [];
    let compileRefusal = false;
    try {
      for (const packageName of mutation.rebuild ?? []) {
        const built = run(["pnpm", "--filter", packageName, "build"]);
        if (built.status !== 0) {
          compileRefusal = looksLikeCompileRefusal(built.output);
          verdict = compileRefusal ? "refused-by-compiler" : "KILLED";
          killedBy = `${packageName} build`;
          cases = failedCaseNames(built.output);
          break;
        }
      }
      if (verdict === "SURVIVED") {
        for (const suiteName of mutation.suites) {
          const suite = SUITES[suiteName];
          if (suite === undefined) throw new Error(`${mutation.id} names unknown suite ${suiteName}`);
          const ran = run(suite.command);
          if (ran.timedOut) {
            // NOT A KILL. See `SUITE_DEADLINE_MS`.
            verdict = "timed-out";
            killedBy = suiteName;
            cases = [];
            break;
          }
          if (ran.status !== 0) {
            compileRefusal = looksLikeCompileRefusal(ran.output);
            verdict = compileRefusal ? "refused-by-compiler" : "KILLED";
            killedBy = suiteName;
            cases = failedCaseNames(ran.output);
            break;
          }
        }
      }
    } finally {
      writeFileSync(absolute, original);
      for (const packageName of mutation.rebuild ?? []) run(["pnpm", "--filter", packageName, "build"]);
    }
    results.push({
      id: mutation.id,
      subject: mutation.subject,
      file: mutation.file,
      breaks: mutation.breaks,
      verdict,
      killedBy,
      cases,
    });
    process.stdout.write(
      `${mutation.id} ${verdict}${killedBy === null ? "" : ` by ${killedBy}`}` +
        `${cases.length === 0 ? "" : ` — ${cases[0] ?? ""}`}\n`,
    );
  }

  const killed = results.filter((row) => row.verdict === "KILLED").length;
  const survived = results.filter((row) => row.verdict === "SURVIVED").length;
  const refused = results.filter((row) => row.verdict === "refused-by-compiler").length;
  const skipped = results.filter((row) => row.verdict === "skipped-no-container").length;
  const timedOut = results.filter((row) => row.verdict === "timed-out").length;
  const ledger = {
    issue: "WIN-272 (M4.6)",
    purpose:
      "One row per broken decision, with the suite that noticed and the case that failed. Re-runnable: " +
      "node scripts/run-win272-mutations.mjs. A SURVIVOR is recorded as one and never explained away, " +
      "and a mutation the compiler refuses is counted apart from a kill because a type error is evidence " +
      "the type layer holds rather than evidence a case noticed. A row whose suite TIMED OUT is counted " +
      "apart from both, because a mutation that hangs a suite is not one that kills it.",
    totals: { rows: results.length, killed, survived, refusedByCompiler: refused, timedOut, skipped },
    rows: results,
  };
  writeFileSync(join(repositoryRoot, LEDGER_PATH), `${JSON.stringify(ledger, null, 2)}\n`);
  process.stdout.write(
    `\n${String(killed)} killed, ${String(survived)} survived, ${String(refused)} refused by the compiler, ` +
      `${String(timedOut)} timed out, ${String(skipped)} skipped — wrote ${LEDGER_PATH}\n`,
  );
  process.exitCode = survived + timedOut > 0 ? 1 : 0;
}

main();
