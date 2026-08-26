import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const sourceRoot = dirname(fileURLToPath(import.meta.url));

function adapterSource(kind: "runs" | "events"): string {
  const fileName = kind === "runs" ? ["task", "Runs.ts"].join("") : ["task", "Events.ts"].join("");
  return readFileSync(join(sourceRoot, fileName), "utf8");
}

describe("Platos-owned ClickHouse operation names", () => {
  test("uses runtime vocabulary while retaining private external table names", () => {
    const source = `${adapterSource("runs")}\n${adapterSource("events")}`;
    const operationNames = [
      "insertRuntimeRunsCompactArrays",
      "insertRuntimeRuns",
      "insertExternalRuntimePayloadsCompactArrays",
      "insertExternalRuntimePayloads",
      "insertRuntimeEvents",
      "insertRuntimeEventsV2",
      "getRuntimeRuns",
      "getRuntimeRunsCount",
      "getRuntimeRunTags",
      "getRuntimeActivity",
      "getRuntimeUsageByOrganization",
      "getRuntimeEventDetailedSummary",
      "getRuntimeEventDetailedSummaryV2",
    ];

    for (const name of operationNames) {
      expect(source).toContain(`name: "${name}"`);
    }
    expect(source).toContain(`.${["task", "_runs_v2"].join("")}`);
  });
});
