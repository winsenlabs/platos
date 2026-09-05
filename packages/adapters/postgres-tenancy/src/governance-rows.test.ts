// The pure half of `governance`'s store: the row mapping and the write guards,
// exercised without a database.
//
// EVERY CASE HERE IS A DECISION THE MAPPING MAKES, not a round trip. The round
// trips are in the integration suites, against a real PostgreSQL; what this file
// pins is the branch a stored column takes on the way in and on the way out —
// which value is trusted, which is refused, and which envelope shape a row
// written by an older binary falls into. Those are the branches a mutation can
// flip while every container suite still passes, because a container suite only
// ever writes rows THIS binary wrote.

import { describe, expect, test } from "vitest";

import type {
  AdmittedEval,
  AdmittedSafetyEvent,
  CriterionSnapshot,
  EnvironmentScope,
  TenantScope,
} from "@platos/context-governance/application/ports/index.js";
import { asGovernanceIdentifier, environmentScope } from "@platos/context-governance/application/ports/index.js";

import {
  CRITERION_SCALE_NOT_REPRESENTABLE,
  EVAL_COST_NOT_REPRESENTABLE,
  EVAL_LATENCY_INVALID,
  EVAL_SCORE_NOT_FINITE,
  GOVERNANCE_IDENTIFIER_NOT_UUID,
  GovernanceWriteRefused,
  RATING_OUTSIDE_SCHEMA_RANGE,
  RATING_REVISION_INVALID,
  SAFETY_METADATA_RESERVED,
  guardEvalAppend,
  guardSafetyAppend,
  isUuid,
  requireStorableCost,
  requireStorableRating,
  requireStorableRevision,
  requireStorableScale,
  requireUuid,
} from "./governance-guards.js";
import {
  SAFETY_METADATA_MARKER,
  UNKNOWN_SAFETY_ACTION,
  UNKNOWN_SAFETY_DETECTOR,
  UNKNOWN_SAFETY_SEVERITY,
  UNREADABLE_CRITERION_SNAPSHOT,
  UNREADABLE_EVAL_COST,
  UNREADABLE_SAFETY_METADATA,
  readCriterionSnapshot,
  readEvalCost,
  readSafetyAction,
  readSafetyDetector,
  readSafetyEnvelope,
  readSafetySeverity,
  scopedWhere,
  tenantWhere,
  writeCriterionSnapshot,
  writeSafetyEnvelope,
} from "./governance-rows.js";
import { UnreadableRowError } from "./mapping.js";

const SCOPE: EnvironmentScope = environmentScope(
  asGovernanceIdentifier("11111111-1111-4111-8111-111111111111"),
  asGovernanceIdentifier("22222222-2222-4222-8222-222222222222"),
  asGovernanceIdentifier("33333333-3333-4333-8333-333333333333"),
);

const SNAPSHOT: CriterionSnapshot = {
  name: "helpfulness",
  description: null,
  judgePrompt: "score {conversation}",
  rubric: null,
  judgeModel: null,
  scoreScaleMin: 0,
  scoreScaleMax: 1,
};

function admittedEvent(overrides: Partial<AdmittedSafetyEvent> = {}): AdmittedSafetyEvent {
  return {
    detector: "pii",
    action: "flag",
    severity: "high",
    detail: null,
    detailTruncated: false,
    metadata: null,
    agentId: null,
    threadId: null,
    turnId: null,
    principalId: null,
    toolName: null,
    toolCallId: null,
    rule: null,
    ...overrides,
  };
}

function admittedEval(overrides: Partial<AdmittedEval> = {}): AdmittedEval {
  return {
    agentId: asGovernanceIdentifier("44444444-4444-4444-8444-444444444444"),
    agentVersionId: null,
    threadId: asGovernanceIdentifier("55555555-5555-4555-8555-555555555555"),
    turnId: null,
    criterionId: asGovernanceIdentifier("66666666-6666-4666-8666-666666666666"),
    criterionSnapshot: SNAPSHOT,
    judgeModel: "anthropic:test",
    judgePromptUsed: "score",
    rawResponse: "{}",
    rawResponseTruncated: false,
    score: 100,
    rationale: null,
    passed: true,
    costCents: null,
    latencyMs: 1,
    ...overrides,
  };
}

