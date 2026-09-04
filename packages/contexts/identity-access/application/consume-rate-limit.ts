// Consume one unit of an authentication rate-limit budget.
//
// THIS USE CASE IS WHERE ADR M0.3 §3's THIRD WRONG-WAY EDGE DIED. The running
// system's `rate-limit.guard` imports `SafetyEventService` from `monitoring` to
// record a denial — an `auth -> monitoring` code edge. Here the denial is
// published through the KERNEL `SafetyEventSink`; `governance` implements it and
// remains sole writer of SafetyEvent; the two meet at the composition root. Rule
// (g) `identity-isolation` makes the direct import unrepresentable, so the edge
// cannot come back by accident.
//
// FAIL-OPEN IS APPLIED HERE, ONCE, AND IT IS VISIBLE. When the limiter is
// unreachable the request is ALLOWED — availability over limiting, the
// behaviour the running system already has. What is new is that it is a named
// domain policy (`LIMITER_UNAVAILABLE_POLICY`) rather than a bare `catch`, that
// it is reported as a `degraded` outcome rather than being indistinguishable
// from a healthy allow, and that the degradation is itself recorded to the
// safety sink — so "the limiter was down for six hours" is a fact somebody can
// discover instead of a silence.

import {
  asResult,
  decide,
  decideOnLimiterFailure,
  type AuthRateLimitAction,
  type PermittedRateLimitDecision,
  type RateLimitPolicy,
  DEFAULT_POLICIES,
} from "../domain/index.js";
import type { PortsOf } from "./dependencies.js";
import { ok, type PrincipalId, type Result, type TenantScope } from "@platos/kernel";

export type ConsumeRateLimitPorts = PortsOf<
  "rateLimiter" | "hasher" | "clock" | "safety" | "logger"
>;

export interface ConsumeRateLimitInput {
  readonly action: AuthRateLimitAction;
  /**
   * The raw bucket key — an address, a client address, a session identifier.
   * Hashed here so no plaintext identifier ever reaches the limiter keyspace.
   */
  readonly identifier: string;
  readonly scope: TenantScope;
  readonly principalId: PrincipalId | null;
  /** Defaults to the action's policy from `domain/rate-limit.ts`. */
  readonly policy?: RateLimitPolicy;
}

/** Dotted rule identities, as the kernel `SafetyEventSink` contract requires. */
const EXCEEDED_RULE = "identity.rate_limit.exceeded";
const DEGRADED_RULE = "identity.rate_limit.degraded";

export async function consumeRateLimit(
  ports: ConsumeRateLimitPorts,
  input: ConsumeRateLimitInput,
): Promise<Result<PermittedRateLimitDecision>> {
  const now = ports.clock.now();
  const policy: RateLimitPolicy = input.policy ?? DEFAULT_POLICIES[input.action];
  // Lower-cased and trimmed before hashing, so `Alice@Example.com ` and
  // `alice@example.com` share one budget rather than two.
  const identifierHash = ports.hasher.hash(input.identifier.trim().toLowerCase());

  const consumed = await ports.rateLimiter.consume({
    action: input.action,
    identifierHash,
    policy,
    at: now,
  });

  if (!consumed.ok) {
    const decision = decideOnLimiterFailure();
    ports.logger.log("warn", "rate limiter unavailable; applying the fail-open policy", {
      action: input.action,
      outcome: decision.outcome,
      error: consumed.error.code,
    });
    await ports.safety.record({
      rule: DEGRADED_RULE,
      outcome: decision.outcome === "limited" ? "blocked" : "allowed",
      scope: input.scope,
      principalId: input.principalId,
      observedAt: now,
      details: { action: input.action, reason: consumed.error.code },
    });
    return asResult(decision);
  }

  const decision = decide(consumed.value, policy, now);
  if (decision.outcome === "limited") {
    await ports.safety.record({
      rule: EXCEEDED_RULE,
      outcome: "blocked",
      scope: input.scope,
      principalId: input.principalId,
      observedAt: now,
      details: {
        action: input.action,
        limit: policy.requests,
        windowMs: policy.windowMs,
        requestCount: consumed.value.requestCount,
      },
    });
  }
  return asResult(decision);
}

/** The allow path as a plain predicate, for callers that only need the gate. */
export async function isWithinRateLimit(
  ports: ConsumeRateLimitPorts,
  input: ConsumeRateLimitInput,
): Promise<Result<true>> {
  const decision = await consumeRateLimit(ports, input);
  return decision.ok ? ok(true) : decision;
}
