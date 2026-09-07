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
// controllers by GLOBBING the declared SCAN_ROOTS (file presence, not an
// allowlist) and parses route decorators + operator guards directly from
// source. It then reconciles against the committed manifest to zero UNEXPLAINED
// delta. Because it finds controllers by file, a production controller that
// exists but was forgotten from the generator's allowlist is caught here as an
// OMISSION — the "omissions fail CI" guarantee WIN-294 requires.
//
// Usage:
//   node scripts/rest-census-independent.mjs           # regenerate the artifact
//   node scripts/rest-census-independent.mjs --check    # fail on any drift/omission
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "apps/agent/src/control-plane/operation-manifest.generated.json");
const OUT = join(ROOT, "docs/audits/M0.9-rest-census-independent.json");

// ── THE SCAN ROOTS (WIN-267 / M4.1) ─────────────────────────────────────────
//
// This list used to be one hardcoded `apps/agent/src`. That is precisely why a
// route added under `apps/core-api` was invisible to the gate that is supposed
// to govern it: the enumerator could not see the directory the V1 surface is
// being built in, so "zero unexplained delta" was a statement about the one
// application anybody happened to be looking at.
//
// The roots are DECLARED rather than discovered, and each is joined to the
// manifest below (`reconcileScanRoots`): every manifest route implementation
// must live under one of these directories, and each root's globbed decorator
// count — expanded by its mount multipliers — must equal the manifest operations
// attributed to it. So neither "a root nobody scans" nor "a root that scans a
// directory the manifest has never heard of" survives a run.
export const SCAN_ROOTS = Object.freeze([
  Object.freeze({
    id: "agent",
    dir: "apps/agent/src",
    why: "the V0 Nest application — every production controller the frozen surface serves today.",
  }),
  Object.freeze({
    id: "core-api-transports",
    dir: "apps/core-api/src/transports",
    why:
      "WIN-267 (M4.1) publishes the canonical V1 REST surface here. It carries no controller yet; the root is declared NOW so the FIRST route to land is counted by this census rather than discovered by a reader months later.",
  }),
]);

const SRC = join(ROOT, SCAN_ROOTS[0].dir);

// ── THE ONE NAMED EXCLUSION, WITH A TRIPWIRE ────────────────────────────────
//
// `apps/core-api/src/http/health.controller.ts` carries three route decorators
// and is deliberately NOT scanned. It is the PROCESS edge, not a business
// transport: `/livez`, `/healthz` and `/readyz` take no tenant, resolve no scope
// and call no use case, and ADR M0.4 §2 pins them OUT of the `/api/v1` versioned
// surface on purpose — a liveness probe that moved when the API's major moved
// would fail a fleet on a routine release.
//
// Skipping on principle is only honest if the skip can be falsified, so the
// exclusion is MEASURED on every run: the file must exist, its `@Controller()`
// argument list must stay EMPTY (so it can never mount under `api/`), and it must
// carry exactly the three probes named here. A fourth route, or a base path,
// means business surface has been parked in the process edge, and this census
// says so by name instead of shrugging.
export const PROCESS_EDGE_EXCLUSIONS = Object.freeze([
  Object.freeze({
    file: "apps/core-api/src/http/health.controller.ts",
    controller: "HealthController",
    routes: 3,
    emptyBasePath: true,
    why:
      "process-edge liveness/readiness probes (ADR M0.4 §2 keeps them off the versioned surface); no tenant, no scope, no use case.",
  }),
]);

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

