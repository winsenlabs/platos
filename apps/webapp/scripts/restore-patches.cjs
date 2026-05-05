#!/usr/bin/env node
/**
 * Restore `pnpm.patchedDependencies` after `turbo prune --docker`.
 *
 * Turbo strips the field from the pruned root package.json (leaves an
 * empty `{}`), which silently skips every patch even when patches/ is
 * available. This script copies the field back from the original root
 * package.json, but ONLY for patches whose target package is actually
 * present in the pruned pnpm-lock.yaml. Patches for packages that got
 * pruned out (e.g. agent-only deps when building the webapp tree)
 * would otherwise trip ERR_PNPM_UNUSED_PATCH on install.
 *
 * Usage:
 *   node restore-patches.cjs <orig-root-pkg> <target-pkg> <lockfile>
 */

const fs = require("fs");

const [, , origPath, targetPath, lockPath] = process.argv;
if (!origPath || !targetPath || !lockPath) {
  console.error(
    "usage: restore-patches.cjs <orig-root-pkg> <target-pkg> <lockfile>",
  );
  process.exit(1);
}

const orig = JSON.parse(fs.readFileSync(origPath, "utf8"));
const target = JSON.parse(fs.readFileSync(targetPath, "utf8"));
const lockfile = fs.readFileSync(lockPath, "utf8");

const all = (orig.pnpm && orig.pnpm.patchedDependencies) || {};
const filtered = {};

for (const [key, val] of Object.entries(all)) {
  // patch keys look like "redlock@5.0.0-beta.2" or "@sentry/remix@9.46.0"
  // pnpm-lock.yaml entries reference packages by `name@version` or
  // `/name@version` so substring-matching `name@version` catches both.
  const lastAt = key.lastIndexOf("@");
  if (lastAt <= 0) continue; // malformed; skip
  const name = key.slice(0, lastAt);
  const version = key.slice(lastAt + 1);
  const needle = `${name}@${version}`;
  if (lockfile.includes(needle)) {
    filtered[key] = val;
  }
}

target.pnpm = target.pnpm || {};
target.pnpm.patchedDependencies = filtered;
fs.writeFileSync(targetPath, JSON.stringify(target, null, 2));

console.log(
  `restored patchedDependencies: ${Object.keys(filtered).length}/${Object.keys(all).length} ` +
    `entries kept (rest pruned out of webapp tree)`,
);
if (Object.keys(filtered).length > 0) {
  console.log(`  kept: ${Object.keys(filtered).join(", ")}`);
}
const dropped = Object.keys(all).filter((k) => !(k in filtered));
if (dropped.length > 0) {
  console.log(`  dropped: ${dropped.join(", ")}`);
}
