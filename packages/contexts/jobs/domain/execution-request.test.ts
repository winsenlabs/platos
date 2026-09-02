import { describe, expect, it } from "vitest";

import { admitExecutionRequest, digestSubject, IDENTIFIER_PATTERN } from "./execution-request.js";
import { stableJson } from "./payload.js";

const NO_SECRETS: readonly string[] = [];

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "req-1",
    jobId: "job-1",
    payload: {},
    scope: { organizationId: "org-1", projectId: "proj-1", environmentId: "env-1" },
    invokedBy: "manual",
    ...overrides,
  };
}

describe("admitExecutionRequest — the closed key set", () => {
  it("admits a well-formed body", () => {
    const admitted = admitExecutionRequest(body(), NO_SECRETS);
    expect(admitted.ok).toBe(true);
  });

  it("REFUSES an undeclared top-level key rather than ignoring it", () => {
    const admitted = admitExecutionRequest(body({ priority: "high" }), NO_SECRETS);
    expect(admitted.ok).toBe(false);
    if (admitted.ok) throw new Error("unreachable");
    expect(admitted.error.code).toBe("INVALID_REQUEST");
  });

  it("REFUSES an undeclared key inside scope", () => {
    const admitted = admitExecutionRequest(
      body({ scope: { organizationId: "org-1", projectId: "proj-1", environmentId: "env-1", region: "eu" } }),
      NO_SECRETS,
    );
    expect(admitted.ok).toBe(false);
  });

  it("REFUSES a non-object body", () => {
    expect(admitExecutionRequest("nope", NO_SECRETS).ok).toBe(false);
    expect(admitExecutionRequest(null, NO_SECRETS).ok).toBe(false);
    expect(admitExecutionRequest([], NO_SECRETS).ok).toBe(false);
  });
});

describe("identifier shape", () => {
  it("accepts the live alphabet", () => {
    expect(IDENTIFIER_PATTERN.test("abc.DEF_012:xy-z")).toBe(true);
  });

  it("REFUSES a leading separator", () => {
    expect(IDENTIFIER_PATTERN.test("-leading")).toBe(false);
    expect(IDENTIFIER_PATTERN.test(".leading")).toBe(false);
  });

  it("REFUSES an empty string and one over 128 characters", () => {
    expect(IDENTIFIER_PATTERN.test("")).toBe(false);
    expect(IDENTIFIER_PATTERN.test(`a${"b".repeat(128)}`)).toBe(false);
    expect(IDENTIFIER_PATTERN.test(`a${"b".repeat(127)}`)).toBe(true);
  });

  it.each(["requestId", "jobId"])("REFUSES a malformed %s", (field) => {
    expect(admitExecutionRequest(body({ [field]: "has space" }), NO_SECRETS).ok).toBe(false);
  });

  it.each(["organizationId", "projectId", "environmentId"])("REFUSES a malformed scope.%s", (field) => {
    const scope = { organizationId: "org-1", projectId: "proj-1", environmentId: "env-1", [field]: "!bad" };
    expect(admitExecutionRequest(body({ scope }), NO_SECRETS).ok).toBe(false);
  });

  it("REFUSES a malformed userId but permits its absence", () => {
    const bad = { organizationId: "org-1", projectId: "proj-1", environmentId: "env-1", userId: "!bad" };
    expect(admitExecutionRequest(body({ scope: bad }), NO_SECRETS).ok).toBe(false);
    const good = { organizationId: "org-1", projectId: "proj-1", environmentId: "env-1", userId: "user-1" };
    expect(admitExecutionRequest(body({ scope: good }), NO_SECRETS).ok).toBe(true);
  });
});

