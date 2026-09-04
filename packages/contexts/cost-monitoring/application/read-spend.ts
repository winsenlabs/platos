// Reading a cap's window — the one composition of ledger and domain.
//
// Every enforcement, display and sweep path needs the same three steps: work out
// which daily buckets a cap's period covers, work out which counter series its
// subject reads, fold the buckets into an exact amount. The source repeats those
// three steps in four methods with three different key derivations, and the
// tier-aware one uses a placeholder for an absent dimension that its own note
// admits had to be matched by hand against the writer.
//
// It is one function here. Every caller goes through it.
//
// THE SUBJECT DERIVATION IS THE SUBTLE PART, and the wildcard is why:
//
//   an environment cap reads the environment series
//   an agent cap reads its own agent's series
//   a NAMED user cap reads that user's series
//   the WILDCARD user cap reads the CALLING user's series
//
// The last one is the whole meaning of the default-per-user cap. One row, and
// every user is measured against it independently out of their own bucket. Read
// against the wildcard string instead, it would be one shared allowance the first
// busy user exhausts for everyone.
//
// A `skill`-tier cap reads a different series again, keyed by tier, skill and
// agent. An `llm`-tier cap does NOT: its spend is already in the per-subject
// series above, and reading a tier series for it would return an empty window and
// silently stop enforcing.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  EMPTY_READING,
  EVERY_USER,
  foldBuckets,
  windowDays,
  type Budget,
  type SpendReading,
} from "../domain/index.js";
import type { CostMonitoringDependencies } from "./dependencies.js";
import type { SpendSubject } from "./ports/index.js";

/** Who the turn is for, as the caller knows it. */
export interface SpendContext {
  readonly agentId?: string | null;
  readonly userId?: string | null;
}

/**
 * The counter series a cap reads.
 *
 * `null` means "this cap cannot be measured in this context" — the wildcard
 * user cap with no calling user. Skipping is right: guessing a user charges an
 * anonymous turn against a named principal's allowance.
 */
export function seriesFor(budget: Budget, context: SpendContext): SpendSubject | null {
  if (budget.target.tier === "skill") {
    return {
      kind: "tier",
      tier: "skill",
      skillSlug: budget.target.skillSlug ?? "",
      agentId: budget.target.agentId ?? "",
    };
  }
  if (budget.target.subject === "agent") {
    return { kind: "agent", agentId: budget.target.targetId };
  }
  if (budget.target.subject === "user") {
    const userId = budget.target.targetId === EVERY_USER ? (context.userId ?? "") : budget.target.targetId;
    return userId === "" ? null : { kind: "user", userId };
  }
  return { kind: "environment" };
}

export interface ReadWindowOptions {
  /**
   * Whether in-flight reservations count.
   *
   * True on every enforcement path. Without it, two concurrent turns from one
   * principal both read "under cap" and both proceed past the gate.
   */
  readonly includeReserved?: boolean;
}

/** Fold a cap's window into an exact reading. */
export async function readBudgetWindow(
  dependencies: CostMonitoringDependencies,
  scope: EnvironmentScope,
  budget: Budget,
  context: SpendContext,
  options: ReadWindowOptions = {},
): Promise<Result<SpendReading>> {
  const subject = seriesFor(budget, context);
  if (subject === null) return ok(EMPTY_READING);
  const buckets = await dependencies.ledger.readWindow({
    scope,
    subject,
    days: windowDays(budget.period, dependencies.clock.now()),
    includeReserved: options.includeReserved ?? true,
  });
  if (!buckets.ok) return err(buckets.error);
  return foldBuckets(buckets.value.settled, buckets.value.reserved);
}
