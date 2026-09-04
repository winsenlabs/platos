import {
  asIdentifier,
  environmentScope,
  organizationScope,
  projectScope,
  type EnvironmentId,
  type PrincipalId,
  type SafetyObservation,
} from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { SAFETY_SINK_DROP_MESSAGE, createGovernanceSafetyEventSink } from "./safety-event-sink.js";
import { buildGovernanceTestContext, type GovernanceTestContext } from "./testing/index.js";

function observation(
  context: GovernanceTestContext,
  overrides: Partial<SafetyObservation> = {},
): SafetyObservation {
  return {
    rule: "identity.rate_limit.exceeded",
    outcome: "blocked",
    scope: context.scope,
    principalId: asIdentifier<PrincipalId>("principal-1"),
    observedAt: context.clock.now(),
    details: { bucket: "per-principal" },
    ...overrides,
  };
}

function drops(context: GovernanceTestContext) {
  return context.logger.matching("warn", SAFETY_SINK_DROP_MESSAGE);
}

describe("the happy path — the inversion this port exists for", () => {
  it("writes the rate-limit guard's observation into the ledger", async () => {
    const context = buildGovernanceTestContext();
    const sink = createGovernanceSafetyEventSink(context.dependencies);
    await sink.record(observation(context));

    expect(context.safety.size()).toBe(1);
    const [row] = context.safety.all();
    expect(row?.detector).toBe("rate_limit");
    expect(row?.action).toBe("block");
    expect(row?.severity).toBe("high");
    expect(row?.principalId).toBe("principal-1");
    expect(row?.environmentId).toBe("env-1");
  });

  it("logs nothing when it succeeds", async () => {
    const context = buildGovernanceTestContext();
    await createGovernanceSafetyEventSink(context.dependencies).record(observation(context));
    expect(drops(context)).toHaveLength(0);
  });

  it("preserves the kernel's own outcome word in the row's metadata", async () => {
    const context = buildGovernanceTestContext();
    await createGovernanceSafetyEventSink(context.dependencies).record(
      observation(context, { outcome: "held" }),
    );
    expect(context.safety.all()[0]?.metadata).toMatchObject({ __outcome: "held" });
  });
});

describe("the port's contract: never throw, never fail the caller", () => {
  it("resolves rather than rejecting when the rule is malformed", async () => {
    const context = buildGovernanceTestContext();
    const sink = createGovernanceSafetyEventSink(context.dependencies);
    await expect(sink.record(observation(context, { rule: "nope" }))).resolves.toBeUndefined();
  });

  it("WRITES NOTHING for a malformed rule, and says why", async () => {
    const context = buildGovernanceTestContext();
    await createGovernanceSafetyEventSink(context.dependencies).record(
      observation(context, { rule: "nope" }),
    );
    expect(context.safety.size()).toBe(0);
    expect(drops(context)).toHaveLength(1);
    expect(drops(context)[0]?.fields).toMatchObject({
      rule: "nope",
      reason: "GOVERNANCE_SAFETY_RULE_MALFORMED",
    });
  });

  it("WRITES NOTHING for a detector the ledger has no bucket for, with its own reason", async () => {
    const context = buildGovernanceTestContext();
    await createGovernanceSafetyEventSink(context.dependencies).record(
      observation(context, { rule: "identity.vibes.exceeded" }),
    );
    expect(context.safety.size()).toBe(0);
    expect(drops(context)[0]?.fields).toMatchObject({ reason: "GOVERNANCE_SAFETY_DETECTOR_UNKNOWN" });
  });

  it("drops an ORGANIZATION-scoped observation rather than inventing an environment", async () => {
    // `SafetyEvent` hangs off `Environment`. There is no row for an
    // organization-addressed observation to be, and filing it against an
    // arbitrary environment would be worse than a visible gap.
    const context = buildGovernanceTestContext();
    await createGovernanceSafetyEventSink(context.dependencies).record(
      observation(context, { scope: organizationScope(asIdentifier("org-1")) }),
    );
    expect(context.safety.size()).toBe(0);
    expect(drops(context)[0]?.fields).toMatchObject({
      reason: "SCOPE_NOT_ENVIRONMENT",
      scopeLevel: "organization",
    });
  });

  it("drops a PROJECT-scoped observation for the same reason", async () => {
    const context = buildGovernanceTestContext();
    await createGovernanceSafetyEventSink(context.dependencies).record(
      observation(context, { scope: projectScope(asIdentifier("org-1"), asIdentifier("proj-1")) }),
    );
    expect(context.safety.size()).toBe(0);
    expect(drops(context)[0]?.fields).toMatchObject({ scopeLevel: "project" });
  });

  it("resolves and logs when the LEDGER is down, rather than failing the caller", async () => {
    const context = buildGovernanceTestContext();
    context.safety.failNext("store down");
    const sink = createGovernanceSafetyEventSink(context.dependencies);
    await expect(sink.record(observation(context))).resolves.toBeUndefined();
    expect(context.safety.size()).toBe(0);
    expect(drops(context)[0]?.fields).toMatchObject({ reason: "GOVERNANCE_LEDGER_UNAVAILABLE" });
  });

  it("resolves and logs when this module itself THROWS", async () => {
    // A defect in the sink must not become the caller's problem either.
    const context = buildGovernanceTestContext();
    const sink = createGovernanceSafetyEventSink(context.dependencies);
    const broken = observation(context);
    Object.defineProperty(broken, "rule", {
      get(): string {
        throw new Error("exploding observation");
      },
    });
    await expect(sink.record(broken)).resolves.toBeUndefined();
    expect(drops(context)[0]?.fields).toMatchObject({ reason: "SINK_THREW", thrown: "exploding observation" });
    // The reporting path reads the same misbehaving value, so it must not be
    // able to re-raise what it is reporting.
    expect(drops(context)[0]?.fields).toMatchObject({ rule: "<unreadable>" });
    expect(context.safety.size()).toBe(0);
  });

  it("carries the rule and the outcome on EVERY drop, so a gap is diagnosable", async () => {
    const context = buildGovernanceTestContext();
    const sink = createGovernanceSafetyEventSink(context.dependencies);
    await sink.record(observation(context, { rule: "nope", outcome: "redacted" }));
    expect(drops(context)[0]?.fields).toMatchObject({ rule: "nope", outcome: "redacted" });
  });

  it("logs at WARN, not at debug — a dropped safety signal is not routine", async () => {
    const context = buildGovernanceTestContext();
    await createGovernanceSafetyEventSink(context.dependencies).record(observation(context, { rule: "nope" }));
    expect(context.logger.lines[0]?.level).toBe("warn");
  });
});

describe("the sink does not consult the caller's authorization", () => {
  it("writes without a grant — the enforcement layer holds none", async () => {
    // The rate-limit guard is not acting for an operator; requiring a grant here
    // would make the inversion unusable and push the edge back into
    // identity-access.
    const context = buildGovernanceTestContext();
    await createGovernanceSafetyEventSink(context.dependencies).record(observation(context));
    expect(context.safety.size()).toBe(1);
  });

  it("writes into the environment the OBSERVATION carried, not into a default", async () => {
    const context = buildGovernanceTestContext();
    const elsewhere = environmentScope(
      context.scope.organizationId,
      context.scope.projectId,
      asIdentifier<EnvironmentId>("env-9"),
    );
    await createGovernanceSafetyEventSink(context.dependencies).record(
      observation(context, { scope: elsewhere }),
    );
    expect(context.safety.all()[0]?.environmentId).toBe("env-9");
  });
});
