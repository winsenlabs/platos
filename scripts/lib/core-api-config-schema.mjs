// SPDX-License-Identifier: Apache-2.0
//
// The core-api configuration schema, as the process itself evaluates it.
//
// Gates that need to know which variables core-api reads, or which of them are
// secrets, must join to the field tables in apps/core-api/src/config rather than
// to a name pattern or a copied list: a pattern misses a connection string whose
// name says URL, and a copy drifts the first time a field is added. This module
// transpiles the config modules (TypeScript's own transpiler, no type check, no
// build output needed) into a private temporary directory, imports them, and
// returns every field the six sections declare, with the flags the process uses.
//
// A SECOND, INDEPENDENT COUNT keeps the loader honest. The number of `secret: true`
// properties in the source text must equal the number of secret fields the
// imported tables yield; a loader that silently lost a section, or a regex that
// silently lost a field, cannot agree with the other by accident.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

export const CORE_API_CONFIG_DIRECTORY = "apps/core-api/src/config";

function configSources(root) {
  const directory = join(root, CORE_API_CONFIG_DIRECTORY);
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts"))
    .sort()
    .map((entry) => ({ entry, text: readFileSync(join(directory, entry), "utf8") }));
}

/**
 * Every field core-api's configuration declares: the core section and every group
 * of the five platform sections, each as `{ name, secret, defaultValue, section }`.
 */
export async function loadCoreApiConfigFields(root) {
  const sources = configSources(root);
  const workspace = mkdtempSync(join(tmpdir(), "platos-core-api-config-"));
  try {
    writeFileSync(join(workspace, "package.json"), '{ "type": "module" }\n');
    for (const { entry, text } of sources) {
      const output = ts.transpileModule(text, {
        fileName: entry,
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      writeFileSync(join(workspace, entry.replace(/\.ts$/u, ".js")), output);
    }
    const schema = await import(pathToFileURL(join(workspace, "schema.js")).href);
    const platform = await import(pathToFileURL(join(workspace, "platform.js")).href);
    const fields = [
      ...schema.CORE_API_CONFIG_FIELDS.map((field) => ({ ...field, section: "core" })),
      ...platform.PLATFORM_SECTIONS.flatMap((section) =>
        section.groups.flatMap((group) =>
          schema.groupFields(group).map((field) => ({ ...field, section: `${section.id}.${group.id}` })),
        ),
      ),
    ].map(({ name, secret, defaultValue, section }) => Object.freeze({ name, secret, defaultValue, section }));
    const sourceSecretCount = sources.reduce(
      (count, { text }) => count + [...text.matchAll(/^\s*secret:\s*true,/gmu)].length,
      0,
    );
    return { fields, sourceSecretCount };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
