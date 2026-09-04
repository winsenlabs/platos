// The `SkillSandbox` port — running a skill-provided tool under confinement.
//
// A skill's tools are code the operator did not write, described by a manifest
// fetched from a URL. They run somewhere isolated, and WHICH isolation is an
// operational choice that has already changed more than once in this system's
// life. So the boundary is a port with no vendor in it: the sandbox provider,
// its session lifecycle, its filesystem persistence and its billing model are an
// adapter's business, and none of them appear here.
//
// WHAT THIS CONTEXT IS RESPONSIBLE FOR, and therefore what the port carries:
//
//   The HANDLER, which the manifest supplied and which this context stores
//     verbatim. It means something to the sandbox and nothing here.
//
//   The DECLARED ENVIRONMENT KEY NAMES. Names, again — never values. The
//     adapter resolves them against the secrets boundary when it builds the
//     execution environment. A value passing through this context would put a
//     credential in a package that has no business holding one.
//
//   The CONFIG from the environment binding, which is the tenant's own
//     per-environment settings for this skill.
//
// WHAT IT IS NOT RESPONSIBLE FOR: metering, budget gating and usage recording.
// Those belong to `cost-monitoring` (ADR M0.3 §1, context 13), which is NOT on
// this context's dependency allow-list. The caller that owns the turn consults
// the budget guard and records the spend; this port reports what a run cost and
// how long it took, and the accounting happens where the ledger lives.

import type { EnvironmentScope, JsonValue, Result } from "@platos/kernel";

import type { EnvironmentKey, SkillSlug, ToolName } from "../../domain/index.js";

export interface SkillSandboxRequest {
  readonly scope: EnvironmentScope;
  readonly slug: SkillSlug;
  /** The tool as the manifest names it — NOT the namespaced runtime name. */
  readonly toolName: ToolName;
  /** Opaque executor reference, stored verbatim from the manifest. */
  readonly handler: string;
  readonly input: Readonly<Record<string, JsonValue>>;
  /** Names only. The adapter resolves values; this context never holds them. */
  readonly environmentKeys: readonly EnvironmentKey[];
  /** The environment binding's config. */
  readonly config: Readonly<Record<string, JsonValue>>;
}

/**
 * What a run cost, as the sandbox measured it.
 *
 * Reported, not interpreted. `costCents` is present when the adapter could
 * establish one and null when it could not, and null is NOT zero: a caller
 * recording a spend must be able to tell "this was free" from "nobody knows",
 * and folding the second into the first silently under-bills.
 */
export interface SkillSandboxUsage {
  readonly inputUnits: number | null;
  readonly outputUnits: number | null;
  readonly costCents: number | null;
  readonly latencyMillis: number;
}

export interface SkillSandboxOutcome {
  /**
   * The tool's result, as the model will see it.
   *
   * Any accounting rider the executor attached has already been stripped by the
   * adapter and surfaced through `usage`. Bookkeeping must not reach a prompt.
   */
  readonly result: JsonValue;
  readonly usage: SkillSandboxUsage;
}

export interface SkillSandbox {
  run(request: SkillSandboxRequest): Promise<Result<SkillSandboxOutcome>>;
}
