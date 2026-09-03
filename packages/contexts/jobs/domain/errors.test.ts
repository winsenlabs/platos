import { describe, expect, it } from "vitest";

import {
  JOB_EXECUTION_ERROR_CATEGORY,
  JOB_EXECUTION_ERROR_CODES,
  JOBS_ERROR_CODES,
  isJobExecutionErrorCode,
  invalidRequest,
  idempotencyUnavailable,
  jobNotAuthorized,
  jobServiceUnavailable,
  replayedExecutionFailure,
} from "./errors.js";

describe("the inherited execution codes", () => {
  // These eleven are the live `JobExecutionErrorCode` union. M0.4 §2 makes
  // renaming one a breaking change, so the list is pinned verbatim.
  it("is exactly the live union, in the live order", () => {
    expect([...JOB_EXECUTION_ERROR_CODES]).toEqual([
      "INVALID_REQUEST",
      "JOB_NOT_FOUND_OR_INACTIVE",
      "JOB_NOT_AUTHORIZED",
      "JOB_NOT_REGISTERED",
      "IDEMPOTENCY_CONFLICT",
      "IDEMPOTENCY_IN_PROGRESS",
      "IDEMPOTENCY_UNAVAILABLE",
      "JOB_SERVICE_UNAVAILABLE",
      "JOB_TIMEOUT",
      "JOB_EXECUTION_FAILED",
      "JOB_RESULT_REJECTED",
    ]);
  });

  it("carries NO context prefix — these names are the wire contract", () => {
    for (const code of JOB_EXECUTION_ERROR_CODES) {
      expect(code.startsWith("JOBS_")).toBe(false);
    }
  });

  it("has a category for every code and no extras", () => {
    expect(Object.keys(JOB_EXECUTION_ERROR_CATEGORY).sort()).toEqual([...JOB_EXECUTION_ERROR_CODES].sort());
  });

  it.each([
    "INVALID_REQUEST",
    "JOB_NOT_FOUND_OR_INACTIVE",
    "JOB_NOT_AUTHORIZED",
    "JOB_NOT_REGISTERED",
    "IDEMPOTENCY_CONFLICT",
    "IDEMPOTENCY_IN_PROGRESS",
    "IDEMPOTENCY_UNAVAILABLE",
    "JOB_SERVICE_UNAVAILABLE",
    "JOB_TIMEOUT",
    "JOB_EXECUTION_FAILED",
    "JOB_RESULT_REJECTED",
  ] as const)("recognises %s", (code) => {
    expect(isJobExecutionErrorCode(code)).toBe(true);
  });

  it("does not recognise a minted code as an inherited one", () => {
    expect(isJobExecutionErrorCode("JOBS_APPROVAL_NOT_FOUND")).toBe(false);
  });

  it("is not fooled by a prototype key", () => {
    expect(isJobExecutionErrorCode("constructor")).toBe(false);
    expect(isJobExecutionErrorCode("toString")).toBe(false);
  });
});

describe("the minted codes", () => {
  it("all carry the context prefix", () => {
    for (const code of JOBS_ERROR_CODES) {
      expect(code.startsWith("JOBS_")).toBe(true);
    }
  });

  it("does not collide with an inherited code", () => {
    const inherited = new Set<string>(JOB_EXECUTION_ERROR_CODES);
    for (const code of JOBS_ERROR_CODES) expect(inherited.has(code)).toBe(false);
  });
});

describe("every code is SCREAMING_SNAKE", () => {
  // M0.4 §2 requires it, and `domainError` throws on a malformed code. Asserted
  // as ONE case that walks both catalogues rather than a table per code: the
  // property is "all of them", and a spread table cannot be statically counted
  // by the test-case census.
  it("holds for every code in both catalogues", () => {
    const pattern = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;
    const all = [...JOB_EXECUTION_ERROR_CODES, ...JOBS_ERROR_CODES];
    expect(all.length).toBeGreaterThan(0);
    const malformed = all.filter((code) => !pattern.test(code));
    expect(malformed).toEqual([]);
  });
});

describe("error values", () => {
  it("is frozen, so a caller cannot mutate a shared error", () => {
    const error = invalidRequest("nope");
    expect(Object.isFrozen(error)).toBe(true);
  });

  it("populates retryAfterSeconds only for the unavailable codes", () => {
    expect(jobServiceUnavailable("down").retryAfterSeconds).toBe(5);
    expect(idempotencyUnavailable("down").retryAfterSeconds).toBe(5);
    expect(invalidRequest("nope").retryAfterSeconds).toBeNull();
  });

  it("carries field violations through", () => {
    const error = invalidRequest("bad", [{ field: "jobId", code: "INVALID", message: "no" }]);
    expect(error.fields).toHaveLength(1);
  });

  it("carries authorization details without leaking anything else", () => {
    const error = jobNotAuthorized("no", { invokedBy: "manual" });
    expect(error.category).toBe("forbidden");
    expect(error.details).toEqual({ invokedBy: "manual" });
  });
});

describe("replayedExecutionFailure", () => {
  it("keeps the original code so a caller branches the same way", () => {
    expect(replayedExecutionFailure("JOB_TIMEOUT").code).toBe("JOB_TIMEOUT");
  });

  it("recovers the category from the code alone", () => {
    expect(replayedExecutionFailure("JOB_TIMEOUT").category).toBe("unavailable");
    expect(replayedExecutionFailure("JOB_EXECUTION_FAILED").category).toBe("internal");
    expect(replayedExecutionFailure("JOB_RESULT_REJECTED").category).toBe("invalid_input");
  });

  it("marks itself as a replay rather than inventing the original details", () => {
    expect(replayedExecutionFailure("JOB_EXECUTION_FAILED").details).toEqual({ replayed: true });
  });
});