describe("the invoker/agent coupling is BIDIRECTIONAL", () => {
  it("REFUSES an agent dispatch with no agentId", () => {
    expect(admitExecutionRequest(body({ invokedBy: "agent" }), NO_SECRETS).ok).toBe(false);
  });

  it("REFUSES a NON-agent dispatch that carries an agentId", () => {
    // The rule an extraction tends to drop. Without it, a manual dispatch reads
    // as agent-attributed in a log and is never checked against the allow-list.
    const admitted = admitExecutionRequest(body({ invokedBy: "manual", agentId: "agent-1" }), NO_SECRETS);
    expect(admitted.ok).toBe(false);
    if (admitted.ok) throw new Error("unreachable");
    expect(admitted.error.message).toContain("only an agent dispatch");
  });

  it("REFUSES a malformed agentId on an agent dispatch", () => {
    expect(admitExecutionRequest(body({ invokedBy: "agent", agentId: "!bad" }), NO_SECRETS).ok).toBe(false);
  });

  it("admits an agent dispatch carrying a well-formed agentId", () => {
    const admitted = admitExecutionRequest(body({ invokedBy: "agent", agentId: "agent-1" }), NO_SECRETS);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.agentId).toBe("agent-1");
  });

  it("REFUSES an unrecognised invoker", () => {
    expect(admitExecutionRequest(body({ invokedBy: "cron" }), NO_SECRETS).ok).toBe(false);
  });

  it("REFUSES `agent-spawn` as an invoker — it is a row value", () => {
    expect(admitExecutionRequest(body({ invokedBy: "agent-spawn" }), NO_SECRETS).ok).toBe(false);
  });
});

describe("payload admission", () => {
  it("defaults an absent payload to an empty object", () => {
    const noPayload = body();
    delete noPayload["payload"];
    const admitted = admitExecutionRequest(noPayload, NO_SECRETS);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.payload).toEqual({});
  });

  it("REFUSES a non-object payload", () => {
    expect(admitExecutionRequest(body({ payload: "text" }), NO_SECRETS).ok).toBe(false);
    expect(admitExecutionRequest(body({ payload: [1, 2] }), NO_SECRETS).ok).toBe(false);
  });

  it("REFUSES a payload carrying a sensitive key", () => {
    expect(admitExecutionRequest(body({ payload: { apiKey: "x" } }), NO_SECRETS).ok).toBe(false);
  });

  it("REFUSES a payload quoting a known secret", () => {
    expect(admitExecutionRequest(body({ payload: { note: "tok-abc" } }), ["tok-abc"]).ok).toBe(false);
  });

  it("REFUSES an oversized payload", () => {
    expect(admitExecutionRequest(body({ payload: { blob: "x".repeat(70_000) } }), NO_SECRETS).ok).toBe(false);
  });
});

describe("digestSubject", () => {
  it("OMITS agentId entirely for a non-agent dispatch", () => {
    const admitted = admitExecutionRequest(body(), NO_SECRETS);
    if (!admitted.ok) throw new Error("unreachable");
    expect(Object.keys(digestSubject(admitted.value) as object)).not.toContain("agentId");
  });

  it("INCLUDES agentId for an agent dispatch", () => {
    const admitted = admitExecutionRequest(body({ invokedBy: "agent", agentId: "agent-1" }), NO_SECRETS);
    if (!admitted.ok) throw new Error("unreachable");
    expect(Object.keys(digestSubject(admitted.value) as object)).toContain("agentId");
  });

  it("OMITS userId when absent, so a null does not change the digest", () => {
    const admitted = admitExecutionRequest(body(), NO_SECRETS);
    if (!admitted.ok) throw new Error("unreachable");
    const subject = digestSubject(admitted.value) as { scope: object };
    expect(Object.keys(subject.scope)).not.toContain("userId");
  });

  it("is stable across payload key order", () => {
    const first = admitExecutionRequest(body({ payload: { a: 1, b: 2 } }), NO_SECRETS);
    const second = admitExecutionRequest(body({ payload: { b: 2, a: 1 } }), NO_SECRETS);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(stableJson(digestSubject(first.value))).toBe(stableJson(digestSubject(second.value)));
  });

  it("differs when the payload differs", () => {
    const first = admitExecutionRequest(body({ payload: { a: 1 } }), NO_SECRETS);
    const second = admitExecutionRequest(body({ payload: { a: 2 } }), NO_SECRETS);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(stableJson(digestSubject(first.value))).not.toBe(stableJson(digestSubject(second.value)));
  });
});
