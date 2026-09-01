#!/usr/bin/env node
// ADR M0.3 §5.2 — the sole-writer lint.
//
// §1's cutting rule is that every canonical row has exactly ONE context
// permitted to write it. `scripts/arch/table-ownership.mjs` states that as data.
// This turns it into a gate, so the ownership map is "a non-regressable gate,
// independent of context count" rather than a table nobody re-reads.
//
// The check has two halves, and they are honestly different in maturity today:
//
//   MAP INTEGRITY — the map must cover the live canonical schema exactly: every
//   model owned, no owner invented, no phantom row, every owner a real context
//   directory. This runs against the real 93-model schema and is live NOW. It is
//   what discharges WIN-256's "current schema maps to explicit owners".
//
//   WRITE ENFORCEMENT — a file under packages/(contexts|adapters)/<X> may not
//   call a mutating Prisma delegate for a model whose owner is not <X>. Reads
//   (findMany/findUnique/count/aggregate) are exempt by design: §1 restricts
//   WRITES. No V1 package imports Prisma yet, so this half currently finds
//   nothing to judge. It is proven by fixtures, and it goes live with WIN-258
//   when repositories arrive. This is stated plainly rather than reported as a
//   pass: a gate with nothing to check has not checked anything.
//
//   node scripts/arch/sole-writer.mjs          # check, exit 1 on violation
//   node scripts/arch/sole-writer.mjs --json   # machine-readable

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import {
  BLANKET_OWNER,
  CANONICAL_SCHEMA,
  MUTATING_DELEGATE_METHODS,
  OWNER,
  UNOWNED_ADR_ROWS,
  delegateName,
} from "./table-ownership.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export const SCAN_ROOTS = ["packages/contexts", "packages/adapters"];

/** The pseudo-owner in the map that resolves to an adapter, not a context. */
const OUTBOX_OWNER = "<kernel-outbox-adapter>";
const OUTBOX_DIRECTORY = "packages/adapters/outbox";

/** Repo-relative directory that owns writes for `owner`. */
export function ownerDirectory(owner) {
  return owner === OUTBOX_OWNER ? OUTBOX_DIRECTORY : `packages/contexts/${owner}`;
}

/** Read the model names declared in the canonical schema. */
export function readSchemaModels(root = repositoryRoot) {
  const text = readFileSync(join(root, CANONICAL_SCHEMA), "utf8");
  return [...text.matchAll(/^model\s+([A-Za-z0-9_]+)\s*\{/gmu)].map((match) => match[1]).sort();
}

/** Half one: the map must describe the live schema exactly. */
export function checkMapIntegrity(root = repositoryRoot) {
  const problems = [];
  const schemaModels = readSchemaModels(root);
  const schemaSet = new Set(schemaModels);
  const mapped = Object.keys(OWNER);

  for (const model of schemaModels) {
    if (!(model in OWNER)) {
      problems.push(
        `UNOWNED ${model} is a canonical row with no owner; add it to OWNER in scripts/arch/table-ownership.mjs`,
      );
    }
  }
  for (const model of mapped) {
    if (!schemaSet.has(model)) {
      problems.push(`PHANTOM ${model} has an owner but is not in ${CANONICAL_SCHEMA}`);
    }
  }
  for (const model of Object.keys(UNOWNED_ADR_ROWS)) {
    if (schemaSet.has(model)) {
      problems.push(
        `RESOLVED ${model} is recorded as absent from the canonical schema but is now present; give it an owner and drop the UNOWNED_ADR_ROWS entry`,
      );
    }
    if (model in OWNER) {
      problems.push(`CONFLICT ${model} is both owned and recorded as unowned`);
    }
  }
  for (const [model, owner] of Object.entries(OWNER)) {
    const directory = join(root, ownerDirectory(owner));
    if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
      problems.push(`NODIR   ${model} is owned by ${owner}, but ${ownerDirectory(owner)} does not exist`);
    }
  }
  const delegates = new Map();
  for (const model of mapped) {
    const delegate = delegateName(model);
    if (delegates.has(delegate)) {
      problems.push(`COLLIDE ${model} and ${delegates.get(delegate)} share the Prisma delegate name "${delegate}"`);
    }
    delegates.set(delegate, model);
  }
  return { schemaModelCount: schemaModels.length, mappedModelCount: mapped.length, problems };
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", ".turbo", "generated", "coverage"]);

function listSourceFiles(root, scanRoots) {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) walk(child);
      } else if (entry.isFile() && !entry.name.endsWith(".d.ts")) {
        const dot = entry.name.lastIndexOf(".");
        if (dot >= 0 && SOURCE_EXTENSIONS.has(entry.name.slice(dot))) found.push(child);
      }
    }
  };
  for (const scanRoot of scanRoots) {
    const absolute = join(root, scanRoot);
    if (statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) walk(absolute);
  }
  return found.sort();
}

