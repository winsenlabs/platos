import type { BuildExtension } from "@trigger.dev/core/v3/build";
import { builtinModules, createRequire } from "node:module";
import { isAbsolute, join } from "node:path";

type MetafileImport = {
  external?: boolean;
  path: string;
};

type MetafileOutput = {
  imports?: MetafileImport[];
};

export type WorkerMetafile = {
  outputs: Record<string, MetafileOutput>;
};

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

function isBareRuntimeImport(importPath: string): boolean {
  return (
    !builtins.has(importPath) &&
    !importPath.startsWith(".") &&
    !isAbsolute(importPath) &&
    !importPath.startsWith("file:")
  );
}

/**
 * Imports whose absence is the normal case, not a packaging mistake.
 *
 * The check below exists because a bare external that cannot resolve becomes a
 * MODULE_NOT_FOUND once the generated worker runs. These three never do: each
 * is loaded inside a try/catch by a dependency that has a working fallback, so
 * requiring them to resolve would fail the build over a module the worker is
 * designed to run without.
 *
 *   bufferutil, utf-8-validate  `ws` native performance addons. It requires
 *                               them in a try/catch and falls back to its JS
 *                               implementations. Both are optional
 *                               dependencies, so pnpm may legitimately not
 *                               install them.
 *   pnpapi                      Yarn Plug'n'Play's runtime module, referenced
 *                               by resolver code that first checks whether it
 *                               is running under PnP. This repo uses pnpm, so
 *                               it never exists — and declaring it a
 *                               dependency is not possible, since no such
 *                               package is published.
 *
 * Keep this list closed. Anything added here is a module the worker will run
 * without, which is a claim worth making one import at a time.
 */
const optionalRuntimeExternals = new Set([
  "bufferutil",
  "utf-8-validate",
  "pnpapi",
]);

/**
 * Trigger's worker bundle can leave packages external (including packages in
 * Trigger's own forced `alwaysExternal` list). Those imports execute from the
 * generated worker directory, so they must also resolve from this package's
 * production dependency tree rather than only from an npx/CLI cache.
 */
export function unresolvedGeneratedWorkerExternals(
  metafile: WorkerMetafile,
  workingDir: string
): string[] {
  const requireFromProject = createRequire(join(workingDir, "package.json"));
  const externalImports = new Set<string>();

  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports ?? []) {
      if (
        imported.external &&
        isBareRuntimeImport(imported.path) &&
        !optionalRuntimeExternals.has(imported.path)
      ) {
        externalImports.add(imported.path);
      }
    }
  }

  return [...externalImports]
    .filter((importPath) => {
      try {
        requireFromProject.resolve(importPath);
        return false;
      } catch {
        return true;
      }
    })
    .sort();
}

/**
 * Fail the esbuild result before Trigger indexes or launches a worker whose
 * emitted bare externals cannot resolve from apps/agent. This turns a late
 * generated-worker MODULE_NOT_FOUND into a deterministic build failure.
 */
export function generatedWorkerExternalsMustResolve(): BuildExtension {
  return {
    name: "platos-generated-worker-externals",
    onBuildStart(context) {
      context.registerPlugin(
        {
          name: "platos-generated-worker-externals",
          setup(build) {
            build.onEnd((result) => {
              if (!result.metafile) {
                return;
              }

              const unresolved = unresolvedGeneratedWorkerExternals(
                result.metafile as WorkerMetafile,
                context.workingDir
              );
              if (unresolved.length === 0) {
                return;
              }

              return {
                errors: unresolved.map((importPath) => ({
                  text:
                    `Generated Trigger worker external "${importPath}" cannot resolve from ` +
                    `${context.workingDir}. Declare it as a production dependency at the worker ` +
                    "package boundary or change the build externalization decision.",
                })),
              };
            });
          },
        },
        { target: context.target, placement: "last" }
      );
    },
  };
}
