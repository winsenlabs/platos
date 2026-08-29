#!/usr/bin/env node
// WIN-294 — INDEPENDENT REST census (second enumerator).
//
// The control-plane generator (apps/agent/scripts/generate-control-plane.mjs)
// enumerates routes via the Nest module graph keyed by a hand-maintained
// CONTROLLER_MODULE_MAP allowlist, and emits operation-manifest.generated.json.
// The capability matrix then re-reads THAT manifest — so those two share one
// registry and are NOT independent.
//
// This script is the genuinely independent second mechanism: it discovers
// controllers by GLOBBING apps/agent/src/**/*.controller.ts (file presence, not
// an allowlist) and parses route decorators + operator guards directly from
// source. It then reconciles against the committed manifest to zero UNEXPLAINED
// delta. Because it finds controllers by file, a production controller that
// exists but was forgotten from the generator's allowlist is caught here as an
// OMISSION — the "omissions fail CI" guarantee WIN-294 requires.
//
// Usage:
//   node scripts/rest-census-independent.mjs           # regenerate the artifact
//   node scripts/rest-census-independent.mjs --check    # fail on any drift/omission
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "apps/agent/src");
const MANIFEST = join(ROOT, "apps/agent/src/control-plane/operation-manifest.generated.json");
const OUT = join(ROOT, "docs/audits/M0.9-rest-census-independent.json");

// Array-form controllers bind every method under MULTIPLE base paths, so the
// manifest counts each route once per base path. The multiplier is DERIVED FROM
// SOURCE (the length of the `@Controller([...])` array), never hardcoded — this
// is exactly the "array-form Controller binding expansion" WIN-294 requires. The
// two known multi-mount controllers are documented here only as a human tripwire;
// the reconciliation uses the source-derived count, and this map is asserted to
// match it (a silent change to either side fails --check).
export const KNOWN_MULTI_MOUNT = {
  DocsMcpController: 2, // @Controller(["mcp/docs", "mcp"]) — canonical + install URL
  MemoryController: 2, // @Controller(["api/v1/memory", "api/v1/platos/memory"]) — legacy alias
};

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Glob every production *.controller.ts (test controllers excluded by path). */
export function walkControllers(dir = SRC, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walkControllers(p, acc);
    else if (p.endsWith(".controller.ts") && !p.includes(`${SRC}/test/`) && !p.split("/").includes("test"))
      acc.push(p);
  }
  return acc;
}

