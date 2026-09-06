#!/usr/bin/env node
// WIN-260 (M2.5) — the canonical error taxonomy, and the gate that keeps it true.
//
// M0.4 §2 fixes the REST failure envelope as
// `{ error: { code, title, body, errorId, traceRef, version, fields?,
// retryAfterSec? } }` with `code` a SCREAMING_SNAKE string that is immutable
// within a major, and the kernel's `vo/error.ts` says outright that "the code ->
// HTTP-status / RPC-code mapping tables belong to WIN-260". Until now no such
// table existed: a code was minted in a context's `domain/errors.ts`, carried an
// `ErrorCategory`, and nothing anywhere said what a transport should answer with.
//
// WHY THE TABLE IS DATA AND NOT A DERIVATION. A status computed from the
// category alone cannot be got wrong, and a gate that checks a computation
// against the same computation cannot fail — it is the vacuity that WIN-258 T7
// found in its own projection test, where a mutation shrank both sides of an
// assertion and stayed green. So `docs/error-taxonomy.json` is an EXPLICIT list
// of every code, and this gate JOINS it to three things it does not control:
//
//   the SOURCE TREE — 17 contexts' `domain/errors.ts` and every other file that
//     calls `domainError`, which four other dimensions are editing right now;
//   the RUNTIME MODULE — `apps/core-api/src/transports/error-status.ts`, which
//     is what a transport will actually execute;
//   the KERNEL — `packages/kernel/src/vo/error.ts`, whose `ErrorCategory` union
//     the runtime module's category table must cover exactly.
//
// A code added to any context without an entry here fails E1. An entry whose
// code no longer exists fails E2. A category changed at the mint site fails E3.
// A status the runtime module would not actually produce fails E4. None of the
// four can be satisfied by editing one file.
//
// THE SECOND HALF IS DISTINCTNESS, AND IT IS THE REASON THIS ISSUE EXISTS.
// "Two guards returning the same error code cannot be told apart" is the defect
// that hid in `privacy`, in `identity-access` and — found by this scan, on the
// branch that wrote it — in `jobs`' own `decideReplay`, where FOUR facts left
// through one `IDEMPOTENCY_CONFLICT`. Most repeated raises are correct: an
// `admitBudget` that refuses six different fields under `COST_BUDGET_INVALID`
// distinguishes them by the `FieldViolation` it attaches. The ones that are not
// correct are the raises that are IDENTICAL — same code, same arguments, in the
// same function — because nothing at runtime tells them apart. Some of THOSE are
// deliberate too: `identity-access` returns one `INVALID_MFA_CODE` for every way
// a second factor can fail, precisely so a caller cannot learn which guess got
// closer. So the rule is not "never repeat"; it is "every identical repeat is
// registered, with the reason it must be uniform" (E6), and a registration that
// no longer matches any code is itself a failure (E7).
//
//   node scripts/error-taxonomy.mjs --check   # gate, exit 1 on violation
//   node scripts/error-taxonomy.mjs --write   # seed new codes with status null
//   node scripts/error-taxonomy.mjs --json    # machine-readable
//
// `--write` deliberately seeds a new code with `"status": null` rather than the
// category default. A generator that invented the status would make E9 — "an
// error code with no mapping is refused" — unfalsifiable by construction, since
// no code could ever lack one. Choosing the status is a decision a person makes.

