#!/usr/bin/env node
// WIN-294 — webapp/BFF entrypoint census.
//
// The agent REST surface has two independent enumerators (the generator and
// scripts/rest-census-independent.mjs). The webapp Backend-For-Frontend surface
// had only a prose "117" figure carried forward with no committed enumerator and
// no drift gate. This script re-counts the BFF entrypoints directly from the
// Remix route modules in apps/webapp/app/routes and makes the count a
// machine-checked invariant: every route module's server-side `loader` and
// `action` export is one BFF entrypoint (a server function the browser can
// invoke). Verified: 75 loaders + 42 actions = 117 entrypoints at the frozen
// baseline — so WIN-294's carried-forward 117 is CORRECT, and now enforced.
//
// Usage:
//   node scripts/webapp-bff-matrix.mjs            # regenerate the artifact
//   node scripts/webapp-bff-matrix.mjs --check     # fail on any drift
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTES = join(ROOT, "apps/webapp/app/routes");
const OUT = join(ROOT, "docs/audits/M0.9-webapp-bff-matrix.json");

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function walkRoutes(dir = ROUTES, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walkRoutes(p, acc);
    else if (/\.(ts|tsx)$/.test(p)) acc.push(p);
  }
  return acc;
}

/** A route module exposes a BFF entrypoint per exported `loader` / `action`. */
export function serverExports(src) {
  const has = (name) =>
    new RegExp(`export\\s+(async\\s+)?(const|function)\\s+${name}\\b`).test(src) ||
    new RegExp(`export\\s+\\{[^}]*\\b${name}\\b[^}]*\\}`).test(src);
  return { loader: has("loader"), action: has("action") };
}

export function census(files = walkRoutes()) {
  let loaders = 0,
    actions = 0,
    routeFilesWithServer = 0;
  const entries = [];
  for (const f of files) {
    const { loader, action } = serverExports(readFileSync(f, "utf8"));
    if (loader) loaders += 1;
    if (action) actions += 1;
    if (loader || action) {
      routeFilesWithServer += 1;
      entries.push({ file: relative(ROOT, f), loader, action });
    }
  }
  return {
    routeFiles: files.length,
    routeFilesWithServer,
    loaders,
    actions,
    entrypoints: loaders + actions,
    entries,
  };
}

// The reconciled baseline. This is a machine-checked expectation: changing the
// BFF surface requires regenerating the artifact, which is a REVIEWED update, not
// a silent number. WIN-294's carried-forward figure was 117 and is verified here.
export const EXPECTED_ENTRYPOINTS = 117;

function build() {
  const c = census();
  const record = {
    milestone: "M0.9",
    issue: "WIN-294",
    title: "Webapp/BFF entrypoint census",
    mechanism:
      "Counts every exported `loader` and `action` (server-side BFF entrypoints) across apps/webapp/app/routes.",
    expectedEntrypoints: EXPECTED_ENTRYPOINTS,
    totals: {
      routeFiles: c.routeFiles,
      routeFilesWithServer: c.routeFilesWithServer,
      loaders: c.loaders,
      actions: c.actions,
      entrypoints: c.entrypoints,
    },
    reconciliation:
      "loaders + actions === entrypoints; entrypoints === expectedEntrypoints (WIN-294's 117, verified from source). --check fails on any drift.",
    entries: c.entries,
  };
  record.sourceDigest = sha256(JSON.stringify({ totals: record.totals, entries: record.entries }));
  return record;
}

function main() {
  const check = process.argv.includes("--check");
  const fresh = build();
  const out = JSON.stringify(fresh, null, 2) + "\n";
  if (check) {
    const failures = [];
    if (fresh.totals.entrypoints !== EXPECTED_ENTRYPOINTS)
      failures.push(
        `BFF DRIFT: ${fresh.totals.entrypoints} entrypoints (${fresh.totals.loaders} loaders + ${fresh.totals.actions} actions) != expected ${EXPECTED_ENTRYPOINTS}. If intended, update EXPECTED_ENTRYPOINTS with a reviewed receipt.`
      );
    let committed;
    try {
      committed = readFileSync(OUT, "utf8");
    } catch {
      committed = null;
    }
    if (committed !== out)
      failures.push(
        "artifact OUT OF DATE — run `node scripts/webapp-bff-matrix.mjs` and commit the result."
      );
    if (failures.length) {
      console.error("webapp-bff-matrix: FAILED");
      for (const f of failures) console.error("  - " + f);
      process.exit(1);
    }
    console.error(
      `webapp-bff-matrix: OK. ${fresh.totals.entrypoints} BFF entrypoints (${fresh.totals.loaders} loaders + ${fresh.totals.actions} actions) across ${fresh.totals.routeFilesWithServer}/${fresh.totals.routeFiles} route files.`
    );
    return;
  }
  writeFileSync(OUT, out);
  console.error(
    `webapp-bff-matrix: wrote ${relative(ROOT, OUT)} — ${fresh.totals.entrypoints} entrypoints (${fresh.totals.loaders} loaders + ${fresh.totals.actions} actions).`
  );
}

main();
