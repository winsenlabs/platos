#!/usr/bin/env node
// WIN-293 (clause 2) — explicit enumeration of every operator-protected agent
// operation. Derived from the committed control-plane manifest (the census of
// record), grouped by controller, so "the route manifest reflects true operator
// protection" is auditable at a glance. The count is cross-checked from a second
// mechanism by scripts/rest-census-independent.mjs (manifest operator >= the
// independent requireOperator floor), so this list cannot silently under-report.
//
// Usage:
//   node scripts/operator-operations.mjs           # regenerate the artifact
//   node scripts/operator-operations.mjs --check     # fail if stale
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "apps/agent/src/control-plane/operation-manifest.generated.json");
const OUT = join(ROOT, "docs/audits/M0.8-operator-operations.md");

function build() {
  const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const byController = new Map();
  let total = 0;
  for (const op of m.inventories.restOperations) {
    for (const impl of op.implementations || []) {
      if (!impl.requiresOperator) continue;
      total += 1;
      const c = impl.controller || "(unknown)";
      if (!byController.has(c)) byController.set(c, []);
      byController.get(c).push(`${op.method} ${op.path} — ${impl.handler}`);
    }
  }
  const lines = [];
  lines.push("# WIN-293 — operator-protected operation enumeration (M0.8 clause 2)");
  lines.push("");
  lines.push(
    "Generated from `apps/agent/src/control-plane/operation-manifest.generated.json` by " +
      "`scripts/operator-operations.mjs`. Every operation below asserts an operator " +
      "(control-plane) credential before it runs. The total is cross-checked against a " +
      "second, independent mechanism (`scripts/rest-census-independent.mjs`), which fails " +
      "CI if the manifest operator count ever drops below the source `requireOperator` floor."
  );
  lines.push("");
  lines.push(`**Total operator-protected operations: ${total}**`);
  lines.push("");
  for (const c of [...byController.keys()].sort()) {
    const ops = byController.get(c).sort();
    lines.push(`## ${c} (${ops.length})`);
    lines.push("");
    for (const o of ops) lines.push(`- ${o}`);
    lines.push("");
  }
  return { text: lines.join("\n") + "\n", total };
}

function main() {
  const check = process.argv.includes("--check");
  const { text, total } = build();
  if (check) {
    let committed;
    try {
      committed = readFileSync(OUT, "utf8");
    } catch {
      committed = null;
    }
    if (committed !== text) {
      console.error(
        "operator-operations: OUT OF DATE — run `node scripts/operator-operations.mjs` and commit."
      );
      process.exit(1);
    }
    console.error(`operator-operations: current. ${total} operator-protected operations.`);
    return;
  }
  writeFileSync(OUT, text);
  console.error(`operator-operations: wrote ${OUT} — ${total} operator-protected operations.`);
}

main();
