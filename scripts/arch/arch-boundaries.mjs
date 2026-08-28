#!/usr/bin/env node
// Platos V1 architecture-boundary checker (WIN-248 / ADR M0.3 enforcement).
//
// A dependency-cruiser-equivalent, written in pure Node with zero dependencies
// so it runs in CI today with no install step. It evaluates the ADR M0.3 rule
// set (scripts/arch/boundary-rules.mjs) against a source tree and exits non-zero
// on any violation.
//
// WHAT ENFORCES NOW vs WHAT IS READY FOR M2. The V1 bounded-context packages
// (packages/contexts/*, packages/adapters/*, packages/kernel, apps/core-api) do
// not exist yet — they are built in M2. So the default scan finds no V1 source
// and the checker is green by vacuity today. The rule logic is proven non-vacuous
// by scripts/arch/arch-boundaries.test.mjs, which builds real temp-directory
// fixtures and asserts each rule CATCHES a violation and PASSES a compliant tree.
// As M2 creates the packages, the same rules bind against real code with no edit.
//
// Usage:
//   node scripts/arch/arch-boundaries.mjs                 # scan the V1 layout in this repo
//   node scripts/arch/arch-boundaries.mjs --root <dir>    # scan an explicit root (fixtures)
//   node scripts/arch/arch-boundaries.mjs --json          # machine-readable report
//   node scripts/arch/arch-boundaries.mjs --root <dir> --scan-root .   # scan the whole root

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALL_RULES,
  CONTEXT_DEPENDS_ON,
  WORKSPACE_ALIASES,
} from "./boundary-rules.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

// The V1 layout directories M2 creates. Legacy strangler code (apps/webapp,
// apps/agent) is intentionally NOT scanned by default: its migration locks
// (e.g. webapp-no-prisma) are proven in fixtures and bind once those trees move
// under the V1 layout in M2.2.
const DEFAULT_SCAN_ROOTS = [
  "packages/kernel",
  "packages/contexts",
  "packages/adapters",
  "apps/core-api",
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".turbo",
  ".next",
  "coverage",
  "generated",
]);

const IMPORT_PATTERNS = [
  // import ... from "x"; export ... from "x"; import "x"
  /\b(?:import|export)\s+(?:[^'"]*?\sfrom\s*)?["']([^"']+)["']/g,
  // import("x")  and  require("x")
  /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function listSourceFiles(absoluteRoot) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (entry.name.endsWith(".d.ts")) continue;
        const dot = entry.name.lastIndexOf(".");
        if (dot < 0) continue;
        if (SOURCE_EXTENSIONS.has(entry.name.slice(dot))) out.push(full);
      }
    }
  };
  walk(absoluteRoot);
  return out;
}

function extractSpecifiers(source) {
  const specifiers = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) specifiers.push(match[1]);
  }
  return specifiers;
}

