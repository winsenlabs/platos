// The WIN-258 T5 `files` mutation driver.
//
// Data in: /tmp/pl-t5files-entries.json (the ledger's `mutations` array).
// Report out: /tmp/pl-t5files-report.json
//
// PROVES THE SUITES GREEN FIRST. Every distinct suite SET is run UNMUTATED and
// must exit zero with a NON-ZERO executed case count before any mutation is
// applied. A run with no executed cases is classified VACUOUS rather than as a
// kill — that is the failure tranche 1's first sweep hit, where a cleaned dist
// made every suite fail to LOAD and 22 mutations "died" against a tree that
// would have died against nothing at all.
//
// EVERY `from` MUST OCCUR EXACTLY ONCE in its file. The driver refuses an entry
// whose anchor matches zero times or more than once, so a sweep that silently
// mutated the wrong statement is impossible.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = "/tmp/pl-t5files/packages/adapters/postgres-tenancy";
const ENTRIES = JSON.parse(readFileSync("/tmp/pl-t5files-entries.json", "utf8"));
const REPORT = "/tmp/pl-t5files-report.json";

const env = {
  ...process.env,
  DOCKER_HOST: "unix:///Users/tejassuds/.colima/default/docker.sock",
  TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE: "/var/run/docker.sock",
};

function runSuites(suites) {
  const args = [
    "exec",
    "vitest",
    "run",
    ...suites,
    "--no-file-parallelism",
    "--testTimeout=180000",
    "--hookTimeout=600000",
  ];
  let output = "";
  let code = 0;
  try {
    output = execFileSync("pnpm", args, { cwd: ROOT, env, encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    code = error.status ?? 1;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  // `Tests  3 failed | 42 passed (45)` or `Tests  95 passed (95)`.
  const line = /Tests\s+.*\((\d+)\)/u.exec(output);
  const executed = line ? Number(line[1]) : 0;
  return { code, executed, tail: output.split("\n").slice(-12).join("\n") };
}

const baselines = new Map();
for (const entry of ENTRIES) {
  const key = entry.suites.join(" ");
  if (baselines.has(key)) continue;
  process.stdout.write(`baseline ${key} ... `);
  const result = runSuites(entry.suites);
  baselines.set(key, result);
  process.stdout.write(`exit=${result.code} executed=${result.executed}\n`);
  if (result.code !== 0 || result.executed === 0) {
    process.stdout.write(result.tail + "\n");
    writeFileSync(REPORT, JSON.stringify({ error: "baseline not green", key, result }, null, 2));
    process.exit(1);
  }
}

const results = [];
for (const [index, entry] of ENTRIES.entries()) {
  const path = resolve(ROOT, entry.file);
  const original = readFileSync(path, "utf8");
  const occurrences = original.split(entry.from).length - 1;
  if (occurrences !== 1) {
    results.push({ ...entry, verdict: "UNAPPLIED", occurrences, executedCases: 0 });
    process.stdout.write(`${index + 1}/${ENTRIES.length} ${entry.name} -> UNAPPLIED (${occurrences})\n`);
    continue;
  }
  writeFileSync(path, original.replace(entry.from, entry.to));
  let outcome;
  try {
    const run = runSuites(entry.suites);
    if (run.executed === 0) outcome = { verdict: "VACUOUS", executedCases: 0 };
    else if (run.code !== 0) outcome = { verdict: "KILLED", executedCases: run.executed };
    else outcome = { verdict: "SURVIVED", executedCases: run.executed };
  } finally {
    writeFileSync(path, original);
  }
  results.push({ ...entry, ...outcome });
  process.stdout.write(
    `${index + 1}/${ENTRIES.length} ${entry.name} -> ${outcome.verdict} (${outcome.executedCases})\n`,
  );
}

const tally = results.reduce((counts, row) => {
  counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;
  return counts;
}, {});
writeFileSync(
  REPORT,
  JSON.stringify(
    { tally, baselines: [...baselines].map(([key, value]) => ({ key, ...value, tail: undefined })), results },
    null,
    2,
  ),
);
process.stdout.write(`\n${JSON.stringify(tally)}\n`);
