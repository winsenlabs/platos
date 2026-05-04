/**
 * Tool graph analyzer entry point — `platools doctor`.
 *
 * Ported from `platools/doctor/analyzer.py`. Accepts a list of
 * `ToolDef` (loaded from a `Platools` instance's registry) and runs
 * every static check, returning a `DoctorReport` the reporter can
 * format for the CLI.
 */

import type { ToolRegistry } from "../core/registry.js";
import type { ToolDef } from "../types.js";

import {
  checkCircularDependencies,
  checkDescriptions,
  checkDestructiveAnnotations,
  checkOrphanTools,
  checkOverlyBroad,
  checkParamSources,
  checkPermissionGaps,
  checkReturnSchema,
} from "./checks.js";
import { DoctorReport, type Finding } from "./types.js";

export interface AnalyzeOptions {
  readonly agentToolNames?: ReadonlySet<string>;
  readonly rolesInUse?: ReadonlySet<string>;
}

/**
 * Run every doctor check against `tools` and return a report.
 *
 * `agentToolNames` and `rolesInUse` are optional — when undefined
 * the orphan and permission-gap checks are skipped. Pass them when
 * the CLI is invoked with `--platform-url` and the analyzer can
 * enrich the local view with platform context.
 */
export function analyzeTools(
  tools: readonly ToolDef[],
  options: AnalyzeOptions = {},
): DoctorReport {
  const findings: Finding[] = [];
  findings.push(...checkParamSources(tools));
  findings.push(...checkCircularDependencies(tools));
  findings.push(
    ...checkOrphanTools(tools, options.agentToolNames !== undefined ? { agentToolNames: options.agentToolNames } : {}),
  );
  findings.push(...checkDescriptions(tools));
  findings.push(...checkReturnSchema(tools));
  findings.push(
    ...checkPermissionGaps(tools, options.rolesInUse !== undefined ? { rolesInUse: options.rolesInUse } : {}),
  );
  findings.push(...checkOverlyBroad(tools));
  findings.push(...checkDestructiveAnnotations(tools));
  return new DoctorReport(tools.length, findings);
}

/** Convenience wrapper that pulls tools out of a `ToolRegistry`. */
export function analyzeRegistry(
  registry: ToolRegistry,
  options: AnalyzeOptions = {},
): DoctorReport {
  return analyzeTools(registry.all(), options);
}