import { readFileSync, writeFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export const TAXONOMY_PATH = "docs/error-taxonomy.json";
export const RUNTIME_PATH = "apps/core-api/src/transports/error-status.ts";
export const KERNEL_ERROR_PATH = "packages/kernel/src/vo/error.ts";
/**
 * Where a canonical code may be minted.
 *
 * IT WAS `packages/contexts` ALONE, AND THAT WAS A HOLE. The banner above calls
 * this "the canonical failure taxonomy: every SCREAMING_SNAKE code any of the 17
 * bounded contexts mints" — true, and narrower than the claim the gate is
 * relied on for. A code minted anywhere else was invisible: E1 never asked for a
 * taxonomy entry, E4 never checked its status, and E6 never noticed two guards
 * refusing identically. WIN-260's errors-and-idempotency dimension walked
 * straight into it, because M0.4 §2's `Idempotency-Key` refusals belong to the
 * TRANSPORT — no context knows a header exists — and would have been minted
 * outside the scan.
 *
 * So the roots are now every V1-owned source root, the same five
 * `scripts/arch/arch-boundaries.mjs` and `scripts/arch/env-access.mjs` walk.
 * Widening them found four uniform guards nobody had registered, in
 * `postgres-tenancy` and `redis-cache`, which is the evidence the widening was
 * not cosmetic.
 */
export const SOURCE_ROOTS = [
  "packages/kernel/src",
  "packages/contexts",
  "packages/adapters",
  "apps/core-api/src",
  "apps/mcp-stdio/src",
];

/**
 * The statuses a category may resolve to.
 *
 * A category has a FLOOR — the status a code of that category gets when nothing
 * says otherwise — and a small set of refinements a specific code may claim. The
 * set is closed so that an override cannot quietly answer 200 for a `forbidden`,
 * and it is wider than one entry because the live surface really does answer 422
 * for some `invalid_input` and 504 for one `unavailable`.
 */
export const CATEGORY_STATUSES = Object.freeze({
  invalid_input: [400, 413, 422],
  unauthenticated: [401],
  forbidden: [403, 404],
  not_found: [404, 410],
  conflict: [409],
  precondition_failed: [409, 412, 422, 428],
  rate_limited: [429],
  unavailable: [503, 504],
  internal: [500, 501],
});

export const RULES = Object.freeze([
  { id: "E1", description: "every minted code has a taxonomy entry" },
  { id: "E2", description: "every taxonomy entry names a code that is minted" },
  { id: "E3", description: "the taxonomy category matches the category at the mint site" },
  { id: "E4", description: "the taxonomy status matches what the runtime module resolves" },
  { id: "E5", description: "the runtime category table covers the kernel ErrorCategory union exactly" },
  { id: "E6", description: "every identical repeated raise is registered as deliberately uniform" },
  { id: "E7", description: "every registered uniform guard still exists in the source" },
  { id: "E8", description: "every status override names a code that is minted" },
  { id: "E9", description: "every taxonomy entry carries a status, and one its category permits" },
  { id: "E10", description: "the taxonomy records the contexts that mint each code" },
]);

// ---------------------------------------------------------------------------
// Reading the source tree
// ---------------------------------------------------------------------------

function listSourceFiles(root) {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(absolute);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const path = relative(root, absolute).split("\\").join("/");
      // A test and a hand-written double both mint codes that no transport will
      // ever answer with: `tools`' in-memory peer raises `UNAUTHENTICATED` to
      // stand in for a context it does not import. Holding those to the taxonomy
      // would register codes nothing serves.
      if (path.includes(".test.") || path.includes("/testing/")) continue;
      found.push(path);
    }
  };
  for (const sourceRoot of SOURCE_ROOTS) walk(join(root, sourceRoot));
  return found.sort();
}

/**
 * Who a mint site belongs to, for the `contexts` field E10 reconciles.
 *
 * A context is named by its directory. Everything else is named by the LAYER
 * that owns it — `kernel`, `adapters` or a deployable — because that is the
 * honest answer: a code minted in `apps/core-api/src/http` belongs to the
 * transport edge and to no bounded context, and calling it "unknown" would put a
 * word in the taxonomy that names nothing an operator could look up.
 */
function contextOf(path) {
  const context = /^packages\/contexts\/([^/]+)\//u.exec(path);
  if (context !== null) return context[1];
  if (path.startsWith("packages/kernel/")) return "kernel";
  if (path.startsWith("packages/adapters/")) return "adapters";
  const app = /^apps\/([^/]+)\//u.exec(path);
  if (app !== null) return app[1];
  return "unknown";
}

/** The literal first two arguments of a `domainError(...)` call, or null. */
function readDomainErrorCall(node, source) {
  if (!ts.isCallExpression(node)) return null;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "domainError") return null;
  const [codeNode, categoryNode] = node.arguments;
  if (codeNode === undefined || !ts.isStringLiteral(codeNode)) return null;
  const category =
    categoryNode !== undefined && ts.isStringLiteral(categoryNode) ? categoryNode.text : null;
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { code: codeNode.text, category, line: line + 1 };
}

/**
 * Every code minted in the tree, and every function that raises one twice
 * identically.
 *
 * The two halves share one walk because they share one fact: which named
 * functions are error CONSTRUCTORS. A constructor is a function whose body
 * returns a `domainError` with a literal code, and a RAISE is a call to one of
 * those by name. Repeated raises are grouped per enclosing function, because
 * "two guards" means two guards in the same decision, not the same fact reported
 * from two different use cases.
 */
