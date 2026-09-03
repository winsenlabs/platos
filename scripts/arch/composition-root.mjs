#!/usr/bin/env node
// WIN-297 composition-root audit.
//
// ADR M0.3 §5.1 rule (j) `adapters-only-from-core` says only `apps/core-api` may
// import `packages/adapters/*`. That is necessary and NOT sufficient for the
// property ADR M0.3 §4 actually states — "THE composition root: the one place
// adapters are bound to context ports". Under rule (j) alone, twelve adapter
// imports scattered across six transport directories are perfectly legal, and
// the "one place" would be a package rather than a place.
//
// This audit narrows rule (j) to a FILE. Rule (j) is not weakened, reinterpreted
// or replaced: it still runs, still fails on a non-core-api import, and its
// negative control is still in `arch-boundaries.test.mjs`. This is an additional
// gate that binds strictly inside it.
//
// It also polices three things that only became checkable once the composition
// root held real code:
//
//   * the binding table must agree with the generator's ADR §4/§13 ADAPTERS
//     table on all of name, port and owner — so the composition root cannot
//     silently disagree with the architecture it composes;
//   * every declared adapter must carry a compile-time port-satisfaction entry,
//     so no adapter is bound by convention alone;
//   * a DYNAMIC import — a specifier resolved at run time, which no static
//     boundary checker in this repository can see — may exist in exactly one
//     declared place, and must carry its declaration.
//
//   node scripts/arch/composition-root.mjs            # audit this repository
//   node scripts/arch/composition-root.mjs --root DIR # audit a fixture tree
//   node scripts/arch/composition-root.mjs --json

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { ADAPTERS } from "./gen-v1-skeleton.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The single file entitled to name an adapter package. */
export const COMPOSITION_ROOT_FILE = "apps/core-api/src/composition/adapter-bindings.ts";

/**
 * The single file entitled to a dynamic import, and the note it must carry.
 *
 * `apps/mcp-stdio` may not import an adapter (rule (j) names core-api alone) and
 * its only workspace dependency publishes types, so it cannot compose itself. It
 * takes its runtime from a host-supplied module specifier instead. That seam is
 * invisible to every static checker here, so it is declared rather than
 * discovered — and this audit fails if the declaration is ever removed.
 */
export const DYNAMIC_IMPORT_FILE = "apps/mcp-stdio/src/runtime.ts";
export const DYNAMIC_IMPORT_DECLARATION = "FINDING (WIN-297, reported not absorbed)";

const SCAN_ROOTS = ["packages/kernel", "packages/contexts", "packages/adapters", "apps/core-api", "apps/mcp-stdio"];
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".turbo", "coverage"]);

/**
 * Imports are read from the TypeScript compiler's own parse, never a regex.
 *
 * The first draft of this audit used one, and it reported two false positives on
 * the real tree within a minute: the word `import(` inside a template literal in
 * a test, and a line break between `import` and `(` in prose. A gate that cries
 * wolf on prose is a gate somebody eventually deletes, and the same blindness
 * that produces a false positive produces a false negative — `import` hidden in
 * a string would have been invisible in the other direction.
 */
function parse(path, source) {
  return ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

/** Every module specifier this file imports or re-exports, statically. */
function staticSpecifiers(file) {
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return specifiers;
}

/** `import(x)` where `x` is NOT a string literal — invisible to every checker. */
function hasRuntimeResolvedImport(file) {
  let found = false;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      !(node.arguments[0] !== undefined && ts.isStringLiteral(node.arguments[0]))
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function listSourceFiles(root) {
  const found = [];
  const walk = (absolute) => {
    if (!existsSync(absolute)) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(join(absolute, entry.name));
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        found.push(relative(root, join(absolute, entry.name)).split("\\").join("/"));
      }
    }
  };
  for (const scanRoot of SCAN_ROOTS) walk(join(root, scanRoot));
  return found.sort();
}

function importedAdapters(file) {
  const names = new Set();
  for (const specifier of staticSpecifiers(file)) {
    const found = /^@platos\/adapter-([^/]+)/u.exec(specifier);
    if (found?.[1] !== undefined) names.add(found[1]);
  }
  return names;
}

/** Read the `ADAPTER_BINDINGS` literal out of the composition-root source. */
export function parseBindingTable(source) {
  const entries = [];
  const pattern = /\{\s*adapter:\s*"([^"]+)",\s*port:\s*"([^"]+)",\s*owner:\s*"([^"]+)"\s*\}/gu;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    entries.push({ adapter: match[1], port: match[2], owner: match[3] });
  }
  return entries;
}

/** Read the keys of the `PORT_SATISFACTION` frozen literal. */
export function parseSatisfactionKeys(source) {
  const block = /export const PORT_SATISFACTION[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\);/u.exec(source);
  if (block === null) return null;
  const keys = [];
  const pattern = /(?:^|\n)\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/gu;
  let match;
  while ((match = pattern.exec(block[1] ?? "")) !== null) keys.push(match[1] ?? match[2]);
  return keys;
}

