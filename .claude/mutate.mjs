// Ad-hoc mutation driver for the governance ledger. Scratch tooling: it is run
// from the worktree and its OUTPUT (the `kills` arrays) is what gets committed.
//
// It refuses to score an entry unless the suite set was GREEN, with a non-zero
// executed case count, before the mutation was applied — tranche 1's first sweep
// reported 22 kills and every one was a module-load failure.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const PKG = resolve(ROOT, "packages/adapters/postgres-tenancy");
const LEDGER = resolve(PKG, "mutations-governance.json");
const only = process.argv[2] ?? null;

function runSuites(suites) {
  const args = [
    "--filter",
    "@platos/adapter-postgres-tenancy",
    "exec",
    "vitest",
    "run",
    ...suites,
    "--no-file-parallelism",
    "--testTimeout=120000",
    "--hookTimeout=600000",
    "--reporter=json",
    "--outputFile=/tmp/mut-report.json",
  ];
  let failed = false;
  try {
    execFileSync("pnpm", args, { cwd: ROOT, stdio: "pipe", env: process.env });
  } catch {
    failed = true;
  }
  let report;
  try {
    report = JSON.parse(readFileSync("/tmp/mut-report.json", "utf8"));
  } catch {
    return { executed: 0, failedNames: [], loadFailure: true, failed };
  }
  const results = report.testResults ?? [];
  const assertions = results.flatMap((file) => file.assertionResults ?? []);
  const executed = assertions.filter((a) => a.status !== "pending" && a.status !== "skipped").length;
  const failedNames = assertions.filter((a) => a.status === "failed").map((a) => a.fullName);
  const loadFailure = results.some(
    (file) => (file.assertionResults ?? []).length === 0 && file.status === "failed",
  );
  return { executed, failedNames, loadFailure, failed };
}

const ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
const bySuiteSet = new Map();
for (const entry of ledger.mutations) {
  const key = entry.suites.join(" ");
  if (!bySuiteSet.has(key)) bySuiteSet.set(key, []);
  bySuiteSet.get(key).push(entry);
}

const baseline = new Map();
for (const key of bySuiteSet.keys()) {
  const suites = key.split(" ");
  const result = runSuites(suites);
  baseline.set(key, result);
  console.log(
    `BASELINE ${key} -> executed=${result.executed} failed=${result.failedNames.length} load=${result.loadFailure}`,
  );
}

const outcomes = [];
for (const entry of ledger.mutations) {
  if (only !== null && !entry.name.startsWith(only)) continue;
  const key = entry.suites.join(" ");
  const base = baseline.get(key);
  if (base.failedNames.length > 0 || base.executed === 0) {
    outcomes.push({ name: entry.name, verdict: "VACUOUS-BASELINE", kills: [] });
    console.log(`${entry.name}: VACUOUS (baseline not green)`);
    continue;
  }
  const file = resolve(PKG, entry.file);
  const original = readFileSync(file, "utf8");
  const occurrences = original.split(entry.from).length - 1;
  if (occurrences !== 1) {
    outcomes.push({ name: entry.name, verdict: `BAD-ANCHOR(${occurrences})`, kills: [] });
    console.log(`${entry.name}: BAD ANCHOR (${occurrences} occurrences)`);
    continue;
  }
  writeFileSync(file, original.replace(entry.from, entry.to));
  const result = runSuites(entry.suites);
  writeFileSync(file, original);

  let verdict;
  if (result.loadFailure || result.executed === 0) verdict = "VACUOUS";
  else if (result.failedNames.length > 0) verdict = "KILLED";
  else verdict = "SURVIVED";
  outcomes.push({ name: entry.name, verdict, kills: result.failedNames });
  console.log(
    `${entry.name}: ${verdict} (${result.failedNames.length} case(s), executed ${result.executed})`,
  );
  for (const one of result.failedNames.slice(0, 3)) console.log(`    - ${one}`);
}

writeFileSync("/tmp/mut-outcomes.json", JSON.stringify(outcomes, null, 2));
console.log(`\nwrote /tmp/mut-outcomes.json (${outcomes.length} entries)`);