export function scanSource(root = repositoryRoot) {
  const files = listSourceFiles(root);
  const parsed = new Map();
  for (const path of files) {
    const text = readFileSync(join(root, path), "utf8");
    parsed.set(path, ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true));
  }

  const codes = new Map();
  const constructors = new Map();
  for (const [path, source] of parsed) {
    const visit = (node) => {
      const call = readDomainErrorCall(node, source);
      if (call !== null) {
        const existing = codes.get(call.code);
        const record = existing ?? { code: call.code, categories: new Set(), contexts: new Set(), sites: [] };
        if (call.category !== null) record.categories.add(call.category);
        record.contexts.add(contextOf(path));
        record.sites.push(`${path}:${call.line}`);
        codes.set(call.code, record);
      }
      if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
        let minted = null;
        const inner = (child) => {
          if (minted !== null) return;
          const found = readDomainErrorCall(child, source);
          if (found !== null) {
            minted = found.code;
            return;
          }
          ts.forEachChild(child, inner);
        };
        ts.forEachChild(node.body, inner);
        if (minted !== null) constructors.set(node.name.text, minted);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const uniform = [];
  for (const [path, source] of parsed) {
    const scanFunction = (name, body) => {
      const raises = new Map();
      const visit = (node) => {
        if (
          ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node)
        ) {
          return;
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const code = constructors.get(node.expression.text);
          if (code !== undefined) {
            const shape = node.arguments.map((argument) => argument.getText(source).replace(/\s+/gu, " ")).join(", ");
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
            const key = `${code}\u0000${shape}`;
            if (!raises.has(key)) raises.set(key, { code, shape, lines: [] });
            raises.get(key).lines.push(line + 1);
          }
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(body, visit);
      // Aggregated per (file, function, code) rather than per argument shape.
      // `decideEnvironmentAccess` raises TENANCY_ENVIRONMENT_FORBIDDEN under two
      // different gate names, three times and twice; keying on the argument text
      // would make the registry a pin on how an expression is SPELLED, which a
      // rename would break without changing a single guard. `shapes` keeps the
      // fact that there were two groups, so collapsing them into one still moves
      // a number the registry states.
      const grouped = new Map();
      for (const raise of raises.values()) {
        if (raise.lines.length < 2) continue;
        const previous = grouped.get(raise.code) ?? { sites: 0, shapes: 0 };
        grouped.set(raise.code, { sites: previous.sites + raise.lines.length, shapes: previous.shapes + 1 });
      }
      for (const [code, counts] of grouped) {
        uniform.push({ file: path, function: name, code, sites: counts.sites, shapes: counts.shapes });
      }
    };
    const top = (node) => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
        scanFunction(node.name.text, node.body);
      }
      ts.forEachChild(node, top);
    };
    top(source);
  }

  const inventory = [...codes.values()]
    .map((record) => ({
      code: record.code,
      categories: [...record.categories].sort(),
      contexts: [...record.contexts].sort(),
      sites: record.sites.length,
    }))
    .sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0));

  uniform.sort((left, right) => {
    const key = (entry) => `${entry.file}\u0000${entry.function}\u0000${entry.code}`;
    return key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0;
  });

  return { files, inventory, uniform };
}

// ---------------------------------------------------------------------------
// Reading the runtime module and the kernel
// ---------------------------------------------------------------------------

