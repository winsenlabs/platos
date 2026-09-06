import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { findWrites, canonicalTables } from "./scripts/arch/sole-writer.mjs";

const root = process.cwd();
const dir = "packages/adapters/postgres-tenancy/src";
const tables = canonicalTables();
let total = 0;
for (const name of readdirSync(join(root, dir)).sort()) {
  if (!name.startsWith("providers-")) continue;
  const virtualPath = `${dir}/${name}`;
  const found = findWrites(virtualPath, readFileSync(join(root, virtualPath), "utf8"), tables);
  if (found.writes.length === 0 && found.unattributable.length === 0) continue;
  const counts = new Map();
  for (const w of found.writes) {
    const label = `${w.model}.${w.method}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  console.log(`${name}  (${found.writes.length})`);
  for (const [label, n] of [...counts].sort()) console.log(`    ${label} x${n}`);
  if (found.unattributable.length > 0) console.log("    UNATTRIBUTABLE", found.unattributable);
  total += found.writes.length;
}
console.log("providers total =", total);
