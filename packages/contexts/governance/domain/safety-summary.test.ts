import { describe, expect, it } from "vitest";

import { SAFETY_ACTIONS, SAFETY_DETECTORS, SAFETY_SEVERITIES } from "./safety-event.js";
import { summarise, type SafetyTally } from "./safety-summary.js";

function row(overrides: Partial<SafetyTally> = {}): SafetyTally {
  return { detector: "pii", action: "redact", severity: "medium", ...overrides };
}

describe("summarise", () => {
  it("declares EVERY bucket, so a missing series reads as zero rather than absent", () => {
    const summary = summarise([]);
    expect(Object.keys(summary.byDetector).sort()).toEqual([...SAFETY_DETECTORS].sort());
    expect(Object.keys(summary.byAction).sort()).toEqual([...SAFETY_ACTIONS].sort());
    expect(Object.keys(summary.bySeverity).sort()).toEqual([...SAFETY_SEVERITIES].sort());
    expect(summary.byDetector.injection).toBe(0);
  });

  it("counts each row on all three axes", () => {
    const summary = summarise([row(), row({ detector: "injection", action: "block", severity: "high" })]);
    expect(summary.total).toBe(2);
    expect(summary.byDetector.pii).toBe(1);
    expect(summary.byDetector.injection).toBe(1);
    expect(summary.byAction.redact).toBe(1);
    expect(summary.byAction.block).toBe(1);
    expect(summary.bySeverity.medium).toBe(1);
    expect(summary.bySeverity.high).toBe(1);
  });

  it("counts exact totals rather than merely 'some'", () => {
    const rows = [row(), row(), row(), row({ detector: "budget" })];
    const summary = summarise(rows);
    expect(summary.byDetector.pii).toBe(3);
    expect(summary.byDetector.budget).toBe(1);
    expect(summary.byDetector.grounded).toBe(0);
  });

  it("conserves: every axis sums to the total", () => {
    const rows = [
      row(),
      row({ detector: "injection", action: "block", severity: "high" }),
      row({ detector: "budget", action: "warn", severity: "low" }),
      row({ detector: "budget", action: "flag", severity: "low" }),
    ];
    const summary = summarise(rows);
    const sum = (counts: Readonly<Record<string, number>>) =>
      Object.values(counts).reduce((total, count) => total + count, 0);
    expect(sum(summary.byDetector)).toBe(4);
    expect(sum(summary.byAction)).toBe(4);
    expect(sum(summary.bySeverity)).toBe(4);
    expect(summary.total).toBe(4);
  });

  it("freezes each histogram, so a reader cannot rewrite a rollup in place", () => {
    const summary = summarise([row()]);
    expect(Object.isFrozen(summary.byDetector)).toBe(true);
    expect(Object.isFrozen(summary.byAction)).toBe(true);
    expect(Object.isFrozen(summary.bySeverity)).toBe(true);
  });

  it("reports the count it summed, not the count it was told about", () => {
    expect(summarise([row(), row(), row()]).total).toBe(3);
  });
});
