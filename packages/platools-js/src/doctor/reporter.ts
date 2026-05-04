/**
 * Text formatter for `platools doctor` reports.
 *
 * Matches the Python reporter output shape 1:1 so CI logs look the
 * same whichever SDK a consumer is on:
 *
 *     Tools: 47 registered, 43 healthy
 *
 *     ERRORS (2):
 *       x archive_workspace.admin_id is unreachable
 *       x merge_pages — circular dependency with split_page
 *
 *     WARNINGS (5):
 *       ! get_page — description too short (3 chars)
 *
 *     INFO (2):
 *       i cleanup_temp is not assigned to any agent
 */

import type { DoctorReport, Finding } from "./types.js";

export function formatReport(report: DoctorReport): string {
  const errors = report.errors();
  const warnings = report.warnings();
  const infos = report.infos();

  // Healthy count: tool count minus the unique tool names mentioned
  // in error-severity findings. Matches the Python reporter so
  // cycle-dedupe attributes unhealthy correctly (PLATOS-18
  // regression fix).
  const unhealthy = new Set<string>();
  for (const f of errors) {
    if (f.tool !== undefined) unhealthy.add(f.tool);
  }
  const healthy = report.toolCount - unhealthy.size;

  const lines: string[] = [];
  lines.push(`Tools: ${report.toolCount} registered, ${healthy} healthy`);
  lines.push("");

  if (errors.length > 0) {
    lines.push(`ERRORS (${errors.length}):`);
    lines.push(...formatSection(errors, "x"));
    lines.push("");
  }
  if (warnings.length > 0) {
    lines.push(`WARNINGS (${warnings.length}):`);
    lines.push(...formatSection(warnings, "!"));
    lines.push("");
  }
  if (infos.length > 0) {
    lines.push(`INFO (${infos.length}):`);
    lines.push(...formatSection(infos, "i"));
    lines.push("");
  }

  if (errors.length === 0 && warnings.length === 0 && infos.length === 0) {
    lines.push("No issues found.");
  }

  return `${lines.join("\n").replace(/\s+$/, "")}\n`;
}

function formatSection(findings: readonly Finding[], marker: string): string[] {
  return findings.map((f) => `  ${marker} ${f.message}`);
}

export function reportToJson(report: DoctorReport): string {
  return JSON.stringify(
    {
      tool_count: report.toolCount,
      errors: report.errors().map(findingJson),
      warnings: report.warnings().map(findingJson),
      info: report.infos().map(findingJson),
    },
    null,
    2,
  );
}

function findingJson(f: Finding): Record<string, unknown> {
  return {
    code: f.code,
    message: f.message,
    tool: f.tool ?? null,
    param: f.param ?? null,
  };
}
