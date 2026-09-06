// The mutation driver for `mutations-eventing.json`.
//
// Not committed: it is an instrument, and every tranche has written its own.
// What it guarantees is the two things the acceptance asks for — the suites are
// proved GREEN with a non-zero executed case count BEFORE anything is mutated,
// and a run that executed no cases is classified VACUOUS rather than as a kill.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const packageRoot = resolve(process.argv[2] ?? ".");
const ledgerPath = resolve(packageRoot, "mutations-eventing.json");
const only = process.argv[3] ?? null;
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));

function runSuite(suite) {
  try {
    const out = execFileSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        suite,
        "--no-file-parallelism",
        "--testTimeout=120000",
        "--hookTimeout=300000",
        "--reporter=json",
        "--outputFile=/tmp/pl-t5evt-sweep.json",
      ],
      { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 900_000 },
    );
    void out;
  } catch {
    // A red suite exits non-zero; the JSON report is still written.
  }
  let report;
  try {
    report = JSON.parse(readFileSync("/tmp/pl-t5evt-sweep.json", "utf8"));
  } catch {
    return { executed: 0, failed: 0, names: [] };
  }
  const results = (report.testResults ?? []).flatMap((file) => file.assertionResults ?? []);
  const executed = results.filter((assertion) => assertion.status !== "pending").length;
  const failed = results.filter((assertion) => assertion.status === "failed");
  return { executed, failed: failed.length, names: failed.map((a) => a.fullName ?? a.title) };
}

// --- 1. the baseline -------------------------------------------------------
const suites = [...new Set(ledger.mutations.flatMap((m) => m.suites))].sort();
const baseline = {};
for (const suite of suites) {
  const result = runSuite(suite);
  baseline[suite] = result;
  const verdict = result.failed === 0 && result.executed > 0 ? "GREEN" : "NOT-GREEN";
  process.stdout.write(`baseline ${suite}: ${result.executed} case(s), ${result.failed} failed -> ${verdict}\n`);
  if (verdict !== "GREEN") {
    process.stdout.write("REFUSING TO SWEEP: the baseline is not green with a non-zero case count\n");
    process.exit(1);
  }
}

// --- 2. the sweep ----------------------------------------------------------
const outcomes = [];
for (const mutation of ledger.mutations) {
  if (only !== null && !mutation.name.startsWith(only)) continue;
  const file = resolve(packageRoot, mutation.file);
  const original = readFileSync(file, "utf8");
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) {
    outcomes.push({ name: mutation.name, verdict: "UNAPPLIED", detail: `${occurrences} match(es)` });
    process.stdout.write(`${mutation.name}: UNAPPLIED (${occurrences} matches)\n`);
    continue;
  }
  writeFileSync(file, original.replace(mutation.from, mutation.to));
  let verdict = "SURVIVED";
  let kills = [];
  let executedCases = 0;
  try {
    for (const suite of mutation.suites) {
      const result = runSuite(suite);
      executedCases += result.executed;
      if (result.executed === 0) {
        verdict = "VACUOUS";
        kills = [];
        break;
      }
      if (result.failed > 0) {
        verdict = "KILLED";
        kills = result.names;
        break;
      }
    }
  } finally {
    writeFileSync(file, original);
    if (readFileSync(file, "utf8") !== original) throw new Error(`restore failed: ${mutation.file}`);
  }
  outcomes.push({ name: mutation.name, verdict, kills, executedCases });
  process.stdout.write(`${mutation.name}: ${verdict} (${executedCases} case(s))\n`);
  for (const kill of kills) process.stdout.write(`    killed by: ${kill}\n`);
}

writeFileSync("/tmp/pl-t5evt-outcomes.json", `${JSON.stringify(outcomes, null, 1)}\n`);
const tally = outcomes.reduce((acc, o) => ({ ...acc, [o.verdict]: (acc[o.verdict] ?? 0) + 1 }), {});
process.stdout.write(`\nTALLY ${JSON.stringify(tally)} over ${outcomes.length} entries\n`);
