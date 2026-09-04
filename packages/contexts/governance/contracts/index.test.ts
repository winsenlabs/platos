// What this context PUBLISHES.
//
// The barrel is the only module another context or the composition root may
// import, so this suite is about the surface rather than the behaviour: the
// vocabularies a consumer builds a command from, the policy shape a composition
// root patches, and the fact that importing it costs nothing at runtime beyond
// those frozen arrays.
//
// The closed vocabularies are pinned as EXACT ORDERED LISTS. A detector silently
// added to the union is a bucket that appears in every histogram; a detector
// silently removed is a row that can never be filtered again. Both are things a
// reviewer should have to argue for.

import { describe, expect, it } from "vitest";

import {
  COLUMN_SCORE_SCALE_MAX,
  DEFAULT_GOVERNANCE_POLICY,
  GOVERNANCE_ERROR_CODES,
  GOVERNANCE_EVENT_NAMES,
  JUDGE_PROVIDERS,
  SAFETY_ACTIONS,
  SAFETY_DETECTORS,
  SAFETY_SEVERITIES,
} from "./index.js";

describe("the published vocabularies", () => {
  it("publishes the eight safety detectors, in order", () => {
    expect([...SAFETY_DETECTORS]).toEqual([
      "pii",
      "injection",
      "grounded",
      "exfiltration",
      "tool_param",
      "rate_limit",
      "budget",
      "dispatcher_permission_gate",
    ]);
  });

  it("publishes the four actions and the three severities, in order", () => {
    expect([...SAFETY_ACTIONS]).toEqual(["flag", "redact", "block", "warn"]);
    expect([...SAFETY_SEVERITIES]).toEqual(["low", "medium", "high"]);
  });

  it("publishes the three judge providers this context can resolve", () => {
    expect([...JUDGE_PROVIDERS]).toEqual(["anthropic", "openai", "google"]);
  });

  it("publishes the shipped policy and the column default it disagrees with", () => {
    expect(DEFAULT_GOVERNANCE_POLICY.evals.defaultJudgeModel).toBe(
      "anthropic:claude-haiku-4-5-20251001",
    );
    expect(COLUMN_SCORE_SCALE_MAX).toBe(1);
  });
});

describe("the published error codes", () => {
  it("names every code under this context's own prefix, with no duplicates", () => {
    for (const code of GOVERNANCE_ERROR_CODES) {
      expect(code.startsWith("GOVERNANCE_")).toBe(true);
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/u);
    }
    expect(new Set(GOVERNANCE_ERROR_CODES).size).toBe(GOVERNANCE_ERROR_CODES.length);
  });

  it("publishes one code per distinguishable refusal — 33 of them", () => {
    // Pinned as a literal so a code merged into another, which is how two guards
    // become indistinguishable, cannot pass unnoticed.
    expect(GOVERNANCE_ERROR_CODES).toHaveLength(33);
  });

  it("keeps the four golden-set refusals apart from each other", () => {
    // A set can breach exactly one of the three ceilings, and "no such agent
    // here" is a different mistake from "no such set here". Asserted against the
    // PUBLISHED list rather than against a local array, whose size would be a
    // property of this test rather than of the code.
    for (const code of [
      "GOVERNANCE_GOLDEN_SET_TOO_MANY_THREADS",
      "GOVERNANCE_GOLDEN_SET_TOO_MANY_CRITERIA",
      "GOVERNANCE_GOLDEN_SET_TOO_MANY_PAIRS",
      "GOVERNANCE_AGENT_NOT_VISIBLE",
    ]) {
      expect(GOVERNANCE_ERROR_CODES).toContain(code);
    }
  });

  it("keeps the JUDGE PROMPT and the RUBRIC ceilings apart", () => {
    // They shared `GOVERNANCE_CRITERION_PROMPT_INVALID` until a review found it:
    // two ceilings answering alike is two guards a test cannot tell apart.
    expect(GOVERNANCE_ERROR_CODES).toContain("GOVERNANCE_CRITERION_PROMPT_INVALID");
    expect(GOVERNANCE_ERROR_CODES).toContain("GOVERNANCE_CRITERION_RUBRIC_INVALID");
  });

  it("keeps a dead DISPATCHER apart from a dead STORE", () => {
    expect(GOVERNANCE_ERROR_CODES).toContain("GOVERNANCE_QUEUE_UNAVAILABLE");
    expect(GOVERNANCE_ERROR_CODES).toContain("GOVERNANCE_LEDGER_UNAVAILABLE");
  });

  it("keeps `not found` apart from `inactive` for a criterion", () => {
    expect(GOVERNANCE_ERROR_CODES).toContain("GOVERNANCE_CRITERION_NOT_FOUND");
    expect(GOVERNANCE_ERROR_CODES).toContain("GOVERNANCE_CRITERION_INACTIVE");
  });
});

describe("the published event names", () => {
  it("names eleven events, all under this context's prefix, with no duplicates", () => {
    expect(GOVERNANCE_EVENT_NAMES).toHaveLength(11);
    for (const name of GOVERNANCE_EVENT_NAMES) expect(name.startsWith("governance.")).toBe(true);
    expect(new Set(GOVERNANCE_EVENT_NAMES).size).toBe(GOVERNANCE_EVENT_NAMES.length);
  });

  it("does NOT name a cost event — the spend ledger is another context's row", () => {
    for (const name of GOVERNANCE_EVENT_NAMES) expect(name).not.toContain("cost");
    for (const name of GOVERNANCE_EVENT_NAMES) expect(name).not.toContain("budget");
  });
});

describe("importing the barrel costs a consumer nothing but data", () => {
  it("exports only frozen arrays and the policy object at runtime", async () => {
    const barrel: Record<string, unknown> = await import("./index.js");
    const runtimeValues = Object.entries(barrel).filter(([, value]) => value !== undefined);
    // Eight value exports: the error codes, the event names, the three safety
    // enumerations and the judge providers, plus the shipped policy and the
    // column constant. Anything CALLABLE here would be an implementation leaking
    // out of a surface that is meant to carry none.
    for (const [name, value] of runtimeValues) {
      expect(typeof value, `${name} must not be callable`).not.toBe("function");
    }
    expect(runtimeValues).toHaveLength(8);
  });
});