/** A `Record` literal's string-keyed numeric entries, by declared const name. */
function readNumericRecord(source, name) {
  let found = null;
  const visit = (node) => {
    if (found !== null) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      let initializer = node.initializer;
      // `Object.freeze({...})` and a bare `{...}` are the same declaration for
      // this purpose, and both spellings appear in the tree.
      if (
        initializer !== undefined &&
        ts.isCallExpression(initializer) &&
        initializer.arguments.length === 1
      ) {
        initializer = initializer.arguments[0];
      }
      if (initializer !== undefined && ts.isObjectLiteralExpression(initializer)) {
        const entries = new Map();
        for (const property of initializer.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const key = ts.isIdentifier(property.name)
            ? property.name.text
            : ts.isStringLiteral(property.name)
              ? property.name.text
              : null;
          if (key === null) continue;
          if (!ts.isNumericLiteral(property.initializer)) continue;
          entries.set(key, Number(property.initializer.text));
        }
        found = entries;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function readRuntimeModule(root = repositoryRoot) {
  const path = join(root, RUNTIME_PATH);
  const source = ts.createSourceFile(RUNTIME_PATH, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, true);
  return {
    categoryStatus: readNumericRecord(source, "CATEGORY_STATUS") ?? new Map(),
    statusOverrides: readNumericRecord(source, "STATUS_OVERRIDES") ?? new Map(),
  };
}

/** The `ErrorCategory` union members, read from the kernel's own declaration. */
export function readKernelCategories(root = repositoryRoot) {
  const path = join(root, KERNEL_ERROR_PATH);
  const source = ts.createSourceFile(KERNEL_ERROR_PATH, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, true);
  const members = [];
  const visit = (node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === "ErrorCategory") {
      const collect = (type) => {
        if (ts.isUnionTypeNode(type)) {
          for (const member of type.types) collect(member);
          return;
        }
        if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) members.push(type.literal.text);
      };
      collect(node.type);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return members;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

function loadTaxonomy(root, path = TAXONOMY_PATH) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function uniformKey(entry) {
  return `${entry.file}\u0000${entry.function}\u0000${entry.code}`;
}

export function checkTaxonomy(root = repositoryRoot, taxonomyPath = TAXONOMY_PATH) {
  const problems = [];
  const scan = scanSource(root);
  const runtime = readRuntimeModule(root);
  const kernelCategories = readKernelCategories(root);
  const taxonomy = loadTaxonomy(root, taxonomyPath);

  const entries = new Map(Object.entries(taxonomy.codes ?? {}));
  const minted = new Map(scan.inventory.map((row) => [row.code, row]));

  // E5 first: every other status decision reads the runtime table, so a table
  // that does not cover the kernel's union would make E4 misleading rather than
  // wrong. Compared as SETS in both directions.
  const declared = [...runtime.categoryStatus.keys()].sort();
  const expected = [...kernelCategories].sort();
  if (declared.join("|") !== expected.join("|")) {
    problems.push(
      `E5 ${RUNTIME_PATH} CATEGORY_STATUS covers [${declared.join(", ")}] but ` +
        `${KERNEL_ERROR_PATH} declares ErrorCategory as [${expected.join(", ")}]`,
    );
  }
  for (const [category, status] of runtime.categoryStatus) {
    const permitted = CATEGORY_STATUSES[category];
    if (permitted !== undefined && !permitted.includes(status)) {
      problems.push(
        `E5 ${RUNTIME_PATH} CATEGORY_STATUS.${category} is ${status}, which is not one of ${permitted.join("/")}`,
      );
    }
  }

  const resolveStatus = (code, category) => {
    const override = runtime.statusOverrides.get(code);
    if (override !== undefined) return override;
    return runtime.categoryStatus.get(category);
  };

  for (const row of scan.inventory) {
    const entry = entries.get(row.code);
    if (entry === undefined) {
      problems.push(
        `E1 ${row.code} is minted at ${row.sites} site(s) in ${row.contexts.join("/")} and has no ` +
          `entry in ${taxonomyPath}; run --write and choose its status`,
      );
      continue;
    }
    if (row.categories.length !== 1) {
      problems.push(
        `E3 ${row.code} is minted with more than one category (${row.categories.join(", ")}); ` +
          `a code carries exactly one`,
      );
    } else if (entry.category !== row.categories[0]) {
      problems.push(
        `E3 ${row.code} is ${taxonomyPath} category "${entry.category}" but is minted as ` +
          `"${row.categories[0]}"`,
      );
    }
    if (typeof entry.status !== "number") {
      problems.push(
        `E9 ${row.code} has no status in ${taxonomyPath}; a code a transport cannot answer with is ` +
          `not a code`,
      );
    } else {
      const permitted = CATEGORY_STATUSES[entry.category];
      if (permitted !== undefined && !permitted.includes(entry.status)) {
        problems.push(
          `E9 ${row.code} maps to ${entry.status}, which category "${entry.category}" does not ` +
            `permit (${permitted.join("/")})`,
        );
      }
      const resolved = resolveStatus(row.code, row.categories[0] ?? entry.category);
      if (resolved !== entry.status) {
        problems.push(
          `E4 ${row.code} is ${entry.status} in ${taxonomyPath} but ${RUNTIME_PATH} resolves ` +
            `${resolved === undefined ? "nothing" : resolved}`,
        );
      }
    }
    const recorded = Array.isArray(entry.contexts) ? [...entry.contexts].sort() : [];
    if (recorded.join("|") !== row.contexts.join("|")) {
      problems.push(
        `E10 ${row.code} is recorded against [${recorded.join(", ")}] but is minted in ` +
          `[${row.contexts.join(", ")}]`,
      );
    }
  }

  for (const code of entries.keys()) {
    if (!minted.has(code)) {
      problems.push(`E2 ${taxonomyPath} carries ${code}, which no context mints any more`);
    }
  }

  for (const code of runtime.statusOverrides.keys()) {
    if (!minted.has(code)) {
      problems.push(`E8 ${RUNTIME_PATH} overrides the status of ${code}, which no context mints`);
    }
  }

  const registered = new Map(
    (taxonomy.uniformGuards ?? []).map((entry) => [uniformKey(entry), entry]),
  );
  const live = new Map(scan.uniform.map((entry) => [uniformKey(entry), entry]));

  for (const [key, entry] of live) {
    const allowance = registered.get(key);
    if (allowance === undefined) {
      problems.push(
        `E6 ${entry.file} ${entry.function}() raises ${entry.code} ${entry.sites} times with ` +
          `identical arguments; nothing at runtime tells those guards apart. Mint a distinct code, ` +
          `or register the uniformity in ${taxonomyPath} with the reason it is required`,
      );
      continue;
    }
    if (allowance.sites !== entry.sites || allowance.shapes !== entry.shapes) {
      problems.push(
        `E6 ${entry.file} ${entry.function}() raises ${entry.code} identically ${entry.sites} time(s) ` +
          `in ${entry.shapes} group(s); ${taxonomyPath} registers ${allowance.sites}/${allowance.shapes}`,
      );
    }
    if (typeof allowance.reason !== "string" || allowance.reason.length === 0) {
      problems.push(`E6 the ${entry.code} allowance in ${entry.function}() carries no reason`);
    }
  }

  for (const [key, entry] of registered) {
    if (!live.has(key)) {
      problems.push(
        `E7 ${taxonomyPath} registers a uniform ${entry.code} in ${entry.file} ${entry.function}(), ` +
          `which no longer raises it identically more than once`,
      );
    }
  }

  return { scan, runtime, taxonomy, problems };
}

// ---------------------------------------------------------------------------
// --write
// ---------------------------------------------------------------------------

export function rewriteTaxonomy(root = repositoryRoot, taxonomyPath = TAXONOMY_PATH) {
  const scan = scanSource(root);
  const existing = loadTaxonomy(root, taxonomyPath);
  const codes = {};
  for (const row of scan.inventory) {
    const previous = existing.codes?.[row.code];
    codes[row.code] = {
      category: row.categories[0] ?? null,
      // NEVER invented. A new code arrives with a null status so that E9 has
      // something to refuse; choosing it is a decision, not a derivation.
      status: previous !== undefined && previous.category === row.categories[0] ? (previous.status ?? null) : null,
      contexts: row.contexts,
    };
  }
  const previousGuards = new Map((existing.uniformGuards ?? []).map((entry) => [uniformKey(entry), entry]));
  const uniformGuards = scan.uniform.map((entry) => {
    const previous = previousGuards.get(uniformKey(entry));
    return {
      file: entry.file,
      function: entry.function,
      code: entry.code,
      sites: entry.sites,
      shapes: entry.shapes,
      reason: previous?.reason ?? "",
    };
  });
  const updated = { ...existing, codes, uniformGuards };
  writeFileSync(join(root, taxonomyPath), `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}

// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--write")) {
    const written = rewriteTaxonomy();
    const unresolved = Object.entries(written.codes).filter(([, entry]) => entry.status === null);
    const unexplained = written.uniformGuards.filter((entry) => entry.reason === "");
    process.stdout.write(
      `error-taxonomy: wrote ${Object.keys(written.codes).length} code(s) and ` +
        `${written.uniformGuards.length} uniform-guard allowance(s) to ${TAXONOMY_PATH}\n`,
    );
    for (const [code] of unresolved) process.stdout.write(`  status needed: ${code}\n`);
    for (const entry of unexplained) {
      process.stdout.write(`  reason needed: ${entry.code} in ${entry.file} ${entry.function}()\n`);
    }
    return;
  }

  const result = checkTaxonomy();
  if (argv.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify({ problems: result.problems, inventory: result.scan.inventory, uniform: result.scan.uniform }, null, 2)}\n`,
    );
    process.exitCode = result.problems.length > 0 ? 1 : 0;
    return;
  }

  process.stdout.write(
    `error-taxonomy: ${result.scan.inventory.length} canonical code(s) across ` +
      `${result.scan.files.length} source file(s); ${result.scan.uniform.length} deliberately uniform guard(s)\n`,
  );
  for (const problem of result.problems) process.stdout.write(`${problem}\n`);
  if (result.problems.length === 0) {
    process.stdout.write(
      `ok: every code maps to a status the runtime module actually resolves, every mapping names a ` +
        `code that exists, and no two guards refuse identically under one code without a reason.\n`,
    );
  } else {
    process.stdout.write(`\n${result.problems.length} error-taxonomy problem(s).\n`);
  }
  process.exitCode = result.problems.length > 0 ? 1 : 0;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
