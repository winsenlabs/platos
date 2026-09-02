import { describe, expect, it } from "vitest";

import * as errors from "./errors.js";
import { COST_MONITORING_ERROR_CODES } from "./errors.js";

/** Every minter in the catalogue, with an argument list that satisfies it. */
const MINTED = [
  errors.budgetNotFound("budget-1"),
  errors.budgetInvalid("bad"),
  errors.budgetTargetInvalid("bad", "scope", "*"),
  errors.thresholdInvalid("bad", 0),
  errors.windowInvalid("bad"),
  errors.spendInvalid("bad"),
  errors.alertChannelNotFound("channel-1"),
  errors.alertChannelInvalid("bad"),
  errors.alertChannelExists("nightly"),
  errors.alertChannelUnchanged("channel-1"),
  errors.alertTopicInvalid("bad", "budget"),
  errors.deliveryNotFound("delivery-1"),
  errors.deliveryUnavailable("delivery-1", "claimed"),
  errors.deliveryFailed(1, 2),
  errors.thresholdEventUnavailable("event-1"),
  errors.scopeMismatch("a", "b"),
  errors.ledgerUnavailable("down"),
  errors.repositoryUnavailable("down"),
];

describe("the error catalogue", () => {
  it("mints every code it declares, and declares every code it mints", () => {
    // One list, so a transport builds its status table from it and an operator
    // grepping a log finds exactly one definition.
    expect([...MINTED.map((error) => error.code)].sort()).toEqual([...COST_MONITORING_ERROR_CODES].sort());
  });

  it("has no duplicate codes", () => {
    expect(new Set(COST_MONITORING_ERROR_CODES).size).toBe(COST_MONITORING_ERROR_CODES.length);
  });

  it("gives every code a category a transport can map, and never `internal`", () => {
    // An `internal` here would be this context declining to say what went wrong.
    for (const error of MINTED) {
      expect(error.category).not.toBe("internal");
    }
  });

  it("carries a retry hint on exactly the codes that can be retried", () => {
    const retryable = MINTED.filter((error) => error.retryAfterSeconds !== null).map((error) => error.code);
    expect(retryable.sort()).toEqual([
      "COST_DELIVERY_FAILED",
      "COST_LEDGER_UNAVAILABLE",
      "COST_REPOSITORY_UNAVAILABLE",
    ]);
  });

  it("distinguishes a delivery that is not CLAIMABLE from one that FAILED", () => {
    // Nothing is wrong when a row belongs to someone else right now; the caller
    // should move on rather than report an incident.
    expect(errors.deliveryUnavailable("d", "leased").category).toBe("precondition_failed");
    expect(errors.deliveryFailed(1, 0).category).toBe("unavailable");
  });

  it("reports a scope mismatch as forbidden, not as not-found", () => {
    // The grant resolves; it resolves somewhere else. A transport may still
    // choose to answer 404, but it chooses that deliberately.
    expect(errors.scopeMismatch("a", "b").category).toBe("forbidden");
  });

  it("carries the failure count on a delivery failure, because the dispatcher logs it", () => {
    const failed = errors.deliveryFailed(1, 3);
    expect(failed.details["failed"]).toBe(1);
    expect(failed.details["delivered"]).toBe(3);
  });

  it("puts a field violation on every input error a form can point at", () => {
    for (const error of [
      errors.thresholdInvalid("bad", 0),
      errors.budgetTargetInvalid("bad", "scope", "*"),
      errors.alertTopicInvalid("bad", "x"),
    ]) {
      expect(error.fields.length).toBeGreaterThan(0);
    }
  });

  it("freezes what it mints, so a caller cannot edit an error in flight", () => {
    const error = errors.budgetNotFound("budget-1");
    expect(Object.isFrozen(error)).toBe(true);
  });
});
