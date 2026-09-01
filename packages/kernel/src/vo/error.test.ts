import { describe, expect, it } from "vitest";

import { domainError, err, isOk, ok, unwrap } from "./error.js";

describe("canonical error codes", () => {
  it.each(["NOT_FOUND", "RATE_LIMITED", "IDEMPOTENCY_KEY_REQUIRED", "E2E_OK", "A"])(
    "accepts the SCREAMING_SNAKE code %o that M0.4 §2 puts on the wire",
    (code) => {
      expect(domainError(code, "not_found", "x").code).toBe(code);
    },
  );

  it.each(["notFound", "not_found", "NOT-FOUND", "NOT__FOUND", "_NOT_FOUND", "NOT_FOUND_", "1_BAD", ""])(
    "rejects %o, because an error code is an immutable wire contract",
    (code) => {
      expect(() => domainError(code, "not_found", "x")).toThrow(/must be SCREAMING_SNAKE_CASE/u);
    },
  );

  it("is frozen, so a transport cannot mutate an error on its way out", () => {
    const error = domainError("FORBIDDEN", "forbidden", "no");
    expect(Object.isFrozen(error)).toBe(true);
    expect(Object.isFrozen(error.fields)).toBe(true);
    expect(Object.isFrozen(error.details)).toBe(true);
  });

  it("defaults retryAfterSeconds to null and carries it when given", () => {
    expect(domainError("X", "internal", "m").retryAfterSeconds).toBeNull();
    expect(domainError("RATE_LIMITED", "rate_limited", "m", { retryAfterSeconds: 30 }).retryAfterSeconds).toBe(30);
  });

  it("copies fields and details rather than aliasing the caller's arrays", () => {
    const fields = [{ field: "a", code: "REQUIRED", message: "m" }];
    const error = domainError("INVALID_INPUT", "invalid_input", "m", { fields });
    fields.push({ field: "b", code: "REQUIRED", message: "m" });
    expect(error.fields).toHaveLength(1);
  });
});

describe("Result makes every failure a caller must handle visible in the type", () => {
  it("narrows on ok", () => {
    const result = ok(42);
    expect(isOk(result)).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
    expect(unwrap(result)).toBe(42);
  });

  it("carries the error on failure", () => {
    const error = domainError("NOT_FOUND", "not_found", "no such session");
    const result = err<number>(error);
    expect(isOk(result)).toBe(false);
    if (!result.ok) expect(result.error).toBe(error);
  });

  it("unwrap throws with the code and message, for tests and composition roots", () => {
    expect(() => unwrap(err(domainError("NOT_FOUND", "not_found", "no such session")))).toThrow(
      "NOT_FOUND: no such session",
    );
  });
});