export function auditCompositionRoot(root = repositoryRoot) {
  const problems = [];
  const files = listSourceFiles(root);
  const read = (path) => readFileSync(join(root, path), "utf8");
  const parsed = new Map(files.map((path) => [path, parse(path, read(path))]));

  // --- (C1) exactly one importer of packages/adapters/*, and it is THE file ---
  const importers = [];
  for (const path of files) {
    if (importedAdapters(parsed.get(path)).size > 0) importers.push(path);
  }
  for (const path of importers) {
    if (path === COMPOSITION_ROOT_FILE) continue;
    // An adapter naming its own package is not a composition-root violation;
    // rule (j2) `adapter-is-self-contained` judges that case.
    if (path.startsWith("packages/adapters/")) continue;
    problems.push(`${path} imports an adapter package; only ${COMPOSITION_ROOT_FILE} may`);
  }
  if (!importers.includes(COMPOSITION_ROOT_FILE)) {
    problems.push(
      `${COMPOSITION_ROOT_FILE} imports no adapter package — the composition root would be vacuous`,
    );
  }

  if (!existsSync(join(root, COMPOSITION_ROOT_FILE))) {
    return { root, fileCount: files.length, bindingCount: 0, problems: [`${COMPOSITION_ROOT_FILE} is missing`] };
  }

  const compositionSource = read(COMPOSITION_ROOT_FILE);

  // --- (C6) every adapter package the skeleton creates must be bound ---
  const imported = importedAdapters(parsed.get(COMPOSITION_ROOT_FILE) ?? parse(COMPOSITION_ROOT_FILE, compositionSource));
  for (const adapter of ADAPTERS) {
    if (!imported.has(adapter.dir)) {
      problems.push(`${COMPOSITION_ROOT_FILE} does not import @platos/adapter-${adapter.dir}`);
    }
  }

  // --- (C2) the table must agree with the generator's ADR §4/§13 ownership ---
  const declared = parseBindingTable(compositionSource);
  const byName = new Map(declared.map((entry) => [entry.adapter, entry]));
  for (const adapter of ADAPTERS) {
    const entry = byName.get(adapter.dir);
    if (entry === undefined) {
      problems.push(`binding table omits ${adapter.dir}`);
      continue;
    }
    if (entry.port !== adapter.port) {
      problems.push(`binding table gives ${adapter.dir} port ${entry.port}; ADR M0.3 §4 says ${adapter.port}`);
    }
    if (entry.owner !== adapter.owner) {
      problems.push(`binding table gives ${adapter.dir} owner ${entry.owner}; ADR M0.3 §4 says ${adapter.owner}`);
    }
  }
  for (const entry of declared) {
    if (!ADAPTERS.some((adapter) => adapter.dir === entry.adapter)) {
      problems.push(`binding table names ${entry.adapter}, which is not one of the ${ADAPTERS.length} adapters`);
    }
  }
  if (declared.length !== ADAPTERS.length) {
    problems.push(`binding table declares ${declared.length} binding(s); the skeleton creates ${ADAPTERS.length}`);
  }

  // --- (C3) every binding carries a compile-time port-satisfaction entry ---
  const satisfaction = parseSatisfactionKeys(compositionSource);
  if (satisfaction === null) problems.push(`${COMPOSITION_ROOT_FILE} declares no PORT_SATISFACTION table`);
  else {
    for (const adapter of ADAPTERS) {
      if (!satisfaction.includes(adapter.dir)) {
        problems.push(`PORT_SATISFACTION has no entry for ${adapter.dir}; its binding is asserted, not proven`);
      }
    }
  }

  // --- (C4) a run-time-resolved import may exist in exactly one declared place ---
  for (const path of files) {
    const source = read(path);
    // A dynamic import with a LITERAL specifier is fully visible to the boundary
    // checkers, so it is not what this rule is about.
    if (!hasRuntimeResolvedImport(parsed.get(path))) continue;
    if (path !== DYNAMIC_IMPORT_FILE) {
      problems.push(
        `${path} resolves an import specifier at run time, which no boundary rule can see;` +
          ` only ${DYNAMIC_IMPORT_FILE} may, and it must declare why`,
      );
    } else if (!source.includes(DYNAMIC_IMPORT_DECLARATION)) {
      problems.push(`${path} has a run-time-resolved import but no longer carries its declared finding`);
    }
  }

  return { root, fileCount: files.length, bindingCount: declared.length, problems };
}

function main() {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1] ?? ".") : repositoryRoot;
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    process.stderr.write(`no such root: ${root}\n`);
    process.exitCode = 1;
    return;
  }
  const result = auditCompositionRoot(root);
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `composition-root: scanned ${result.fileCount} source file(s); ` +
        `${result.bindingCount} adapter binding(s) declared in ${COMPOSITION_ROOT_FILE}\n`,
    );
    for (const problem of result.problems) process.stdout.write(`FAIL ${problem}\n`);
    if (result.problems.length === 0) {
      process.stdout.write(
        `ok: adapters are imported in exactly one file, all ${result.bindingCount} bindings agree with ADR M0.3 §4,` +
          ` and every one is proven at compile time\n`,
      );
    }
  }
  if (result.problems.length > 0) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith("composition-root.mjs")) main();
