import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  unresolvedGeneratedWorkerExternals,
  type WorkerMetafile,
} from "./trigger-worker-externals";

const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function metafileWithExternal(path: string): WorkerMetafile {
  return {
    outputs: {
      "worker.mjs": {
        imports: [{ external: true, path }],
      },
    },
  };
}

describe("generated Trigger worker externals", () => {
  it("keeps Trigger's forced OpenTelemetry hook external package-owned", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(agentDir, "package.json"), "utf8")
    ) as { dependencies?: Record<string, string> };

    expect(packageJson.dependencies?.["import-in-the-middle"]).toBe("3.0.1");
    expect(
      unresolvedGeneratedWorkerExternals(
        metafileWithExternal("import-in-the-middle"),
        agentDir
      )
    ).toEqual([]);
  });

  it("reports unresolved emitted bare externals", () => {
    expect(
      unresolvedGeneratedWorkerExternals(
        metafileWithExternal("not-a-real-trigger-worker-package"),
        agentDir
      )
    ).toEqual(["not-a-real-trigger-worker-package"]);
  });

  it("does not treat Node builtins as package externals", () => {
    expect(
      unresolvedGeneratedWorkerExternals(metafileWithExternal("node:crypto"), agentDir)
    ).toEqual([]);
  });

  it("tolerates optional externals the worker is designed to run without", () => {
    // Trigger's build emits these as bare externals, but each is loaded inside
    // a try/catch by a dependency with a working fallback. Failing the build
    // over them blocked every task deploy: ws's two native addons are optional
    // dependencies pnpm may not install, and pnpapi is a Yarn PnP module that
    // is not a publishable package at all.
    for (const optional of ["bufferutil", "utf-8-validate", "pnpapi"]) {
      expect(
        unresolvedGeneratedWorkerExternals(metafileWithExternal(optional), agentDir),
        optional
      ).toEqual([]);
    }
  });

  it("still reports a genuinely missing external alongside optional ones", () => {
    // The allowlist must narrow the check, not disable it.
    expect(
      unresolvedGeneratedWorkerExternals(
        {
          outputs: {
            "worker.js": {
              imports: [
                { external: true, path: "bufferutil" },
                { external: true, path: "not-a-real-trigger-worker-package" },
              ],
            },
          },
        },
        agentDir
      )
    ).toEqual(["not-a-real-trigger-worker-package"]);
  });
});
