// ADR M0.3 §4 kernel port: SafetyEventSink.
//
// This port exists to delete one specific wrong-way import. ADR M0.3 §3 records
// the `auth -> monitoring` edge — `rate-limit.guard` reaching into
// `SafetyEventService` — and its destination: identity-access publishes through
// this kernel port, `governance` implements it and stays the sole writer of
// SafetyEvent, and the two are bound at the composition root. There is no
// identity-access -> governance code edge, and rule (g) `identity-isolation`
// keeps it that way.

import type { JsonValue } from "../vo/domain-event.js";
import type { PrincipalId } from "../vo/identifier.js";
import type { TenantScope } from "../vo/scope.js";

export type SafetyOutcome = "allowed" | "blocked" | "held" | "redacted";

export interface SafetyObservation {
  /** Stable, dotted rule identity — `identity.rate_limit.exceeded`. */
  readonly rule: string;
  readonly outcome: SafetyOutcome;
  readonly scope: TenantScope;
  readonly principalId: PrincipalId | null;
  readonly observedAt: Date;
  /** Already redacted by the producer. */
  readonly details: Readonly<Record<string, JsonValue>>;
}

export interface SafetyEventSink {
  /**
   * Record an observation. Must not throw and must not block the caller's
   * decision: a safety sink that can fail a request has inverted the control it
   * was added to provide.
   */
  record(observation: SafetyObservation): Promise<void>;
}
