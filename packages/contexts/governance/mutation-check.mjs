#!/usr/bin/env node
// Falsifiability harness — NOT part of the shipped package.
//
// For every guard in this context it deletes or neutralises the guard, runs the
// suites that are supposed to notice, records which named cases went red, and
// puts the file back. A guard nothing can turn red is a guard that is not there.
//
// Run from the package root:  node mutation-check.mjs [--only <substring>]

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const MUTATIONS = JSON.parse(readFileSync(new URL("./mutations.json", import.meta.url), "utf8"));
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;

function runSuites(suites) {
  try {
    execFileSync("pnpm", ["exec", "vitest", "run", ...suites, "--reporter=json", "--outputFile=/tmp/gov-mut.json"], {
      stdio: "pipe",
    });
  } catch {
    // A failing run is the expected outcome under a mutation.
  }
  const report = JSON.parse(readFileSync("/tmp/gov-mut.json", "utf8"));
  const failed = [];
  for (const suite of report.testResults ?? []) {
    for (const assertion of suite.assertionResults ?? []) {
      if (assertion.status === "failed") failed.push(assertion.fullName ?? assertion.title);
    }
  }
  return failed;
}

let broken = 0;
const rows = [];
for (const mutation of MUTATIONS) {
  if (only !== null && !mutation.name.includes(only)) continue;
  const path = mutation.file;
  const original = readFileSync(path, "utf8");
  if (!original.includes(mutation.from)) {
    console.log(`SKIP  ${mutation.name}: anchor not found in ${path}`);
    broken += 1;
    continue;
  }
  writeFileSync(path, original.replace(mutation.from, mutation.to));
  let failed;
  try {
    failed = runSuites(mutation.suites);
  } finally {
    writeFileSync(path, original);
  }
  if (failed.length === 0) {
    console.log(`UNFALSIFIABLE  ${mutation.name}  (nothing went red)`);
    broken += 1;
  } else {
    console.log(`OK  ${mutation.name}  ->  ${failed.length} red:`);
    for (const name of failed.slice(0, 3)) console.log(`      ${name}`);
    rows.push({ name: mutation.name, count: failed.length, first: failed[0] });
  }
}

console.log(`\n${rows.length} falsifiable, ${broken} not.`);
process.exit(broken === 0 ? 0 : 1);
