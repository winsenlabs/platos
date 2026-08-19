import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const distRoot = resolve(import.meta.dirname, "../dist");
const forbidden = ["@platos/database", "@platos/sdk", "@prisma/client"];
const failures = [];

for (const path of walk(distRoot)) {
  if (!path.endsWith(".js")) continue;
  const source = readFileSync(path, "utf8");
  for (const dependency of forbidden) {
    const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const importPattern = new RegExp(
      String.raw`(?:require\s*\(|import\s*\(|from\s+)["']${escaped}(?:\/[^"']+)?["']`
    );
    if (importPattern.test(source)) {
      failures.push(`${relative(distRoot, path)} imports ${dependency}`);
    }
  }
}

if (failures.length) {
  console.error("agent-production-dependency-audit failed:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`agent-production-dependency-audit: no forbidden imports in ${distRoot}`);

function* walk(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}
