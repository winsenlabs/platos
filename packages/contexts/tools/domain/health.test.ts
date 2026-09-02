import { asIdentifier, type EnvironmentId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  applyOutcome,
  failureRatio,
  freshHealth,
  healthKey,
  HEALTH_OUTCOMES,
  isFailing,
  type ToolHealth,
} from "./health.js";
import {
  asToolsIdentifier,
  type ExternalEntityId,
  type ToolHealthId,
  type ToolId,
} from "./identifiers.js";

const ENVIRONMENT = asIdentifier<EnvironmentId>("env-1");
const TOOL = asToolsIdentifier<ToolId>("tool-1");
const ENTITY = asToolsIdentifier<ExternalEntityId>("acme");
const AT = new Date("2026-01-01T00:00:00.000Z");

function blank(): ToolHealth {
  return freshHealth(asToolsIdentifier<ToolHealthId>("health-1"), ENVIRONMENT, TOOL, ENTITY, AT);
}

function fold(outcomes: readonly (readonly [string, number])[]): ToolHealth {
  let health = blank();
  let at = AT;
  for (const [outcome, latency] of outcomes) {
    at = new Date(at.getTime() + 1000);
    health = applyOutcome(health, outcome as never, latency, at);
  }
  return health;
}

describe("the three outcomes", () => {
  it("keeps a timeout apart from a refusal", () => {
    expect([...HEALTH_OUTCOMES]).toEqual(["success", "failed", "timeout"]);
  });
});

describe("the counter that resets", () => {
  it("counts CONSECUTIVE failures and clears on any success", () => {
    expect(fold([["failed", 5]]).failCount).toBe(1);
    expect(fold([
      ["failed", 5],
      ["failed", 5],
      ["failed", 5],
    ]).failCount).toBe(3);
    expect(fold([
      ["failed", 5],
      ["failed", 5],
      ["success", 5],
    ]).failCount).toBe(0);
  });

  it("counts a timeout as a failure, because the call did not work", () => {
    expect(fold([["timeout", 30_000]]).failCount).toBe(1);
  });

  it("distinguishes a busy tool that works from a quiet one that has just died", () => {
    const busy = fold([
      ...Array.from({ length: 50 }, () => ["failed", 5] as const),
      ["success", 5] as const,
    ]);
    const dead = fold([
      ["success", 5],
      ["failed", 5],
      ["failed", 5],
      ["failed", 5],
    ]);
    expect(busy.totalFailures).toBeGreaterThan(dead.totalFailures);
    expect(isFailing(busy, 3)).toBe(false);
    expect(isFailing(dead, 3)).toBe(true);
  });
});

describe("the monotonic counters", () => {
  it("never decrease", () => {
    const folded = fold([
      ["success", 10],
      ["failed", 20],
      ["success", 30],
    ]);
    expect(folded.totalCalls).toBe(3);
    expect(folded.totalFailures).toBe(1);
  });

  it("reports no ratio before the first call, rather than a healthy-looking zero", () => {
    expect(failureRatio(blank())).toBeNull();
    expect(failureRatio(fold([["failed", 1]]))).toBe(1);
    expect(failureRatio(fold([["failed", 1], ["success", 1]]))).toBe(0.5);
  });
});

describe("the latency average", () => {
  it("is a genuine mean over every call, not the last latency", () => {
    // The running system writes `avgLatencyMs: latencyMs` inside one Prisma
    // upsert because that statement cannot read the counter it is
    // incrementing. Folding the value here removes the constraint.
    const folded = fold([
      ["success", 100],
      ["success", 200],
      ["success", 300],
    ]);
    expect(folded.avgLatencyMs).toBeCloseTo(200, 9);
    expect(folded.avgLatencyMs).not.toBe(300);
  });

  it("is exactly the observation after one call", () => {
    expect(fold([["success", 42]]).avgLatencyMs).toBe(42);
  });

  it("clamps a negative sample, which a clock adjustment makes reachable", () => {
    expect(fold([["success", -500]]).avgLatencyMs).toBe(0);
  });

  it("rounds a fractional measurement, because the column is an Int", () => {
    expect(fold([["success", 10.6]]).avgLatencyMs).toBe(11);
  });

  it("stays within the observed range, however many calls are folded", () => {
    const folded = fold(Array.from({ length: 500 }, (_, index) => ["success", index] as const));
    expect(folded.avgLatencyMs).toBeGreaterThanOrEqual(0);
    expect(folded.avgLatencyMs).toBeLessThanOrEqual(499);
    expect(folded.avgLatencyMs).toBeCloseTo(249.5, 6);
  });
});

describe("the percentile the schema declares", () => {
  it("stays null, because the four counters cannot yield one", () => {
    expect(blank().p95LatencyMs).toBeNull();
    expect(fold([["success", 10], ["success", 900]]).p95LatencyMs).toBeNull();
  });
});

describe("the health key", () => {
  it("separates two entities exposing the same tool", () => {
    expect(healthKey(ENVIRONMENT, TOOL, ENTITY)).not.toBe(
      healthKey(ENVIRONMENT, TOOL, asToolsIdentifier<ExternalEntityId>("beta")),
    );
  });

  it("separates an entity-owned tool from a runtime one", () => {
    expect(healthKey(ENVIRONMENT, TOOL, null)).not.toBe(healthKey(ENVIRONMENT, TOOL, ENTITY));
  });

  it("separates two environments", () => {
    expect(healthKey(ENVIRONMENT, TOOL, ENTITY)).not.toBe(
      healthKey(asIdentifier<EnvironmentId>("env-2"), TOOL, ENTITY),
    );
  });
});
