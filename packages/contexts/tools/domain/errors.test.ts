import { describe, expect, it } from "vitest";

import * as errors from "./errors.js";

const SCREAMING_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;

/** Every factory, called with plausible arguments, once. */
const MINTED = [
  errors.declarationInvalid("x"),
  errors.duplicateToolName("files.upload"),
  errors.entityNotInScope("entity-1"),
  errors.environmentNotInScope("env-1"),
  errors.toolNotFound("tool-1"),
  errors.exposureNotFound("exposure-1"),
  errors.routeNotInScope("files.upload", ["acme"]),
  errors.routeAmbiguous("files.upload", [{ entityId: "acme", toolId: "tool-1" }]),
  errors.entityNotDispatchable("entity-1", "no transport"),
  errors.permissionBlocked("gdpr.purge", 1, "platform-tier block"),
  errors.approvalRequired("gdpr.purge", 1),
  errors.argumentsInvalid("files.upload", []),
  errors.endUserRequired("composio.list"),
  errors.credentialUnavailable("missing"),
  errors.residualTemplate("{{endUserId}}"),
  errors.dispatchFailed("connection reset"),
  errors.dispatchRateLimited("files.upload", 30),
  errors.mcpDisabled("entity-1"),
  errors.mcpTransportInvalid("bad", "carrier-pigeon"),
  errors.policyPatternInvalid("too long"),
  errors.policyEffectUnsupported("require_approval"),
  errors.callSequenceConflict("step-1", 0),
  errors.callTransitionInvalid("SUCCEEDED", "ACTIVE"),
  errors.scopeMismatch("org/a", "org/b"),
  errors.repositoryUnavailable("down"),
];

describe("the catalogue", () => {
  it("mints every code it declares, and declares every code it mints", () => {
    const declared = new Set<string>(errors.TOOLS_ERROR_CODES);
    const minted = new Set(MINTED.map((error) => error.code));
    expect([...minted].filter((code) => !declared.has(code))).toEqual([]);
    expect([...declared].filter((code) => !minted.has(code))).toEqual([]);
  });

  it("uses SCREAMING_SNAKE throughout, which M0.4 §2 fixes as immutable in a major", () => {
    for (const code of errors.TOOLS_ERROR_CODES) {
      expect(SCREAMING_SNAKE.test(code), code).toBe(true);
    }
  });

  it("names each code once", () => {
    expect(new Set(errors.TOOLS_ERROR_CODES).size).toBe(errors.TOOLS_ERROR_CODES.length);
  });

  it("prefixes every code with the owning context", () => {
    for (const code of errors.TOOLS_ERROR_CODES) {
      expect(code.startsWith("TOOLS_"), code).toBe(true);
    }
  });
});

describe("what a message may carry", () => {
  it("never interpolates a caller-supplied name into text a transport renders", () => {
    // The name reaches this context from an MCP client. The diagnosis travels
    // in `details`, which the kernel documents as never returned to a client.
    const reflected = "</script><img src=x onerror=1>";
    for (const error of [
      errors.duplicateToolName(reflected),
      errors.routeNotInScope(reflected, [reflected]),
      errors.endUserRequired(reflected),
      errors.dispatchRateLimited(reflected, 5),
      errors.mcpTransportInvalid("unsupported MCP transport", reflected),
    ]) {
      expect(error.message, error.code).not.toContain(reflected);
    }
  });

  it("keeps the runtime dispatch message content-free", () => {
    expect(errors.dispatchFailed("ECONNRESET at 10.0.0.4:8443").message).toBe("Tool call failed.");
    expect(errors.dispatchFailed("ECONNRESET at 10.0.0.4:8443").details["reason"]).toBe(
      "ECONNRESET at 10.0.0.4:8443",
    );
  });
});

describe("categories", () => {
  it("makes a residual template INTERNAL, because nothing the caller sent can fix it", () => {
    expect(errors.residualTemplate("{{endUserId}}").category).toBe("internal");
  });

  it("makes a missing end user a PRECONDITION, because linking one fixes it", () => {
    expect(errors.endUserRequired("t").category).toBe("precondition_failed");
  });

  it("makes a permission block FORBIDDEN and a scope mismatch forbidden too", () => {
    expect(errors.permissionBlocked("t", 1, "r").category).toBe("forbidden");
    expect(errors.scopeMismatch("a", "b").category).toBe("forbidden");
  });

  it("carries a retry hint on exactly the two categories the kernel permits it for", () => {
    for (const error of MINTED) {
      if (error.retryAfterSeconds === null) continue;
      expect(["rate_limited", "unavailable"], error.code).toContain(error.category);
    }
  });

  it("honours a backend's retry-after verbatim", () => {
    expect(errors.dispatchRateLimited("t", 137).retryAfterSeconds).toBe(137);
  });
});

describe("the two vocabularies the merge brought, both preserved", () => {
  it("keeps an operator-fixable precondition apart from a runtime outcome", () => {
    expect(errors.entityNotDispatchable("e", "r").category).toBe("precondition_failed");
    expect(errors.dispatchFailed("r").category).toBe("unavailable");
  });

  it("keeps a route that does not exist apart from one that is ambiguous", () => {
    expect(errors.routeNotInScope("t", []).category).toBe("not_found");
    expect(errors.routeAmbiguous("t", []).category).toBe("conflict");
  });
});