/** Parse a controller source: class name, base-path count, routes, operator floor. */
export function parseController(src) {
  const className = (/export\s+class\s+(\w+Controller)\b/.exec(src) || [])[1] || null;
  // Base paths from the @Controller(...) argument. An array literal binds every
  // route under each element (array-form expansion); a single/empty argument is
  // one base path. Derived from source so a new alias prefix is picked up
  // automatically rather than needing a hardcoded multiplier.
  const ctrl = /@Controller\s*\(\s*(\[[^\]]*\])?/.exec(src);
  const basePaths =
    ctrl && ctrl[1] ? Math.max(1, (ctrl[1].match(/["'`][^"'`]*["'`]/g) || []).length) : 1;
  // Line-anchored HTTP method decorators. This matches the manifest's per-route
  // counting and ignores decorator names appearing inside comments or strings.
  const routes = (src.match(/^\s*@(Get|Post|Put|Patch|Delete)\s*\(/gm) || []).length;
  // Operator LOWER BOUND: direct requireOperator(...) invocations. Controllers
  // that guard many handlers through one shared wrapper (e.g. getOperatorScope)
  // legitimately show a lower floor than the manifest's semantic count — that is
  // an inequality the reconciliation permits, never an equality it forces.
  const requireOperator = (src.match(/requireOperator\s*\(/g) || []).length;
  return { className, basePaths, routes, requireOperator };
}

/** Independent census by globbing + parsing controller files. */
export function independentCensus() {
  const controllers = {};
  for (const file of walkControllers()) {
    const parsed = parseController(readFileSync(file, "utf8"));
    if (!parsed.className) continue;
    controllers[parsed.className] = { ...parsed, file: relative(ROOT, file) };
  }
  return controllers;
}

/** The generator's committed manifest, reduced to per-controller counts. */
export function manifestCensus() {
  const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const controllers = {};
  let totalOps = 0;
  let totalOperator = 0;
  for (const op of m.inventories.restOperations) {
    for (const impl of op.implementations || []) {
      const c = impl.controller;
      if (!c) continue;
      controllers[c] = controllers[c] || { ops: 0, operator: 0 };
      controllers[c].ops += 1;
      totalOps += 1;
      if (impl.requiresOperator) {
        controllers[c].operator += 1;
        totalOperator += 1;
      }
    }
  }
  return { controllers, totalOps, totalOperator };
}

/**
 * Reconcile the two mechanisms. Returns { ok, failures, table, totals }.
 * Inputs are injectable so mutation tests can feed a controller-removed,
 * route-hidden, or operator-wrapped-away census and prove the gate fails.
 */
export function reconcile(indep = independentCensus(), man = manifestCensus()) {
  const failures = [];
  const table = [];

  const indepNames = new Set(Object.keys(indep));
  const manNames = new Set(Object.keys(man.controllers));

  // Check 1 — controller-set completeness (the omission control).
  for (const name of indepNames)
    if (!manNames.has(name))
      failures.push(
        `OMISSION: production controller ${name} (${indep[name].file}) has routes but is ABSENT from the generated manifest — add it to the generator's registry.`
      );
  for (const name of manNames)
    if (!indepNames.has(name))
      failures.push(
        `PHANTOM: manifest references controller ${name} that has no production *.controller.ts file.`
      );

  // Checks 2 & 3 — per-controller route reconciliation + operator lower bound.
  let indepUniqueRoutes = 0;
  for (const name of [...new Set([...indepNames, ...manNames])].sort()) {
    const i = indep[name] || { routes: 0, requireOperator: 0, basePaths: 1, file: "(none)" };
    const mm = man.controllers[name] || { ops: 0, operator: 0 };
    const mult = i.basePaths || 1;
    // Bidirectional multi-mount tripwire: the source-derived base-path count and
    // the documented KNOWN_MULTI_MOUNT map must agree, so neither can drift silently.
    if (KNOWN_MULTI_MOUNT[name] && KNOWN_MULTI_MOUNT[name] !== mult)
      failures.push(
        `MULTI-MOUNT DRIFT: ${name} — source @Controller declares ${mult} base paths but KNOWN_MULTI_MOUNT records ${KNOWN_MULTI_MOUNT[name]}.`
      );
    if (mult > 1 && !KNOWN_MULTI_MOUNT[name])
      failures.push(
        `NEW MULTI-MOUNT: ${name} declares ${mult} base paths in source but is not documented in KNOWN_MULTI_MOUNT — review and record it.`
      );
    const expectedOps = i.routes * mult;
    indepUniqueRoutes += i.routes;
    const routeOk = expectedOps === mm.ops;
    const operatorOk = mm.operator >= i.requireOperator;
    if (!routeOk)
      failures.push(
        `ROUTE DRIFT: ${name} — independent decorators ${i.routes} × mount-multiplier ${mult} = ${expectedOps}, manifest ops ${mm.ops}. Either a route was added/removed, or the dual-mount table is stale.`
      );
    if (!operatorOk)
      failures.push(
        `OPERATOR REGRESSION: ${name} — manifest operator-protected ${mm.operator} dropped BELOW the independent requireOperator floor ${i.requireOperator}. An operator guard was removed or wrapped away.`
      );
    table.push({
      controller: name,
      file: i.file,
      independentDecorators: i.routes,
      mountMultiplier: mult,
      manifestOps: mm.ops,
      independentOperatorFloor: i.requireOperator,
      manifestOperator: mm.operator,
      routeOk,
      operatorOk,
    });
  }

  const totals = {
    controllers: indepNames.size,
    independentUniqueRoutes: indepUniqueRoutes,
    dualMountAliasOps: man.totalOps - indepUniqueRoutes,
    manifestOps: man.totalOps,
    independentOperatorFloor: Object.values(indep).reduce((s, c) => s + c.requireOperator, 0),
    manifestOperator: man.totalOperator,
  };
  return { ok: failures.length === 0, failures, table, totals };
}

function build() {
  const r = reconcile();
  return {
    milestone: "M0.9",
    issue: "WIN-294",
    title: "Independent REST census — second enumerator reconciled to the generated manifest",
    mechanism:
      "Independent in ENUMERATION: discovers controllers by globbing apps/agent/src/**/*.controller.ts (file presence, NOT the generator's CONTROLLER_MODULE_MAP allowlist) and parses @Controller base paths, route decorators, and requireOperator guards directly from source. The committed manifest is read ONLY to reconcile counts, never to enumerate — so a controller the generator's allowlist misses still appears here and fails --check.",
    reconciliation: {
      routes:
        "independentUniqueRoutes + dualMountAliasOps === manifestOps; every controller's manifest ops === decorators × mount-multiplier.",
      operator:
        "manifestOperator >= independentOperatorFloor per controller (wrapper/inherited operator enforcement legitimately lifts the manifest above the direct-call floor).",
      omission:
        "a production controller found by glob but absent from the manifest FAILS --check.",
    },
    totals: r.totals,
    table: r.table,
    ok: r.ok,
    failures: r.failures,
  };
}

function main() {
  const check = process.argv.includes("--check");
  const fresh = build();
  const serialized = JSON.stringify({ ...fresh, sourceDigest: undefined }, null, 2);
  fresh.sourceDigest = sha256(
    JSON.stringify({ table: fresh.table, totals: fresh.totals })
  );
  const out = JSON.stringify(fresh, null, 2) + "\n";
  if (check) {
    if (!fresh.ok) {
      console.error("rest-census-independent: RECONCILIATION FAILED");
      for (const f of fresh.failures) console.error("  - " + f);
      process.exit(1);
    }
    let committed;
    try {
      committed = readFileSync(OUT, "utf8");
    } catch {
      committed = null;
    }
    if (committed !== out) {
      console.error(
        "rest-census-independent: artifact OUT OF DATE — run `node scripts/rest-census-independent.mjs` and commit."
      );
      process.exit(1);
    }
    console.error(
      `rest-census-independent: OK. ${fresh.totals.controllers} controllers, independent unique routes ${fresh.totals.independentUniqueRoutes} + ${fresh.totals.dualMountAliasOps} dual-mount = ${fresh.totals.manifestOps} manifest ops; operator floor ${fresh.totals.independentOperatorFloor} <= manifest ${fresh.totals.manifestOperator}.`
    );
    return;
  }
  writeFileSync(OUT, out);
  console.error(
    `rest-census-independent: wrote ${relative(ROOT, OUT)} — ${fresh.totals.controllers} controllers, ${fresh.totals.manifestOps} ops, operator ${fresh.totals.manifestOperator}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
