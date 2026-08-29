#!/usr/bin/env node
// Generates the committed .dependency-cruiser.js from the single source of truth
// (scripts/arch/boundary-rules.mjs), so the dependency-cruiser config and the
// pure-Node checker can never silently disagree.
//
// dependency-cruiser is NOT a dependency of this repo today; the V1 packages it
// would scan do not exist until M2. The emitted .dependency-cruiser.js is the
// durable, ready-to-activate config: add dependency-cruiser as a dev dependency
// in M2 and `depcruise packages apps` enforces the identical ADR M0.3 rule set
// against real code. Until then, scripts/arch/arch-boundaries.mjs enforces the
// same rules (fixture-proven).
//
//   node scripts/arch/gen-dependency-cruiser.mjs           # (re)write .dependency-cruiser.js
//   node scripts/arch/gen-dependency-cruiser.mjs --check    # fail if committed copy is stale

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ALL_RULES,
  BANNED_CORE_IMPORT_SOURCES,
  CONTEXT_DEPENDS_ON,
  CONTEXT_NAMES,
} from "./boundary-rules.mjs";

const outPath = fileURLToPath(new URL("../../.dependency-cruiser.js", import.meta.url));

// The plain path-vs-path rules map 1:1 onto dependency-cruiser's forbidden shape.
function plainRule(rule) {
  const from = {};
  if (rule.from?.path) from.path = rule.from.path;
  if (rule.from?.pathNot) from.pathNot = rule.from.pathNot;
  const to = {};
  if (rule.to?.path) to.path = rule.to.path;
  if (rule.to?.pathNot) to.pathNot = rule.to.pathNot;
  return { name: rule.id, comment: rule.comment, severity: rule.severity, from, to };
}

// The four non-path rules use dependency-cruiser's native group-reference and
// circular features (ADR M0.3 §5.1). They are expressed directly here.
function specialRule(rule) {
  switch (rule.kind) {
    case "domain-purity":
      // domain may import only its own domain and packages/kernel.
      return {
        name: rule.id,
        comment: rule.comment,
        severity: rule.severity,
        from: { path: "^packages/contexts/([^/]+)/domain/" },
        to: {
          path: "^packages/(contexts|adapters|kernel)/",
          pathNot: "^packages/(kernel/|contexts/$1/domain/)",
        },
      };
    case "cross-context-contracts-only":
      // a context may reach another context only through its contracts/.
      return {
        name: rule.id,
        comment: rule.comment,
        severity: rule.severity,
        from: { path: "^packages/contexts/([^/]+)/" },
        to: {
          path: "^packages/contexts/(?!$1/)[^/]+/(domain|application|adapters|transport)/",
        },
      };
    case "cross-context-dag":
      // Expanded per-context below (needs the allow-list data); nothing here.
      return null;
    case "same-adapter-only":
      // (j2) group reference: the adapter name captured on the from side is
      // excluded on the to side, so an adapter may import only itself.
      return {
        name: rule.id,
        comment: rule.comment,
        severity: rule.severity,
        from: { path: "^packages/adapters/([^/]+)/" },
        to: { path: "^packages/adapters/", pathNot: "^packages/adapters/$1/" },
      };
    case "context-registry":
      // (l) any directory under packages/contexts/ that is not one of the 17.
      // dependency-cruiser evaluates `from` on its own when `to` is empty, which
      // is the per-file semantics this rule needs.
      return {
        name: rule.id,
        comment: rule.comment,
        severity: rule.severity,
        from: { path: `^packages/contexts/(?!(${CONTEXT_NAMES.join("|")})/)` },
        to: {},
      };
    case "acyclic":
      return {
        name: rule.id,
        comment: rule.comment,
        severity: rule.severity,
        from: {},
        to: { circular: true },
      };
    default:
      return null;
  }
}

// Rule (d): expand the ADR §1 domainDeps allow-list into one forbidden rule per
// context, listing the contexts it may NOT import.
function dagRules() {
  const rules = [];
  for (const ctx of CONTEXT_NAMES) {
    const allowed = new Set([ctx, ...CONTEXT_DEPENDS_ON[ctx]]);
    const forbidden = CONTEXT_NAMES.filter((c) => !allowed.has(c));
    if (forbidden.length === 0) continue;
    rules.push({
      name: `context-dag-${ctx}`,
      comment: `ADR M0.3 §1 domainDeps: ${ctx} may not depend on ${forbidden.join(", ")}.`,
      severity: "error",
      from: { path: `^packages/contexts/${ctx}/` },
      to: { path: `^packages/contexts/(${forbidden.join("|")})/` },
    });
  }
  return rules;
}

function buildForbidden() {
  const forbidden = [];
  for (const rule of ALL_RULES) {
    if (rule.kind) {
      if (rule.kind === "cross-context-dag") {
        forbidden.push(...dagRules());
      } else {
        const mapped = specialRule(rule);
        if (mapped) forbidden.push(mapped);
      }
    } else {
      forbidden.push(plainRule(rule));
    }
  }
  return forbidden;
}

function render() {
  const forbidden = buildForbidden();
  const header = `// GENERATED — do not edit by hand.
// Source of truth: scripts/arch/boundary-rules.mjs
// Regenerate:      node scripts/arch/gen-dependency-cruiser.mjs
// Drift gate:      node scripts/arch/gen-dependency-cruiser.mjs --check
//
// The dependency-cruiser encoding of ADR M0.3 (WIN-248) boundary rules. It is
// the M2 activation artifact: add dependency-cruiser as a dev dependency and run
//   depcruise packages apps --config .dependency-cruiser.js
// to enforce these rules against the V1 packages once they exist. Until M2, the
// zero-dependency checker scripts/arch/arch-boundaries.mjs enforces the same rule
// set and is proven non-vacuous by scripts/arch/arch-boundaries.test.mjs.
//
// The banned core-import list encoded below is exactly:
//   ${BANNED_CORE_IMPORT_SOURCES.join(", ")}
`;
  const body = `module.exports = ${JSON.stringify({ forbidden, options: options() }, null, 2)};\n`;
  return `${header}\n${body}`;
}

function options() {
  // Minimal, resolution-safe defaults. In M2, add a `tsConfig.fileName` pointing
  // at the workspace tsconfig so cross-package path aliases resolve; it is omitted
  // here because no such tsconfig exists yet and dep-cruiser must not error on a
  // dangling reference.
  return {
    doNotFollow: { path: "node_modules" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
    reporterOptions: { text: { highlightFocused: true } },
  };
}

function main() {
  const check = process.argv.includes("--check");
  const rendered = render();
  if (check) {
    let current = "";
    try {
      current = readFileSync(outPath, "utf8");
    } catch {
      current = "";
    }
    if (current !== rendered) {
      process.stderr.write(
        "dependency-cruiser config drift: .dependency-cruiser.js is stale.\n" +
          "Run: node scripts/arch/gen-dependency-cruiser.mjs\n"
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write("ok: .dependency-cruiser.js matches scripts/arch/boundary-rules.mjs\n");
    return;
  }
  writeFileSync(outPath, rendered, "utf8");
  process.stdout.write(`wrote ${outPath}\n`);
}

main();
