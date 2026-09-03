// Provider liveness — the capability ADR M0.3 §3 moves OUT of `auth`.
//
// The `auth → providers` wrong-way edge in the ground truth is four files, all
// of them `provider-health.service`, sitting inside the authentication module
// because it is where the credential resolution happened to live. §3 records the
// destination as a PHYSICAL MOVE: the capability comes here, beside the manifests
// and the credential resolution it actually depends on, and the edge disappears
// because it becomes intra-context.
//
// WHAT A LIVENESS RESULT MEANS, PRECISELY. The four statuses are not a severity
// scale — they are four different situations with four different owners:
//
//   not_configured  nothing was called. A required credential is missing, and
//                   the operator's next step is to add one.
//   healthy         the provider accepted a minimal call with this credential.
//   invalid_key     the provider REFUSED the credential. The key is wrong,
//                   revoked, or out of quota; the operator's next step is to
//                   rotate it.
//   error           the call did not complete. This says nothing about the key.
//
// Collapsing `invalid_key` into `error` is the tempting simplification and it is
// wrong: it sends an operator to rotate a perfectly good key because a provider
// had an outage.

import type { CredentialReadiness } from "./manifest.js";
import type { ProviderHealthPolicy } from "./policy.js";
import type { ProviderId } from "./identifiers.js";

export const HEALTH_STATUSES = ["healthy", "invalid_key", "error", "not_configured"] as const;

export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/** Why a liveness call did not return `healthy`. */
export const PROBE_FAILURES = ["auth_refused", "request_failed", "probe_not_configurable"] as const;

export type ProbeFailure = (typeof PROBE_FAILURES)[number];

export interface ProviderHealthReport {
  readonly provider: ProviderId;
  readonly status: HealthStatus;
  readonly latencyMs: number;
  /** The stable failure token, or null when the call succeeded. */
  readonly failure: ProbeFailure | "unknown_provider" | null;
  /** The model the call named. Null when nothing was called. */
  readonly model: string | null;
  readonly requiredCredentials: readonly CredentialReadiness[];
  readonly checkedAt: Date;
}

/**
 * The status a probe failure reports.
 *
 * Only a refusal by the provider condemns the key. A call that could not be
 * made, or could not be configured, is an `error` — the credential was never
 * judged.
 */
export function statusForFailure(failure: ProbeFailure): HealthStatus {
  return failure === "auth_refused" ? "invalid_key" : "error";
}

export function notConfigured(
  provider: ProviderId,
  requiredCredentials: readonly CredentialReadiness[],
  checkedAt: Date,
): ProviderHealthReport {
  return {
    provider,
    status: "not_configured",
    latencyMs: 0,
    failure: null,
    model: null,
    requiredCredentials,
    checkedAt,
  };
}

export function unknownProviderReport(provider: ProviderId, checkedAt: Date): ProviderHealthReport {
  return {
    provider,
    status: "not_configured",
    latencyMs: 0,
    failure: "unknown_provider",
    model: null,
    requiredCredentials: [],
    checkedAt,
  };
}

/** How long this particular result stays usable. */
export function freshnessSeconds(report: ProviderHealthReport, policy: ProviderHealthPolicy): number {
  return report.status === "healthy" ? policy.healthySeconds : policy.unhealthySeconds;
}

export function expiresAt(report: ProviderHealthReport, policy: ProviderHealthPolicy): Date {
  return new Date(report.checkedAt.getTime() + freshnessSeconds(report, policy) * 1000);
}

/**
 * May a stored result be reused at this instant?
 *
 * Boundary rule: a result expires AT its instant, not after it. A window that
 * included its own end would let a result be reused at the moment it was
 * supposed to be re-checked, which is the one moment it is least trustworthy.
 */
export function isFresh(report: ProviderHealthReport, policy: ProviderHealthPolicy, now: Date): boolean {
  return now.getTime() < expiresAt(report, policy).getTime();
}

/**
 * A result is cached PER CREDENTIAL, not per environment.
 *
 * Two environments sharing one key share the answer, and rotating a key
 * invalidates the answer by construction rather than by remembering to. The
 * caller supplies an opaque credential fingerprint — never the material itself,
 * which must not appear in a cache key any more than in a log line.
 */
export function healthCacheKey(provider: ProviderId, credentialFingerprint: string): string {
  return `provider-health/${provider}/${credentialFingerprint}`;
}

/** The same rule for a model list. Same reason, same shape. */
export function modelListCacheKey(provider: ProviderId, credentialFingerprint: string): string {
  return `provider-models/${provider}/${credentialFingerprint}`;
}
