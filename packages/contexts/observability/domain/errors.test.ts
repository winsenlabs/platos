import { describe, expect, it } from "vitest";

import {
  auditStateNotAnObject,
  envelopeVersionUnsupported,
  erasureResidue,
  erasureUnverified,
  OBSERVABILITY_ERROR_CODES,
  projectionScopeMismatch,
  sinkDisabled,
  sinkRejectedBatch,
  sinkSchemaMissing,
  sinkUnreachable,
} from "./errors.js";
import { healthSeverity, isSinkAvailable, sinkHealth, shouldDrain, unreachableSink } from "./sink-health.js";

describe("the error catalogue", () => {
  it("mints every code exactly once", () => {
    expect(new Set(OBSERVABILITY_ERROR_CODES).size).toBe(OBSERVABILITY_ERROR_CODES.length);
  });

  it("declares every code it can produce", () => {
    const produced = [
      sinkDisabled("x"),
      sinkUnreachable("x"),
      sinkSchemaMissing(["turns_v1"]),
      sinkRejectedBatch("x"),
      envelopeVersionUnsupported("x", 2, 1),
      projectionScopeMismatch("steps[0]", "a", "b"),
      auditStateNotAnObject("before"),
      erasureResidue("turns_v1", 3),
      erasureUnverified("turns_v1", "x"),
    ];
    for (const error of produced) {
      expect(OBSERVABILITY_ERROR_CODES).toContain(error.code as never);
    }
  });

  it("mints NO code for an unrecognised event name — another drain's traffic", () => {
    // ADR M0.3 §7 decision 8 + M0.4 §1.1: one outbox, several drains, and a
    // reader ignores an unknown event name. A code here would put `eventing`'s
    // routine envelopes into this context's parked count.
    expect(OBSERVABILITY_ERROR_CODES.some((code) => code.includes("UNKNOWN"))).toBe(false);
  });

  it("separates a CHOICE from a broken installation", () => {
    expect(sinkDisabled("no endpoint").code).toBe("OBSERVABILITY_SINK_DISABLED");
    expect(sinkSchemaMissing([]).code).toBe("OBSERVABILITY_SINK_SCHEMA_MISSING");
    expect(sinkDisabled("no endpoint").code).not.toBe(sinkSchemaMissing([]).code);
  });

  it("calls a missing schema a precondition, not a transient outage", () => {
    // Retrying does not create a table; an operator has to run a migration.
    expect(sinkSchemaMissing(["turns_v1"]).category).toBe("precondition_failed");
    expect(sinkUnreachable("timeout").category).toBe("unavailable");
  });

  it("calls a cross-tenant projection FORBIDDEN, not merely invalid", () => {
    expect(projectionScopeMismatch("steps[0]", "org/a", "org/b").category).toBe("forbidden");
  });

  it("puts a retry hint only on the states worth retrying", () => {
    expect(sinkUnreachable("timeout").retryAfterSeconds).toBeGreaterThan(0);
    expect(sinkSchemaMissing([]).retryAfterSeconds).toBeNull();
  });

  it("names the tables a probe could not find", () => {
    expect(sinkSchemaMissing(["turns_v1", "steps_v1"]).details.missingTables).toEqual([
      "turns_v1",
      "steps_v1",
    ]);
  });

  it("distinguishes residue from unverified — one is known, one is not", () => {
    expect(erasureResidue("turns_v1", 3).code).not.toBe(erasureUnverified("turns_v1", "x").code);
    expect(erasureResidue("turns_v1", 3).details.survivors).toBe(3);
  });
});

describe("sink health", () => {
  it("makes availability one predicate, so no surface can privately disagree", () => {
    expect(isSinkAvailable(sinkHealth("ready", "ok"))).toBe(true);
    for (const status of ["disabled", "misconfigured", "unreachable", "schema_missing"] as const) {
      expect(isSinkAvailable(sinkHealth(status, "x"))).toBe(false);
    }
  });

  it("drains only when the sink is ready", () => {
    expect(shouldDrain(sinkHealth("ready", "ok"))).toBe(true);
    expect(shouldDrain(sinkHealth("schema_missing", "x"))).toBe(false);
  });

  it("reports a configured endpoint for every state but disabled", () => {
    expect(sinkHealth("disabled", "x").configured).toBe(false);
    expect(sinkHealth("misconfigured", "x").configured).toBe(true);
    expect(sinkHealth("unreachable", "x").configured).toBe(true);
  });

  it("says a chosen absence quietly and a broken installation loudly", () => {
    expect(healthSeverity("disabled")).toBe("info");
    expect(healthSeverity("ready")).toBe("info");
    expect(healthSeverity("unreachable")).toBe("warn");
    expect(healthSeverity("misconfigured")).toBe("error");
    expect(healthSeverity("schema_missing")).toBe("error");
  });

  it("reports a thrown probe as unreachable, NEVER as disabled", () => {
    const health = unreachableSink("TypeError");
    expect(health.status).toBe("unreachable");
    expect(health.configured).toBe(true);
    expect(health.detail).toContain("TypeError");
  });

  it("freezes the report so a caller cannot edit the answer it was given", () => {
    expect(Object.isFrozen(sinkHealth("ready", "ok"))).toBe(true);
  });
});
