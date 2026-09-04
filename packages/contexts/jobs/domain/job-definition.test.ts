import { describe, expect, it } from "vitest";

import {
  admitJobDefinition,
  JOB_DEFINITION_DEFAULTS,
  JOB_DEFINITION_LIMITS,
  registrationStatus,
  type JobDefinitionDraft,
} from "./job-definition.js";

function draft(overrides: Partial<JobDefinitionDraft> = {}): JobDefinitionDraft {
  return {
    jobKey: "nightly-rollup",
    displayName: "Nightly rollup",
    handler: "async function run(payload, ctx) { return 1; }",
    ...overrides,
  };
}

function violationsOf(result: ReturnType<typeof admitJobDefinition>): readonly string[] {
  if (result.ok) throw new Error("expected a refusal");
  return result.error.fields.map((field) => field.field);
}

describe("admitJobDefinition — the happy path", () => {
  it("admits a minimal draft and applies the live defaults", () => {
    const admitted = admitJobDefinition(draft());
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.invocationType).toBe(JOB_DEFINITION_DEFAULTS.invocationType);
    expect(admitted.value.budget.timeoutSeconds).toBe(JOB_DEFINITION_DEFAULTS.timeoutSeconds);
    expect(admitted.value.budget.maxRetries).toBe(JOB_DEFINITION_DEFAULTS.maxRetries);
    expect(admitted.value.allowedAgentIds).toEqual([]);
  });

  it("defaults maxRetries to the value the SUPPORTED surface passes, not the column default", () => {
    // The column default is 0; the live MCP create path passes 3.
    expect(JOB_DEFINITION_DEFAULTS.maxRetries).toBe(3);
  });
});

describe("trimming is part of the rule", () => {
  it("trims displayName before storing it", () => {
    const admitted = admitJobDefinition(draft({ displayName: "  Rollup  " }));
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.displayName).toBe("Rollup");
  });

  it("REFUSES a displayName that is only whitespace", () => {
    expect(violationsOf(admitJobDefinition(draft({ displayName: "   " })))).toContain("displayName");
  });

  it("REFUSES a handler that is only whitespace", () => {
    expect(violationsOf(admitJobDefinition(draft({ handler: "  \n " })))).toContain("handler");
  });

  it("STORES the handler untrimmed — leading whitespace is meaningful in source", () => {
    const source = "\n  async function run() {}\n";
    const admitted = admitJobDefinition(draft({ handler: source }));
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.handler).toBe(source);
  });

  it("normalises an empty optional string to null rather than storing it", () => {
    const admitted = admitJobDefinition(draft({ description: "   ", scheduleCron: "" }));
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.description).toBeNull();
    expect(admitted.value.schedule.cron).toBeNull();
  });
});

describe("bounds", () => {
  it("REFUSES an invalid job key", () => {
    expect(violationsOf(admitJobDefinition(draft({ jobKey: "NOT VALID" })))).toContain("jobKey");
  });

  it("REFUSES an over-long displayName", () => {
    const long = "x".repeat(JOB_DEFINITION_LIMITS.maxDisplayNameLength + 1);
    expect(violationsOf(admitJobDefinition(draft({ displayName: long })))).toContain("displayName");
  });

  it("REFUSES an over-long handler", () => {
    const long = `//${"x".repeat(JOB_DEFINITION_LIMITS.maxHandlerLength)}`;
    expect(violationsOf(admitJobDefinition(draft({ handler: long })))).toContain("handler");
  });

  it("REFUSES an over-long description", () => {
    const long = "x".repeat(JOB_DEFINITION_LIMITS.maxDescriptionLength + 1);
    expect(violationsOf(admitJobDefinition(draft({ description: long })))).toContain("description");
  });

  it.each([
    [JOB_DEFINITION_LIMITS.minTimeoutSeconds - 1],
    [JOB_DEFINITION_LIMITS.maxTimeoutSeconds + 1],
    [12.5],
  ])("REFUSES timeoutSeconds %s", (value) => {
    expect(violationsOf(admitJobDefinition(draft({ timeoutSeconds: value })))).toContain("timeoutSeconds");
  });

  it.each([[-1], [JOB_DEFINITION_LIMITS.maxRetries + 1]])("REFUSES maxRetries %s", (value) => {
    expect(violationsOf(admitJobDefinition(draft({ maxRetries: value })))).toContain("maxRetries");
  });

  it("accepts the exact bounds", () => {
    const admitted = admitJobDefinition(
      draft({
        timeoutSeconds: JOB_DEFINITION_LIMITS.maxTimeoutSeconds,
        maxRetries: JOB_DEFINITION_LIMITS.maxRetries,
      }),
    );
    expect(admitted.ok).toBe(true);
  });

  it("REFUSES more agent ids than the limit", () => {
    const many = Array.from({ length: JOB_DEFINITION_LIMITS.maxAllowedAgentIds + 1 }, (_, i) => `agent-${i}`);
    expect(violationsOf(admitJobDefinition(draft({ allowedAgentIds: many })))).toContain("allowedAgentIds");
  });

  it("drops empty agent ids rather than storing them", () => {
    const admitted = admitJobDefinition(draft({ allowedAgentIds: ["agent-1", "", "agent-2"] }));
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.allowedAgentIds).toEqual(["agent-1", "agent-2"]);
  });

  it("REFUSES an unknown invocation type", () => {
    expect(violationsOf(admitJobDefinition(draft({ invocationType: "cron" })))).toContain("invocationType");
  });

  it("REFUSES `agent` as an invocation type — it is an invoker, not a row value", () => {
    expect(violationsOf(admitJobDefinition(draft({ invocationType: "agent" })))).toContain("invocationType");
  });
});

describe("violations are collected, not short-circuited", () => {
  it("reports EVERY bad field at once", () => {
    const fields = violationsOf(
      admitJobDefinition(
        draft({ jobKey: "BAD KEY", displayName: "", handler: "", timeoutSeconds: 0, maxRetries: 99 }),
      ),
    );
    expect(fields).toEqual(
      expect.arrayContaining(["jobKey", "displayName", "handler", "timeoutSeconds", "maxRetries"]),
    );
  });

  it("carries the single JOBS_JOB_DEFINITION_INVALID code", () => {
    const refused = admitJobDefinition(draft({ displayName: "" }));
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error.code).toBe("JOBS_JOB_DEFINITION_INVALID");
    expect(refused.error.category).toBe("invalid_input");
  });
});

describe("registrationStatus", () => {
  it("is active when the handler parses", () => {
    expect(registrationStatus(null)).toBe("active");
  });

  it("is registration-failed when it does not — the row is KEPT", () => {
    expect(registrationStatus("Unexpected token")).toBe("registration-failed");
  });
});
