/**
 * EOBD.104 — feature-flag key registry.
 *
 * The per-agent `PlatosAgent.featureFlags` JSON field is a
 * `{ [flagKey]: boolean }` bag that the runtime reads at turn time.
 * Before this registry, any string was a valid key — an admin could
 * set `enable_beta_mod` thinking it enabled the new moderation path,
 * but the runtime reads `enableBetaMod` and silently ignored it.
 *
 * The registry is the single source of truth for what keys the
 * runtime actually checks. New runtime branches register their flag
 * here with a description. The webapp editor validates inputs
 * against this list and rejects unknown keys before writing to the
 * DB.
 */

export interface FeatureFlagDefinition {
  /** Stable, grep-friendly key. Use snake_case. */
  key: string;
  /** Human-readable description shown in the editor tooltip. */
  description: string;
  /**
   * Default when the key is absent. Kept explicit so a code reader
   * never has to guess the runtime's branch-not-taken behavior.
   */
  defaultValue: boolean;
  /**
   * When true, only users with the admin/impersonation bit can flip
   * this flag — protects experimental paths from accidental enablement.
   */
  adminOnly?: boolean;
}

export const FEATURE_FLAG_REGISTRY: readonly FeatureFlagDefinition[] = [
  {
    key: "enable_safety_v2",
    description:
      "Route safety checks through the v2 detector (PII + injection + grounded). v1 only runs injection detection.",
    defaultValue: true,
  },
  {
    key: "enable_auto_compaction",
    description:
      "Allow runtime to fire the compaction task on threads past compactThreshold. When false, all history is always fed to the LLM.",
    defaultValue: true,
  },
  {
    key: "enable_memory_extraction",
    description:
      "Schedule the extractor against this agent's threads. Overrides extractionPolicy.enabled when set to false.",
    defaultValue: true,
  },
  {
    key: "enable_canary_version",
    description:
      "Honor canaryVersionId + canaryPercent at turn time. Useful kill-switch without dropping the canary config.",
    defaultValue: true,
  },
  {
    key: "enable_budget_enforcement",
    description:
      "Reject turns that would cross a cap. When false, caps are advisory (warning logged + alert fired, turn proceeds).",
    defaultValue: true,
  },
  {
    key: "enable_durable_approvals",
    description: "Expose the `request_durable_approval` meta-tool (minutes-to-days SLA).",
    defaultValue: true,
  },
  {
    key: "enable_structured_output",
    description:
      "Honor outputSchema — both agent-level and per-turn. When false, every turn runs as streamText regardless.",
    defaultValue: true,
  },
  {
    key: "enable_job_cap",
    description:
      "Enforce PLATOS_MAX_JOBS_PER_TURN per-thread cap. Kill-switch in case of false-positive caps on legit workloads.",
    defaultValue: true,
  },
  {
    key: "enable_user_profile_inject",
    description:
      "Inject the per-user profile snippet into every conversation when enableUserProfiling is true.",
    defaultValue: true,
  },
  {
    key: "experimental_llm_retry",
    description:
      "Wrap every LLM provider call with the EOBD.107 retry-on-transient wrapper. Conservative default-off while the retry policy bakes.",
    defaultValue: false,
    adminOnly: true,
  },
] as const;

const BY_KEY = new Map<string, FeatureFlagDefinition>(
  FEATURE_FLAG_REGISTRY.map((def) => [def.key, def]),
);

export function getFeatureFlag(key: string): FeatureFlagDefinition | undefined {
  return BY_KEY.get(key);
}

export function listFeatureFlags(): FeatureFlagDefinition[] {
  return [...FEATURE_FLAG_REGISTRY];
}

/**
 * Validate an incoming `featureFlags` map against the registry.
 * Returns { ok: true, flags } when every key is known; otherwise
 * { ok: false, unknownKeys } so the caller can 400 with a clear
 * message.
 */
export function validateFeatureFlags(
  raw: unknown,
): { ok: true; flags: Record<string, boolean> } | { ok: false; unknownKeys: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: true, flags: {} };
  }
  const unknown: string[] = [];
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const def = BY_KEY.get(k);
    if (!def) {
      unknown.push(k);
      continue;
    }
    out[k] = v === true || v === "true" || v === 1;
  }
  if (unknown.length > 0) return { ok: false, unknownKeys: unknown };
  return { ok: true, flags: out };
}

/**
 * Read a flag at runtime with default fallback. Services should
 * always use this helper rather than indexing into the flags map
 * directly — that way adding a new flag only touches the registry.
 */
export function readFeatureFlag(
  flags: Record<string, boolean> | null | undefined,
  key: string,
): boolean {
  const def = BY_KEY.get(key);
  if (!def) return false;
  if (!flags || typeof flags !== "object") return def.defaultValue;
  const v = flags[key];
  if (typeof v === "boolean") return v;
  return def.defaultValue;
}