function refusalOf(work: () => void): string {
  try {
    work();
  } catch (error) {
    if (error instanceof GovernanceWriteRefused) return error.code;
    return `<not-a-refusal:${String(error)}>`;
  }
  return "<accepted>";
}

function unreadableOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof UnreadableRowError) return error.code;
    return `<not-unreadable:${String(error)}>`;
  }
  return "<read>";
}

describe("the three vocabulary columns are validated, not cast", () => {
  test("a known value passes through unchanged", () => {
    expect(readSafetyDetector("dispatcher_permission_gate")).toBe("dispatcher_permission_gate");
    expect(readSafetyAction("redact")).toBe("redact");
    expect(readSafetySeverity("medium")).toBe("medium");
  });

  test("an unknown value in each column is refused, under its own code", () => {
    // THREE CODES. A binary that could not tell a wrong detector from a wrong
    // severity would report one incident for two different schema drifts.
    expect(unreadableOf(() => readSafetyDetector("PII"))).toBe(UNKNOWN_SAFETY_DETECTOR);
    expect(unreadableOf(() => readSafetyAction("blocked"))).toBe(UNKNOWN_SAFETY_ACTION);
    expect(unreadableOf(() => readSafetySeverity("critical"))).toBe(UNKNOWN_SAFETY_SEVERITY);
    expect(new Set([UNKNOWN_SAFETY_DETECTOR, UNKNOWN_SAFETY_ACTION, UNKNOWN_SAFETY_SEVERITY]).size).toBe(3);
  });
});

describe("the safety metadata envelope", () => {
  test("SQL NULL is a row with no attributes and no carried fields", () => {
    expect(readSafetyEnvelope(null)).toEqual({
      attributes: null,
      principalId: null,
      rule: null,
      detailTruncated: false,
    });
  });

  test("an object WITHOUT the marker is a legacy row, whole body as attributes", () => {
    // Expand/contract: a row written before this adapter existed still reads,
    // and its `principalId`-shaped attribute is NOT the ledger's subject.
    expect(readSafetyEnvelope({ principalId: "attribute", hits: 2 })).toEqual({
      attributes: { principalId: "attribute", hits: 2 },
      principalId: null,
      rule: null,
      detailTruncated: false,
    });
  });

  test("an object WITH the marker is decoded into its four parts", () => {
    const written = writeSafetyEnvelope(
      admittedEvent({
        metadata: { hits: 2 },
        principalId: "subject-a",
        rule: "pii.email",
        detailTruncated: true,
      }),
    );
    expect(written[SAFETY_METADATA_MARKER]).toBe(1);
    expect(readSafetyEnvelope(written)).toEqual({
      attributes: { hits: 2 },
      principalId: "subject-a",
      rule: "pii.email",
      detailTruncated: true,
    });
  });

  test("a null metadata round-trips as null rather than as an empty object", () => {
    expect(readSafetyEnvelope(writeSafetyEnvelope(admittedEvent())).attributes).toBeNull();
  });

  test("a malformed envelope is refused rather than half-read", () => {
    expect(
      unreadableOf(() => readSafetyEnvelope({ [SAFETY_METADATA_MARKER]: 1, principalId: 7 })),
    ).toBe(UNREADABLE_SAFETY_METADATA);
    expect(
      unreadableOf(() => readSafetyEnvelope({ [SAFETY_METADATA_MARKER]: 1, attributes: [1, 2] })),
    ).toBe(UNREADABLE_SAFETY_METADATA);
    expect(unreadableOf(() => readSafetyEnvelope("a string"))).toBe(UNREADABLE_SAFETY_METADATA);
  });

  test("a producer may not forge the marker at the root, but may nest it", () => {
    expect(refusalOf(() => guardSafetyAppend(admittedEvent({ metadata: { [SAFETY_METADATA_MARKER]: 1 } })))).toBe(
      SAFETY_METADATA_RESERVED,
    );
    expect(
      refusalOf(() => guardSafetyAppend(admittedEvent({ metadata: { inner: { [SAFETY_METADATA_MARKER]: 1 } } }))),
    ).toBe("<accepted>");
  });
});

