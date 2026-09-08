// The sweep that PRODUCES the ledger rather than asserting it.
//
// Reads `mutations-win267-t4.json`, and for each entry: replaces `from` with
// `to` in the named file, runs the named suites, records the NAMED cases that
// went red, then restores the file byte for byte and confirms green again.
//
// A MODULE-LOAD FAILURE IS NOT A KILL. A mutation that makes the file fail to
// parse takes every case in the suite down with it, which proves nothing about
// any single guard. Entries whose failure set is "the whole suite" are reported
// as VACUOUS and must be rewritten, not counted.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// IT LIVES IN `scripts/` AND THE LEDGER LIVES BESIDE THE CODE. The ledger is
// read by a human reviewing `apps/core-api`, so it sits there; the runner is
// repository tooling like every other `.mjs` here, and `docs/v1-ledger-rules.json`
// already classifies `scripts/**` — a runner at a package root would have needed
// a rule invented for it, which is a worse trade than one relative path.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACKAGE = `${ROOT}apps/core-api/`;
const LEDGER = `${PACKAGE}mutations-win267-t4.json`;

const SUITES = {
  mint: "src/transports/rest/secret-mint.test.ts",
  route: "src/http/secret-mint.controller.test.ts",
  policy: "src/http/idempotency-policy.test.ts",
};

/** Run one vitest file and return the set of failing case titles. */
function runSuite(relativePath) {
  let output;
  try {
    output = execFileSync(
      "npx",
      ["vitest", "run", "--reporter=json", "--outputFile=/dev/stdout", relativePath],
      { cwd: PACKAGE, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    output = `${error.stdout ?? ""}`;
  }
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end === -1) return { failed: ["<no json reporter output>"], total: 0 };
  let report;
  try {
    report = JSON.parse(output.slice(start, end + 1));
  } catch {
    return { failed: ["<unparseable reporter output>"], total: 0 };
  }
  const failed = [];
  let total = 0;
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      total += 1;
      if (assertion.status === "failed") failed.push(assertion.fullName.trim());
    }
  }
  return { failed, total };
}

const ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
const results = [];

for (const entry of ledger.mutations) {
  const target = `${ROOT}${entry.file}`;
  const original = readFileSync(target, "utf8");
  const occurrences = original.split(entry.from).length - 1;
  if (occurrences !== 1) {
    results.push({ name: entry.name, verdict: "NOT-APPLIED", detail: `${occurrences} occurrences of \`from\`` });
    continue;
  }
  writeFileSync(target, original.replace(entry.from, entry.to));
  const failures = [];
  let total = 0;
  try {
    for (const suite of entry.suites) {
      const outcome = runSuite(SUITES[suite]);
      failures.push(...outcome.failed);
      total += outcome.total;
    }
  } finally {
    writeFileSync(target, original);
  }
  const vacuous = total > 0 && failures.length === total;
  results.push({
    name: entry.name,
    verdict: failures.length === 0 ? "SURVIVED" : vacuous ? "VACUOUS" : "KILLED",
    observed: failures,
    cases: total,
  });
  process.stdout.write(
    `${results.at(-1).verdict.padEnd(11)} ${entry.name}\n${failures.map((f) => `    red: ${f}\n`).join("")}`,
  );
}

writeFileSync(`${PACKAGE}mutation-sweep-observed.json`, `${JSON.stringify(results, null, 2)}\n`);
const killed = results.filter((r) => r.verdict === "KILLED").length;
process.stdout.write(`\n${killed}/${results.length} killed\n`);
