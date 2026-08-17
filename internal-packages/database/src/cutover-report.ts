import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertExternalCutoverReportFragment } from "./cutover-external";
import type { CutoverReport } from "./cutover-types";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)])
    );
  }
  return value;
}

export function serializeCutoverReport(report: CutoverReport): string {
  if (report.external !== undefined) assertExternalCutoverReportFragment(report.external);
  const unsigned = { ...report, reportSha256: undefined };
  const canonical = JSON.stringify(stable(unsigned));
  const reportSha256 = createHash("sha256").update(canonical).digest("hex");
  return `${JSON.stringify(stable({ ...unsigned, reportSha256 }), null, 2)}\n`;
}

export function writeCutoverReport(directory: string, report: CutoverReport): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, `cutover-report-${report.runId}.json`);
  writeFileSync(path, serializeCutoverReport(report), { encoding: "utf8", mode: 0o600 });
  return path;
}

export function writeJsonExport(directory: string, name: string, value: unknown): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, name);
  writeFileSync(path, `${JSON.stringify(stable(value), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
}
