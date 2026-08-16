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
});
