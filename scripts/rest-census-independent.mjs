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
//
// AND A SECOND ONE, WHICH WAS INVISIBLE UNTIL WIN-267 W3 (below).
export const PROCESS_EDGE_EXCLUSIONS = Object.freeze([
  Object.freeze({
    file: "apps/core-api/src/http/health.controller.ts",
    controller: "HealthController",
    routes: 3,
    allRoutes: 0,
    terminalCatchAll: false,
    emptyBasePath: true,
    why:
      "process-edge liveness/readiness probes (ADR M0.4 §2 keeps them off the versioned surface); no tenant, no scope, no use case.",
  }),
  // WIN-267 W3 — THE TERMINAL 404, WHICH NEITHER SCAN ROOT REACHED AND NO
  // EXCLUSION NAMED.
  //
  // `apps/core-api/src/http/not-found.controller.ts` is a route-bearing
  // controller. It sits in `apps/core-api/src/http`, and the declared roots are
  // `apps/agent/src` and `apps/core-api/src/transports` — so it fell between
  // them. Its sibling in the same directory had a measured tripwire; the handler
  // that answers EVERY unmatched path in the process had nothing, which is the
  // wrong way round: it is the one route whose reach is unbounded.
  //
  // IT IS EXCLUDED RATHER THAN SCANNED, for the same reason `HealthController`
  // is and for one more. It takes no tenant, resolves no scope and calls no use
  // case; it is `VERSION_NEUTRAL` on purpose, because under `defaultVersion` the
  // terminal handler would have moved to `/api/v1/{*path}` and `/does-not-exist`
  // would have got Express's HTML page instead of an M0.4 §2 envelope. And it is
  // not an OPERATION: scanning it would demand a manifest row, a capability and a
  // parity entry for "no route matched", which is a refusal, not a thing a client
  // can call.
  //
  // WHAT THE TRIPWIRE HAS TO CATCH IS THEREFORE DIFFERENT FROM ITS SIBLING'S.
  // `routes: 0` alone would not: this controller carries no
  // `@Get/@Post/@Put/@Patch/@Delete` today, and the way business surface would
  // arrive here is not a sixth method decorator but a NAMED path on the `@All` it
  // already has — `@All("organizations")` reads almost identically and would
  // serve every method of a real resource from a file nothing enumerates. So the
  // exclusion pins BOTH: zero method decorators, and exactly one `@All` whose
  // path is a bare wildcard. A named `@All`, a second `@All`, or any method
  // decorator fails `--check` by name.
  Object.freeze({
    file: "apps/core-api/src/http/not-found.controller.ts",
    controller: "NotFoundController",
    routes: 0,
    allRoutes: 1,
    terminalCatchAll: true,
    emptyBasePath: true,
    why:
      "the terminal 404: the LAST-registered handler, answering every unmatched path in the process with the M0.4 §2 envelope. No tenant, no scope, no use case, and no operation a client can call — a refusal, not surface.",
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
  // WIN-267 (M4.1) T1 moved the version out of the decorator, so these now read
  // `@Controller({ path: [...], version })`. The alias count is unchanged; only
  // the spelling of the base paths moved, and `parseController` below reads both
  // spellings so this census keeps deriving the multiplier from source.
  DocsMcpController: 2, // path: ["mcp/docs", "mcp"] — canonical + install URL
  MemoryController: 2, // path: ["memory", "platos/memory"] — legacy alias
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
  //
  // TWO SPELLINGS, ONE MEANING (WIN-267 T1). Before T1 every base path was the
  // decorator's first argument: `@Controller("api/v1/agent")` or
  // `@Controller([...])`. T1 moved the version onto the class, and Nest 11's
  // standalone `@Version` is method-only — it dereferences `descriptor.value`
  // and throws on a class — so the class-level version has to travel in
  // `@Controller({ path, version })`. The base path is then the `path` property.
  // Both spellings are read here, from source, so the multiplier stays DERIVED
  // and a future alias is still picked up without a hardcoded number.
  const argument = (/@Controller\s*\(([^\n]*)$/m.exec(src) || [])[1] ?? "";
  const pathArgument = /\bpath\s*:\s*(\[[^\]]*\]|["'`][^"'`]*["'`])/.exec(argument)?.[1] ?? null;
  const positional = /^\s*(\[[^\]]*\]|["'`][^"'`]*["'`])/.exec(argument)?.[1] ?? null;
  const declaredPath = pathArgument ?? positional;
  const basePaths = declaredPath
    ? Math.max(1, (declaredPath.match(/["'`][^"'`]*["'`]/g) || []).length)
    : 1;
  // Whether the @Controller(...) call declares NO base path — the shape that
  // pins a controller to the application root and therefore off the versioned
  // surface. `@Controller()` and `@Controller({ version: VERSION_NEUTRAL })` are
  // the same statement about the URL; only the version travels differently.
  // Read only by the process-edge exclusion tripwire.
  const emptyBasePath = /@Controller\s*\(/.test(src) && declaredPath === null;
  // Line-anchored HTTP method decorators. This matches the manifest's per-route
  // counting and ignores decorator names appearing inside comments or strings.
  const routes = (src.match(/^\s*@(Get|Post|Put|Patch|Delete)\s*\(/gm) || []).length;
  // `@All` IS COUNTED SEPARATELY, AND ONLY WIN-267 W3 NEEDED IT TO BE. It is not
  // folded into `routes` above because that count is joined to the MANIFEST's
  // per-route operations, and no manifest row exists for a catch-all; adding it
  // there would have made every scan-root identity fail rather than making the
  // terminal handler visible. It is measured here so the process-edge tripwire
  // can pin the SHAPE of the catch-all — see PROCESS_EDGE_EXCLUSIONS.
  //
  // The path is captured so a NAMED `@All` can be told from a wildcard one. A
  // wildcard is `@All("*")` or `@All("{*name}")`, with or without a leading slash
  // — Express 4 spelt it the first way and Express 5 / path-to-regexp 8 spell it
  // the second, and both are read so a framework bump does not silently turn this
  // tripwire into a rubber stamp. `@All()` with NO argument is NOT a wildcard: it
  // binds the controller's base path exactly, which on an empty base path is `/`
  // — one specific route, not every unmatched one.
  const allPaths = [...src.matchAll(/^\s*@All\s*\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/gm)].map(
    (match) => match[1] ?? "",
  );
  const allRoutes = allPaths.length;
  const nonWildcardAllRoutes = allPaths.filter((path) => !/^\/?(?:\*|\{\*[A-Za-z0-9_]+\})$/u.test(path))
    .length;
  // Operator LOWER BOUND: direct requireOperator(...) invocations. Controllers
  // that guard many handlers through one shared wrapper (e.g. getOperatorScope)
  // legitimately show a lower floor than the manifest's semantic count — that is
  // an inequality the reconciliation permits, never an equality it forces.
  const requireOperator = (src.match(/requireOperator\s*\(/g) || []).length;
  return { className, basePaths, emptyBasePath, routes, allRoutes, nonWildcardAllRoutes, requireOperator };
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

/**
 * The application `src` directory a declared scan root sits inside.
 *
 * DERIVED, NEVER DECLARED. A second hand-maintained list of directories would be
 * a second thing to forget, and forgetting is the whole defect this function
 * exists to close. `apps/agent/src` is its own application root;
 * `apps/core-api/src/transports` belongs to `apps/core-api/src`.
 */
export function applicationRootOf(dir) {
  const parts = dir.split("/");
  const index = parts.indexOf("src");
  return index < 0 ? dir : parts.slice(0, index + 1).join("/");
}

/**
 * EVERY route-bearing controller in every scanned application, and whether
 * anything accounts for it (WIN-267 W3).
 *
 * THIS IS THE JOIN THE CENSUS WAS MISSING, and `not-found.controller.ts` is the
 * proof it was missing. Until now the exclusion list was checked ONE WAY: each
 * named file must exist and keep its shape. Nothing checked the other direction
 * — that every controller file in a scanned application is either under a
 * declared root or named in the list — so a controller could sit in
 * `apps/core-api/src/http` and be accounted for by NOTHING, which is exactly what
 * the terminal 404 did for two tranches. An exclusion list that only validates
 * its own entries is a list that can never notice an omission, which is lesson 1
 * in this repository's own words: an assertion comparing two things you control
 * cannot fail.
 *
 * It sweeps the APPLICATION root rather than the scan root, so the complement is
 * a real set of files on disk rather than a restatement of the roots.
 */
export function unscannedControllerReport(
  root = ROOT,
  roots = SCAN_ROOTS,
  exclusions = PROCESS_EDGE_EXCLUSIONS,
) {
  const applicationRoots = [...new Set(roots.map((declared) => applicationRootOf(declared.dir)))].sort();
  const excused = new Set(exclusions.map((declared) => declared.file));
  const unscanned = [];
  for (const application of applicationRoots) {
    for (const file of walkControllers(join(root, application))) {
      const path = relative(root, file).split("\\").join("/");
      const scanned = roots.some(
        (declared) => path === declared.dir || path.startsWith(`${declared.dir}/`),
      );
      if (scanned || excused.has(path)) continue;
      unscanned.push(path);
    }
  }
  return { applicationRoots, unscanned: unscanned.sort() };
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
  // WIN-268 (M4.2) P1 — HOW MANY BINDINGS ARE THE SAME OPERATION SERVED TWICE.
  //
  // `totalOps` counts route BINDINGS: one per implementation, which is what the
  // independent decorator scan can corroborate, because a decorator is a
  // binding. The manifest's `restOperations` counts unique method/path pairs.
  // The two were equal until an operation was served by BOTH deployables, and
  // the difference is exactly that: the two MCP token mints, which `apps/agent`
  // has served since before V1 and `apps/core-api` now serves as well because
  // that is the process the `Idempotency-Key` gate runs in.
  //
  // Counting the SURPLUS bindings rather than the shared operations is what
  // makes the identity below hold for an operation served three times as well
  // as twice, which is the shape a longer migration would produce.
  let crossRootBindings = 0;
  // The same surplus, restricted to the OPERATOR-PROTECTED bindings, because the
  // operator sub-denominator is reconciled separately and would otherwise
  // inherit the same over-count.
  let crossRootOperatorBindings = 0;
  for (const op of m.inventories.restOperations) {
    const implementations = op.implementations || [];
    const roots = new Set(
      implementations.map((impl) =>
        String(impl.source ?? "").split("\\").join("/").startsWith("apps/core-api/")
          ? "core-api"
          : "agent",
      ),
    );
    if (roots.size > 1) {
      crossRootBindings += implementations.length - 1;
      const guarded = implementations.filter((impl) => impl.requiresOperator).length;
      // One operation is one operator-protected operation however many
      // deployables serve it, so the surplus is every guarded binding past the
      // first. An operation guarded in ONE deployable and not the other
      // contributes no surplus and is therefore still counted once — which is
      // the honest answer while a migration is half-done.
      if (guarded > 0) crossRootOperatorBindings += guarded - 1;
    }
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
  return { controllers, sources, totalOps, totalOperator, crossRootBindings, crossRootOperatorBindings };
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
  sweep = unscannedControllerReport(),
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

  // THE COMPLEMENT. Anything route-bearing inside a scanned application that no
  // root reaches and no exclusion names is ungoverned by NAME, which is a stronger
  // statement than "the roots reconcile" — the roots reconciled perfectly while
  // the terminal 404 sat outside all of them.
  for (const path of sweep.unscanned)
    failures.push(
      `UNSCANNED ROUTE-BEARING CONTROLLER: ${path} lives inside a scanned application (${sweep.applicationRoots.join(", ")}) but under no declared scan root (${roots.map((r) => r.dir).join(", ")}) and named in no process-edge exclusion. Move it under a root, or name it in PROCESS_EDGE_EXCLUSIONS with a tripwire.`,
    );

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
    // THE CATCH-ALL SHAPE (WIN-267 W3). `routes` above counts only
    // `@Get/@Post/@Put/@Patch/@Delete`, so a file whose whole surface is `@All`
    // passes it at zero no matter what path the `@All` names. Both halves are
    // pinned here: how many `@All` decorators the file may carry, and — for the
    // terminal handler — that each one is a bare wildcard. `@All("organizations")`
    // is business surface answering every HTTP method from a file nothing
    // enumerates, and it is the mutation this pair exists to kill.
    if (o.allRoutes !== declared.allRoutes)
      failures.push(
        `PROCESS-EDGE EXCLUSION DRIFT: ${declared.file} now carries ${o.allRoutes} @All decorator(s); the exclusion is written for exactly ${declared.allRoutes}.`,
      );
    if (declared.terminalCatchAll && o.nonWildcardAllRoutes > 0)
      failures.push(
        `PROCESS-EDGE EXCLUSION DRIFT: ${declared.file} declares ${o.nonWildcardAllRoutes} @All decorator(s) whose path is not a bare wildcard. It is excluded as the terminal catch-all — the handler that answers every unmatched path — and any other path makes it a business route answering every HTTP method from a file no enumerator can see.`,
      );
  }

  return { ok: failures.length === 0, failures, table, unscanned: sweep };
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
    /**
     * WIN-268 P1. The surplus bindings of operations served by BOTH deployables,
     * and the unique-operation count they reconcile to.
     *
     * `differential-coverage.mjs` compares this census's denominator against the
     * capability matrix's, and the matrix counts unique method/path pairs while
     * this census counts bindings. Publishing BOTH numbers and their difference
     * is what lets that comparison stay an equality rather than becoming a
     * tolerance — and it names the shared set instead of hiding it.
     */
    crossRootBindings: man.crossRootBindings,
    uniqueOperations: man.totalOps - man.crossRootBindings,
    crossRootOperatorBindings: man.crossRootOperatorBindings,
    uniqueOperatorOperations: man.totalOperator - man.crossRootOperatorBindings,
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
        "independentUniqueRoutes + dualMountAliasOps === manifestOps; manifestOps - crossRootBindings === uniqueOperations, the denominator the capability matrix publishes; every controller's manifest ops === decorators × mount-multiplier.",
      operator:
        "manifestOperator >= independentOperatorFloor per controller (wrapper/inherited operator enforcement legitimately lifts the manifest above the direct-call floor).",
      omission:
        "a production controller found by glob but absent from the manifest FAILS --check.",
      scanRoots:
        "every manifest route-implementation source falls under a DECLARED scan root, and each root's globbed decorators (expanded by mount multiplier) equal the manifest operations attributed to it. A surface built in a directory this census does not scan fails as UNDECLARED SCAN ROOT.",
      processEdge:
        "the named process-edge exclusions are measured, not assumed: the excluded file must exist, keep an EMPTY @Controller() argument list, carry exactly the declared number of probes, and carry exactly the declared number of @All decorators — each a bare wildcard where the exclusion is the terminal catch-all.",
      unscannedControllers:
        "the exclusion list is joined to the tree in BOTH directions. Every *.controller.ts inside a scanned application's src/ must be under a declared scan root or named in PROCESS_EDGE_EXCLUSIONS; anything else fails as UNSCANNED ROUTE-BEARING CONTROLLER. Without this half a controller can be accounted for by nothing at all, which is what apps/core-api/src/http/not-found.controller.ts was until WIN-267 W3.",
    },
    totals: { ...r.totals, scanRoots: s.table },
    applicationRoots: s.unscanned.applicationRoots,
    unscannedControllers: s.unscanned.unscanned,
    processEdgeExclusions: edge.map((e) => ({
      file: e.file,
      controller: e.controller,
      declaredRoutes: e.routes,
      observedRoutes: e.observed?.routes ?? null,
      declaredAllRoutes: e.allRoutes,
      observedAllRoutes: e.observed?.allRoutes ?? null,
      observedNonWildcardAllRoutes: e.observed?.nonWildcardAllRoutes ?? null,
      terminalCatchAll: e.terminalCatchAll,
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