// Resolve an import specifier, as written in a file at `fromVirtual` (a
// root-relative path with forward slashes), to a root-relative "virtual path".
// Bare specifiers become `node_modules/<specifier>` so infra/SDK rules can match.
function resolveTargetVirtualPath(specifier, fromVirtual) {
  if (specifier.startsWith(".")) {
    const fromDir = dirname(fromVirtual);
    const joined = normalizeSlashes(join(fromDir, specifier));
    return joined.replace(/^\.\//, "");
  }
  for (const alias of WORKSPACE_ALIASES) {
    if (specifier === alias.prefix || specifier.startsWith(`${alias.prefix}`)) {
      if (alias.prefix.endsWith("-")) {
        // e.g. "@platos/context-" + "tools/contracts/x"
        const remainder = specifier.slice(alias.prefix.length);
        return normalizeSlashes(join(alias.path, remainder));
      }
      // exact-prefix alias e.g. "@platos/kernel"
      const remainder = specifier.slice(alias.prefix.length).replace(/^\//, "");
      return normalizeSlashes(join(alias.path, remainder));
    }
  }
  return `node_modules/${specifier}`;
}

function normalizeSlashes(p) {
  return p.split("\\").join("/");
}

function contextOf(virtualPath) {
  const m = /^packages\/contexts\/([^/]+)\//.exec(virtualPath);
  return m ? m[1] : null;
}

function layerOf(virtualPath) {
  const m = /^packages\/contexts\/[^/]+\/([^/]+)\//.exec(virtualPath);
  return m ? m[1] : null;
}

function makeMatcher(source) {
  if (source === undefined || source === null) return null;
  if (source === "") return () => true; // empty regex matches everything
  const re = new RegExp(source);
  return (value) => re.test(value);
}

// Evaluate one plain path-vs-path rule for a single (from, target) edge.
function firesPlainRule(rule, fromVirtual, targetVirtual) {
  const fromMatch = makeMatcher(rule.from?.path);
  const fromNot = makeMatcher(rule.from?.pathNot);
  const toMatch = makeMatcher(rule.to?.path);
  const toNot = makeMatcher(rule.to?.pathNot);
  if (fromMatch && !fromMatch(fromVirtual)) return false;
  if (fromNot && fromNot(fromVirtual)) return false;
  if (toMatch && !toMatch(targetVirtual)) return false;
  if (toNot && toNot(targetVirtual)) return false;
  return true;
}

// --- specialised evaluators for the non-path rules ------------------------

function firesDomainPurity(fromVirtual, targetVirtual) {
  const fromCtx = contextOf(fromVirtual);
  if (!fromCtx || layerOf(fromVirtual) !== "domain") return false;
  if (!targetVirtual.startsWith("packages/")) return false; // external libs handled elsewhere
  if (targetVirtual.startsWith("packages/kernel/")) return false; // kernel is allowed
  if (targetVirtual.startsWith(`packages/contexts/${fromCtx}/domain/`)) return false; // own domain
  return true; // anything else under packages/ (own application, other context, any adapter)
}

function firesCrossContextContractsOnly(fromVirtual, targetVirtual) {
  const fromCtx = contextOf(fromVirtual);
  const toCtx = contextOf(targetVirtual);
  if (!fromCtx || !toCtx || fromCtx === toCtx) return false;
  return /^packages\/contexts\/[^/]+\/(domain|application|adapters|transport)\//.test(targetVirtual);
}

function firesCrossContextDag(fromVirtual, targetVirtual) {
  const fromCtx = contextOf(fromVirtual);
  const toCtx = contextOf(targetVirtual);
  if (!fromCtx || !toCtx || fromCtx === toCtx) return false;
  const allowed = CONTEXT_DEPENDS_ON[fromCtx];
  if (!allowed) return false; // unknown context: not our concern
  return !allowed.includes(toCtx);
}

// --- the checker ----------------------------------------------------------

export function check(absoluteRoot, { scanRoots } = {}) {
  const roots = scanRoots ?? DEFAULT_SCAN_ROOTS;
  const files = [];
  for (const r of roots) {
    const abs = resolve(absoluteRoot, r);
    if (existsSync(abs)) files.push(...listSourceFiles(abs));
  }

  const violations = [];
  const contextEdges = new Set(); // "X->Y" for the acyclic backstop

  for (const absFile of files) {
    const fromVirtual = normalizeSlashes(relative(absoluteRoot, absFile));
    let source;
    try {
      source = readFileSync(absFile, "utf8");
    } catch {
      continue;
    }
    const specifiers = extractSpecifiers(source);
    for (const specifier of specifiers) {
      const targetVirtual = resolveTargetVirtualPath(specifier, fromVirtual);

      // record cross-context edges for the acyclic backstop
      const fCtx = contextOf(fromVirtual);
      const tCtx = contextOf(targetVirtual);
      if (fCtx && tCtx && fCtx !== tCtx) contextEdges.add(`${fCtx}->${tCtx}`);

      for (const rule of ALL_RULES) {
        let fired = false;
        if (rule.kind === "domain-purity") fired = firesDomainPurity(fromVirtual, targetVirtual);
        else if (rule.kind === "cross-context-contracts-only")
          fired = firesCrossContextContractsOnly(fromVirtual, targetVirtual);
        else if (rule.kind === "cross-context-dag")
          fired = firesCrossContextDag(fromVirtual, targetVirtual);
        else if (rule.kind === "acyclic") fired = false; // handled after the walk
        else fired = firesPlainRule(rule, fromVirtual, targetVirtual);

        if (fired) {
          violations.push({
            rule: rule.id,
            severity: rule.severity,
            from: fromVirtual,
            to: targetVirtual,
            specifier,
            comment: rule.comment,
          });
        }
      }
    }
  }

  // Acyclic backstop: any 2+-node cycle in the cross-context edge set.
  const cycles = findCycles(contextEdges);
  for (const cycle of cycles) {
    violations.push({
      rule: "no-cross-context-cycles",
      severity: "error",
      from: cycle[0],
      to: cycle[cycle.length - 1],
      specifier: cycle.join(" -> "),
      comment: "import cycle across contexts is forbidden; the context graph must stay acyclic.",
    });
  }

  return { root: absoluteRoot, scanRoots: roots, fileCount: files.length, violations };
}

function findCycles(edgeSet) {
  const adjacency = new Map();
  for (const edge of edgeSet) {
    const [a, b] = edge.split("->");
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a).add(b);
  }
  const cycles = [];
  const seen = new Set();
  const color = new Map(); // 0=visiting,1=done
  const stack = [];

  const dfs = (node) => {
    color.set(node, 0);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (color.get(next) === 0) {
        // back-edge → cycle from next..node
        const start = stack.indexOf(next);
        const cycle = stack.slice(start).concat(next);
        const key = [...cycle].sort().join("|");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (color.get(next) === undefined) {
        dfs(next);
      }
    }
    stack.pop();
    color.set(node, 1);
  };

  for (const node of adjacency.keys()) if (color.get(node) === undefined) dfs(node);
  return cycles;
}

// --- CLI ------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { root: repositoryRoot, json: false, scanRoots: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") opts.root = resolve(argv[++i]);
    else if (arg === "--json") opts.json = true;
    else if (arg === "--scan-root") (opts.scanRoots ??= []).push(argv[++i]);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = check(opts.root, { scanRoots: opts.scanRoots });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const shownRoot = relative(process.cwd(), result.root) || ".";
    process.stdout.write(
      `arch-boundaries: scanned ${result.fileCount} source file(s) under ${shownRoot} ` +
        `(${result.scanRoots.join(", ")})\n`
    );
    if (result.violations.length === 0) {
      if (result.fileCount === 0) {
        process.stdout.write(
          "ok: no V1-layout source present yet; rules are fixture-proven and bind as M2 creates packages.\n"
        );
      } else {
        process.stdout.write(`ok: ${result.fileCount} file(s) satisfy every ADR M0.3 boundary rule.\n`);
      }
    } else {
      for (const v of result.violations) {
        process.stdout.write(`FAIL [${v.rule}] ${v.from} -> ${v.specifier}\n    ${v.comment}\n`);
      }
      process.stdout.write(`\n${result.violations.length} boundary violation(s).\n`);
    }
  }

  process.exitCode = result.violations.length > 0 ? 1 : 0;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
