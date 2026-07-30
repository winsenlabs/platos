#!/usr/bin/env node

// Cross-platform generation script for the llm-pricing package.
// Generates TypeScript modules from JSON data files:
//   1. defaultPrices.ts   ← default-model-prices.json (synced from Langfuse)
//   2. modelCatalog.ts    ← model-catalog.json (our maintained catalog metadata)
//
// Usage: node scripts/generate.mjs
//
// To update the source JSON files:
//   - Pricing:  pnpm run sync-prices  (fetches from Langfuse, requires curl)
//   - Catalog:  pnpm run generate-catalog  (uses Claude CLI to research models)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, "..", "src");

// --- 1. Generate defaultPrices.ts from default-model-prices.json ---

const pricesJsonPath = join(srcDir, "default-model-prices.json");

if (existsSync(pricesJsonPath)) {
  const raw = JSON.parse(readFileSync(pricesJsonPath, "utf-8"));
  const stripped = raw.map((e) => ({
    modelName: e.modelName.trim(),
    matchPattern: e.matchPattern,
    startDate: e.createdAt,
    pricingTiers: e.pricingTiers.map((t) => ({
      name: t.name,
      isDefault: t.isDefault,
      priority: t.priority,
      conditions: t.conditions.map((c) => ({
        usageDetailPattern: c.usageDetailPattern,
        operator: c.operator,
        value: c.value,
      })),
      prices: t.prices,
    })),
  }));

  // Apply local price corrections on top of the upstream sync. Upstream is
  // fetched verbatim, so a wrong value there cannot be fixed by editing the JSON
  // — the next sync-prices would revert it. See src/price-overrides.json.
  const overridesPath = join(srcDir, "price-overrides.json");
  let appliedOverrides = 0;
  if (existsSync(overridesPath)) {
    const { overrides = [] } = JSON.parse(readFileSync(overridesPath, "utf-8"));
    for (const ov of overrides) {
      const model = stripped.find((m) => m.modelName === ov.modelName);
      if (!model) {
        throw new Error(
          `price-overrides.json targets unknown model "${ov.modelName}". ` +
            `Upstream may have renamed or dropped it — update or remove the override.`,
        );
      }
      const tier = model.pricingTiers.find((t) => t.name === ov.tierName);
      if (!tier) {
        throw new Error(
          `price-overrides.json targets unknown tier "${ov.tierName}" on "${ov.modelName}". ` +
            `Known tiers: ${model.pricingTiers.map((t) => t.name).join(", ")}.`,
        );
      }
      for (const [key, value] of Object.entries(ov.prices)) {
        if (!(key in tier.prices)) {
          throw new Error(
            `price-overrides.json targets unknown price key "${key}" on ` +
              `"${ov.modelName}" / "${ov.tierName}". Remove it or pick a real key.`,
          );
        }
        if (tier.prices[key] === value) {
          // Upstream has caught up. Fail loudly rather than silently no-op, so
          // stale overrides get deleted instead of accumulating forever.
          throw new Error(
            `price-overrides.json override for "${ov.modelName}" / "${ov.tierName}" / ` +
              `"${key}" is now REDUNDANT — upstream already has ${value}. Delete the override.`,
          );
        }
        console.log(
          `  override: ${ov.modelName} [${ov.tierName}] ${key}: ${tier.prices[key]} -> ${value}`,
        );
        tier.prices[key] = value;
        appliedOverrides++;
      }
    }
  }

  let out = 'import type { DefaultModelDefinition } from "./types.js";\n\n';
  out += "// Auto-generated from default-model-prices.json — do not edit manually.\n";
  out += "// Run `pnpm run sync-prices` to update the JSON, then `pnpm run generate` to regenerate.\n";
  out += "// Source: https://github.com/langfuse/langfuse\n";
  out += "// Local corrections from price-overrides.json are applied on top of that source.\n\n";
  out += "export const defaultModelPrices: DefaultModelDefinition[] = ";
  out += JSON.stringify(stripped, null, 2) + ";\n";

  writeFileSync(join(srcDir, "defaultPrices.ts"), out);
  console.log(
    `Generated defaultPrices.ts (${stripped.length} models, ${appliedOverrides} local override(s))`,
  );
} else {
  console.log("Skipping defaultPrices.ts — default-model-prices.json not found");
}

// --- 2. Generate modelCatalog.ts from model-catalog.json ---

const catalogJsonPath = join(srcDir, "model-catalog.json");

if (existsSync(catalogJsonPath)) {
  const data = JSON.parse(readFileSync(catalogJsonPath, "utf-8"));

  // Backfill missing fields for old entries
  for (const key of Object.keys(data)) {
    if (data[key].releaseDate === undefined) data[key].releaseDate = null;
    if (data[key].isHidden === undefined) data[key].isHidden = false;
    if (data[key].supportsStructuredOutput === undefined) data[key].supportsStructuredOutput = false;
    if (data[key].supportsParallelToolCalls === undefined) data[key].supportsParallelToolCalls = false;
    if (data[key].supportsStreamingToolCalls === undefined) data[key].supportsStreamingToolCalls = false;
    if (data[key].deprecationDate === undefined) data[key].deprecationDate = null;
    if (data[key].knowledgeCutoff === undefined) data[key].knowledgeCutoff = null;
    if (data[key].resolvedAt === undefined) data[key].resolvedAt = new Date().toISOString();
    {
      // Always recompute base model name (don't trust existing values)
      // Strip trailing date (-YYYYMMDD or -YYYY-MM-DD) and -latest suffix
      // Keep original naming (dots, etc.) — don't normalize
      let base = key.replace(/-\d{4}-?\d{2}-?\d{2}$/, "").replace(/-latest$/, "");
      data[key].baseModelName = base !== key ? base : null;
    }
  }

  let out = 'import type { ModelCatalogEntry } from "./types.js";\n\n';
  out += "// Auto-generated from model-catalog.json — do not edit manually.\n";
  out += "// Run `pnpm run generate-catalog` to update the JSON, then `pnpm run generate` to regenerate.\n\n";
  out += "export const modelCatalog: Record<string, ModelCatalogEntry> = ";
  out += JSON.stringify(data, null, 2) + ";\n";

  writeFileSync(join(srcDir, "modelCatalog.ts"), out);
  console.log(`Generated modelCatalog.ts (${Object.keys(data).length} entries)`);
} else {
  console.log("Skipping modelCatalog.ts — model-catalog.json not found");
}