/** The `packages/contexts/<x>` or `packages/adapters/<x>` a file belongs to. */
export function owningPackage(virtualPath) {
  const match = /^(packages\/(?:contexts|adapters)\/[^/]+)\//u.exec(virtualPath);
  return match ? match[1] : null;
}

/**
 * Find every mutating delegate call. Matched on the AST, so a delegate name in a
 * string, a comment or a type position is not a write.
 */
export function findWrites(virtualPath, text) {
  const sourceFile = ts.createSourceFile(virtualPath, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const mutators = new Set(MUTATING_DELEGATE_METHODS);
  const writes = [];

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      mutators.has(node.expression.name.text) &&
      ts.isPropertyAccessExpression(node.expression.expression)
    ) {
      const delegate = node.expression.expression.name.text;
      for (const [model] of Object.entries(OWNER)) {
        if (delegateName(model) === delegate) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          writes.push({ path: virtualPath, line: line + 1, model, method: node.expression.name.text });
          break;
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return writes;
}

/** Half two: no package writes a row it does not own. */
export function checkWriteEnforcement(root = repositoryRoot, scanRoots = SCAN_ROOTS) {
  const files = listSourceFiles(root, scanRoots);
  const violations = [];
  let writeCount = 0;

  for (const absolute of files) {
    const virtualPath = relative(root, absolute).split("\\").join("/");
    for (const write of findWrites(virtualPath, readFileSync(absolute, "utf8"))) {
      writeCount += 1;
      const actual = owningPackage(virtualPath);
      const expected = ownerDirectory(OWNER[write.model]);
      if (actual !== expected) {
        violations.push({
          ...write,
          expected,
          actual,
          message: `${write.model}.${write.method}() may be called only from ${expected}; ${OWNER[write.model]} is its sole writer`,
        });
      }
    }
  }
  return { fileCount: files.length, writeCount, violations };
}

export function check(root = repositoryRoot) {
  const integrity = checkMapIntegrity(root);
  const enforcement = checkWriteEnforcement(root);
  return { integrity, enforcement };
}

function main() {
  const result = check();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.integrity.problems.length || result.enforcement.violations.length ? 1 : 0;
    return;
  }

  const { integrity, enforcement } = result;
  process.stdout.write(
    `sole-writer: ${integrity.mappedModelCount} owned model(s) against ${integrity.schemaModelCount} in ${CANONICAL_SCHEMA}; ` +
      `scanned ${enforcement.fileCount} source file(s) under ${SCAN_ROOTS.join(", ")}\n`,
  );

  for (const problem of integrity.problems) process.stdout.write(`${problem}\n`);
  for (const violation of enforcement.violations) {
    process.stdout.write(`FAIL ${violation.path}:${violation.line} — ${violation.message}\n`);
  }

  const failed = integrity.problems.length + enforcement.violations.length;
  if (failed === 0) {
    process.stdout.write(
      `ok: every canonical row has exactly one owning context, and no package writes a row it does not own.\n`,
    );
    if (enforcement.writeCount === 0) {
      process.stdout.write(
        `note: write enforcement judged 0 delegate call(s) — no V1 package imports the ORM yet. ` +
          `Map integrity above is live; enforcement goes live with WIN-258. ` +
          `${BLANKET_OWNER.schema} is owned wholesale by ${BLANKET_OWNER.owner} (${BLANKET_OWNER.reason}).\n`,
      );
    }
  } else {
    process.stdout.write(`\n${failed} sole-writer problem(s).\n`);
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("sole-writer.mjs")) main();