describe("the criterion snapshot is refused rather than defaulted", () => {
  test("the seven fields round-trip", () => {
    expect(readCriterionSnapshot(writeCriterionSnapshot(SNAPSHOT))).toEqual(SNAPSHOT);
  });

  test("the write carries exactly seven keys, so an eighth cannot ride along", () => {
    expect(Object.keys(writeCriterionSnapshot(SNAPSHOT)).sort()).toEqual([
      "description",
      "judgeModel",
      "judgePrompt",
      "name",
      "rubric",
      "scoreScaleMax",
      "scoreScaleMin",
    ]);
  });

  test("a missing scale bound is refused, because a defaulted one re-renders history", () => {
    const { scoreScaleMax: _dropped, ...missing } = writeCriterionSnapshot(SNAPSHOT);
    expect(unreadableOf(() => readCriterionSnapshot(missing))).toBe(UNREADABLE_CRITERION_SNAPSHOT);
    expect(unreadableOf(() => readCriterionSnapshot(null))).toBe(UNREADABLE_CRITERION_SNAPSHOT);
  });
});

describe("`AgentEval.costCents` is a driver Decimal, not a number", () => {
  test("a decimal-like object is read through its own toString", () => {
    expect(readEvalCost({ toString: () => "0.012500" })).toBe(0.0125);
    expect(readEvalCost("1.5")).toBe(1.5);
    expect(readEvalCost(null)).toBeNull();
  });

  test("a value that is not a number after conversion is refused, not silently NaN", () => {
    expect(unreadableOf(() => readEvalCost({ toString: () => "not a number" }))).toBe(UNREADABLE_EVAL_COST);
  });
});