/** Glob every production *.controller.ts under `dir` (test controllers excluded by path). */
export function walkControllers(dir = SRC, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walkControllers(p, acc);
    else if (p.endsWith(".controller.ts") && !p.split("/").includes("test")) acc.push(p);
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
  // Whether the @Controller(...) argument list is EMPTY — the shape that pins a
  // controller to the application root and therefore off the versioned surface.
  // Read only by the process-edge exclusion tripwire.
  const emptyBasePath = /@Controller\s*\(\s*\)/.test(src);
  // Line-anchored HTTP method decorators. This matches the manifest's per-route
  // counting and ignores decorator names appearing inside comments or strings.
  const routes = (src.match(/^\s*@(Get|Post|Put|Patch|Delete)\s*\(/gm) || []).length;
  // Operator LOWER BOUND: direct requireOperator(...) invocations. Controllers
  // that guard many handlers through one shared wrapper (e.g. getOperatorScope)
  // legitimately show a lower floor than the manifest's semantic count — that is
  // an inequality the reconciliation permits, never an equality it forces.
  const requireOperator = (src.match(/requireOperator\s*\(/g) || []).length;
  return { className, basePaths, emptyBasePath, routes, requireOperator };
}

/** Every declared scan root, measured: presence, controllers, decorators. */
export function scanRootReport(root = ROOT) {
  return SCAN_ROOTS.map((declared) => {
    const dir = join(root, declared.dir);
    const parsed = walkControllers(dir)
      .map((file) => ({
        file: relative(root, file).split("\\").join("/"),
        ...parseController(readFileSync(file, "utf8")),
      }))
      .filter((c) => c.className);
    return {
      id: declared.id,
      dir: declared.dir,
      why: declared.why,
      present: existsSync(dir),
      controllers: parsed.length,
      decorators: parsed.reduce((sum, c) => sum + c.routes, 0),
      parsed,
    };
  });
}

/** The process-edge exclusions, measured against the tree they claim to describe. */
export function processEdgeReport(root = ROOT) {
  return PROCESS_EDGE_EXCLUSIONS.map((declared) => {
    const absolute = join(root, declared.file);
    if (!existsSync(absolute)) return { ...declared, present: false, observed: null };
    return { ...declared, present: true, observed: parseController(readFileSync(absolute, "utf8")) };
  });
}

/** Independent census by globbing + parsing controller files across every scan root. */
export function independentCensus(roots = scanRootReport()) {
  const controllers = {};
  for (const root of roots) {
    for (const parsed of root.parsed) controllers[parsed.className] = { ...parsed, scanRoot: root.id };
  }
  return controllers;
}

/** The generator's committed manifest, reduced to per-controller counts. */
export function manifestCensus() {
  const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const controllers = {};
  const sources = {};
  let totalOps = 0;
  let totalOperator = 0;
  for (const op of m.inventories.restOperations) {
    for (const impl of op.implementations || []) {
      const c = impl.controller;
      if (!c) continue;
      controllers[c] = controllers[c] || { ops: 0, operator: 0 };
      controllers[c].ops += 1;
      totalOps += 1;
      sources[c] = sources[c] || new Set();
      sources[c].add(String(impl.source ?? "").split("\\").join("/"));
      if (impl.requiresOperator) {
        controllers[c].operator += 1;
        totalOperator += 1;
      }
    }
  }
  return { controllers, sources, totalOps, totalOperator };
}

/**
 * Join the DECLARED scan roots to the manifest and to the tree.
 *
 * This is the half that cannot be satisfied by anything this file controls. Each
 * manifest route implementation carries the source file it came from; every one
 * of them must fall under a declared root, and each root's globbed decorator
 * count (expanded by mount multiplier) must equal the manifest operations
 * attributed to that root. A root nobody scans, a root pointed at a directory
 * the manifest has never heard of, and an application whose controllers live
 * outside every declared root all fail here, by name.
 */
export function reconcileScanRoots(
  roots = scanRootReport(),
  edge = processEdgeReport(),
  man = manifestCensus(),
  indep = independentCensus(roots),
) {
  const failures = [];

  for (const root of roots) {
    if (!root.present)
      failures.push(
        `SCAN ROOT MISSING: ${root.id} declares ${root.dir}, which does not exist. A declared root that is not on disk scans nothing, and would make this census silently narrower than it claims to be.`,
      );
  }

  // Attribute every manifest implementation source to a declared root.
  const byRoot = new Map(roots.map((r) => [r.id, { ops: 0, controllers: new Set() }]));
  const unattributed = [];
  for (const [controller, counts] of Object.entries(man.controllers)) {
    const paths = [...(man.sources?.[controller] ?? [])];
    const owning = new Set();
    for (const path of paths) {
      const match = roots.find((r) => path === r.dir || path.startsWith(`${r.dir}/`));
      if (match) owning.add(match.id);
      else unattributed.push(`${controller} <- ${path || "(no source recorded)"}`);
    }
    if (owning.size > 1)
      failures.push(
        `SPLIT CONTROLLER: manifest controller ${controller} has implementations under more than one scan root (${[...owning].sort().join(", ")}); one class cannot be attributed to two roots.`,
      );
    for (const id of owning) {
      const bucket = byRoot.get(id);
      bucket.ops += counts.ops;
      bucket.controllers.add(controller);
    }
  }
  if (unattributed.length > 0)
    failures.push(
      `UNDECLARED SCAN ROOT: ${unattributed.length} manifest route-implementation source(s) fall outside every declared root (${roots.map((r) => r.dir).join(", ")}): ${unattributed.sort().slice(0, 8).join("; ")}. Declare the root in SCAN_ROOTS, or the surface is ungoverned.`,
    );

  // Per-root identity: globbed decorators × mount multiplier === manifest ops.
  const table = roots.map((root) => {
    const expanded = root.parsed.reduce(
      (sum, c) => sum + c.routes * (indep[c.className]?.basePaths ?? c.basePaths ?? 1),
      0,
    );
    const bucket = byRoot.get(root.id);
    const ok = expanded === bucket.ops;
    if (!ok)
      failures.push(
        `SCAN ROOT DRIFT: ${root.id} (${root.dir}) — ${root.controllers} globbed controller(s) carry ${root.decorators} decorator(s) expanding to ${expanded} operation(s), but the manifest attributes ${bucket.ops} operation(s) to that root.`,
      );
    return {
      id: root.id,
      dir: root.dir,
      why: root.why,
      present: root.present,
      sourceControllers: root.controllers,
      sourceDecorators: root.decorators,
      expandedOperations: expanded,
      manifestOperations: bucket.ops,
      manifestControllers: bucket.controllers.size,
      ok,
    };
  });

  for (const declared of edge) {
    if (!declared.present) {
      failures.push(
        `PROCESS-EDGE EXCLUSION DRIFT: ${declared.file} is named as an excluded process-edge controller but is not on disk; delete the exclusion or restore the file.`,
      );
      continue;
    }
    const o = declared.observed;
    if (o.className !== declared.controller)
      failures.push(
        `PROCESS-EDGE EXCLUSION DRIFT: ${declared.file} declares class ${o.className}, not the excluded ${declared.controller}.`,
      );
    if (o.routes !== declared.routes)
      failures.push(
        `PROCESS-EDGE EXCLUSION DRIFT: ${declared.file} now carries ${o.routes} route decorator(s); the exclusion is written for exactly ${declared.routes} process probes. Business surface must not be parked in the process edge.`,
      );
    if (declared.emptyBasePath && !o.emptyBasePath)
      failures.push(
        `PROCESS-EDGE EXCLUSION DRIFT: ${declared.file} no longer declares an EMPTY @Controller() argument list, so it is no longer pinned off the versioned surface; it must be scanned as a transport instead of excluded.`,
      );
  }

  return { ok: failures.length === 0, failures, table };
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
      scanRoot: i.scanRoot ?? null,
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
  const roots = scanRootReport();
  const edge = processEdgeReport();
  const man = manifestCensus();
  const indep = independentCensus(roots);
  const r = reconcile(indep, man);
  const s = reconcileScanRoots(roots, edge, man, indep);
  const failures = [...r.failures, ...s.failures];
  return {
    milestone: "M0.9",
    issue: "WIN-294",
    title: "Independent REST census — second enumerator reconciled to the generated manifest",
    mechanism:
      "Independent in ENUMERATION: discovers controllers by GLOBBING every declared scan root (file presence, NOT the generator's CONTROLLER_MODULE_MAP allowlist) and parses @Controller base paths, route decorators, and requireOperator guards directly from source. The committed manifest is read ONLY to reconcile counts, never to enumerate — so a controller the generator's allowlist misses still appears here and fails --check.",
    scanRoots: SCAN_ROOTS.map((r0) => ({ id: r0.id, dir: r0.dir, why: r0.why })),
    reconciliation: {
      routes:
        "independentUniqueRoutes + dualMountAliasOps === manifestOps; every controller's manifest ops === decorators × mount-multiplier.",
      operator:
        "manifestOperator >= independentOperatorFloor per controller (wrapper/inherited operator enforcement legitimately lifts the manifest above the direct-call floor).",
      omission:
        "a production controller found by glob but absent from the manifest FAILS --check.",
      scanRoots:
        "every manifest route-implementation source falls under a DECLARED scan root, and each root's globbed decorators (expanded by mount multiplier) equal the manifest operations attributed to it. A surface built in a directory this census does not scan fails as UNDECLARED SCAN ROOT.",
      processEdge:
        "the named process-edge exclusions are measured, not assumed: the excluded file must exist, keep an EMPTY @Controller() argument list, and carry exactly the declared number of probes.",
    },
    totals: { ...r.totals, scanRoots: s.table },
    processEdgeExclusions: edge.map((e) => ({
      file: e.file,
      controller: e.controller,
      declaredRoutes: e.routes,
      observedRoutes: e.observed?.routes ?? null,
      emptyBasePath: e.observed?.emptyBasePath ?? null,
      why: e.why,
    })),
    table: r.table,
    ok: failures.length === 0,
    failures,
  };
}

function main() {
  const check = process.argv.includes("--check");
  const fresh = build();
  fresh.sourceDigest = sha256(JSON.stringify({ table: fresh.table, totals: fresh.totals }));
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
      `rest-census-independent: OK. ${fresh.totals.controllers} controllers, independent unique routes ${fresh.totals.independentUniqueRoutes} + ${fresh.totals.dualMountAliasOps} dual-mount = ${fresh.totals.manifestOps} manifest ops; operator floor ${fresh.totals.independentOperatorFloor} <= manifest ${fresh.totals.manifestOperator}; scan roots ${fresh.totals.scanRoots.map((t) => `${t.id}=${t.manifestOperations}`).join(" + ")}.`
    );
    return;
  }
  writeFileSync(OUT, out);
  console.error(
    `rest-census-independent: wrote ${relative(ROOT, OUT)} — ${fresh.totals.controllers} controllers, ${fresh.totals.manifestOps} ops, operator ${fresh.totals.manifestOperator}, ${fresh.totals.scanRoots.length} scan roots.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