describe("the write guards refuse what the schema will not hold", () => {
  test("`@db.Uuid` — the doubles' own identifiers are refused", () => {
    expect(isUuid("00000000-0000-4000-8000-000000000000")).toBe(true);
    expect(isUuid("agent-1")).toBe(false);
    expect(isUuid("criterion-0001")).toBe(false);
    expect(refusalOf(() => requireUuid("x", "agent-1"))).toBe(GOVERNANCE_IDENTIFIER_NOT_UUID);
    // Null is always allowed: three of these foreign keys are nullable.
    expect(refusalOf(() => requireUuid("x", null))).toBe("<accepted>");
  });

  test("`MessageRating_rating_check` admits 1..5 and refuses the domain's -1", () => {
    expect(refusalOf(() => requireStorableRating(1))).toBe("<accepted>");
    // A legacy five-star value is STORABLE even though the domain never mints
    // one, because the guard's bound is the CHECK's and not the domain's.
    expect(refusalOf(() => requireStorableRating(5))).toBe("<accepted>");
    expect(refusalOf(() => requireStorableRating(-1))).toBe(RATING_OUTSIDE_SCHEMA_RANGE);
    expect(refusalOf(() => requireStorableRating(6))).toBe(RATING_OUTSIDE_SCHEMA_RANGE);
    expect(refusalOf(() => requireStorableRating(1.5))).toBe(RATING_OUTSIDE_SCHEMA_RANGE);
  });

  test("`revision` is a positive int4, under a code of its own", () => {
    expect(refusalOf(() => requireStorableRevision(1))).toBe("<accepted>");
    expect(refusalOf(() => requireStorableRevision(0))).toBe(RATING_REVISION_INVALID);
    expect(refusalOf(() => requireStorableRevision(2 ** 40))).toBe(RATING_REVISION_INVALID);
    expect(RATING_REVISION_INVALID).not.toBe(RATING_OUTSIDE_SCHEMA_RANGE);
  });

  test("`Decimal(18, 6)` refuses what it would ROUND, not only what it would overflow", () => {
    expect(refusalOf(() => requireStorableCost(0.0125))).toBe("<accepted>");
    expect(refusalOf(() => requireStorableCost(null))).toBe("<accepted>");
    // Silently rounded to 0.000001 by the column, so read back different from
    // written. That is the failure this guard exists for.
    expect(refusalOf(() => requireStorableCost(0.0000005))).toBe(EVAL_COST_NOT_REPRESENTABLE);
    expect(refusalOf(() => requireStorableCost(1e13))).toBe(EVAL_COST_NOT_REPRESENTABLE);
    expect(refusalOf(() => requireStorableCost(Number.NaN))).toBe(EVAL_COST_NOT_REPRESENTABLE);
  });

  test("an eval's score, latency and scale each have their own refusal", () => {
    expect(refusalOf(() => guardEvalAppend(admittedEval()))).toBe("<accepted>");
    expect(refusalOf(() => guardEvalAppend(admittedEval({ score: Number.NaN })))).toBe(
      EVAL_SCORE_NOT_FINITE,
    );
    expect(refusalOf(() => guardEvalAppend(admittedEval({ latencyMs: -1 })))).toBe(EVAL_LATENCY_INVALID);
    expect(refusalOf(() => guardEvalAppend(admittedEval({ latencyMs: 2 ** 40 })))).toBe(
      EVAL_LATENCY_INVALID,
    );
    expect(
      refusalOf(() =>
        guardEvalAppend(
          admittedEval({ criterionSnapshot: { ...SNAPSHOT, scoreScaleMax: 2 ** 40 } }),
        ),
      ),
    ).toBe(CRITERION_SCALE_NOT_REPRESENTABLE);
    expect(refusalOf(() => requireStorableScale(0, 1))).toBe("<accepted>");
  });

  test("the nine refusal codes are nine distinct strings", () => {
    // Two guards returning one code cannot be told apart in a log. The SET is
    // asserted rather than each pair, so a future guard that reuses a sibling's
    // code fails here rather than in an incident.
    const codes = [
      GOVERNANCE_IDENTIFIER_NOT_UUID,
      RATING_OUTSIDE_SCHEMA_RANGE,
      RATING_REVISION_INVALID,
      SAFETY_METADATA_RESERVED,
      EVAL_SCORE_NOT_FINITE,
      EVAL_COST_NOT_REPRESENTABLE,
      EVAL_LATENCY_INVALID,
      CRITERION_SCALE_NOT_REPRESENTABLE,
      UNREADABLE_SAFETY_METADATA,
    ];
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("scope narrowing", () => {
  test("an environment read is keyed on the environment", () => {
    expect(scopedWhere(SCOPE)).toEqual({ environmentId: SCOPE.environmentId });
  });

  test("a tenant scope becomes a RELATION filter, resolved in the same statement", () => {
    // The obvious wrong implementation reads the environments a scope reaches
    // and then queries once per environment: an N+1 in the tenant tree.
    expect(tenantWhere(SCOPE)).toEqual({ environmentId: SCOPE.environmentId });
    const project: TenantScope = {
      level: "project",
      organizationId: SCOPE.organizationId,
      projectId: SCOPE.projectId,
    };
    expect(tenantWhere(project)).toEqual({ environment: { projectId: SCOPE.projectId } });
    const organization: TenantScope = { level: "organization", organizationId: SCOPE.organizationId };
    expect(tenantWhere(organization)).toEqual({
      environment: { project: { organizationId: SCOPE.organizationId } },
    });
  });
});
