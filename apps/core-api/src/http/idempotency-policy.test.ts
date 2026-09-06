// The policy table, JOINED TO THE FROZEN SURFACE'S OWN INVENTORY.
//
// A table of route templates checked only against itself cannot fail: a mutation
// that renamed a template would rename it on both sides of every assertion. So
// every case here joins to
// `apps/agent/src/control-plane/operation-manifest.generated.json` — 300 REST
// operations, generated from the live controllers by a gate this dimension does
// not touch, on the branch this repository calls the frozen oracle.
//
// The join runs both ways, and the second direction is the one that bites.
// Forwards: every template classified here EXISTS there, with that method. A
// typo, a renamed route or a method that moved fails. Backwards: every
// side-effecting operation there whose path speaks of a token, a secret or a key
// is either REQUIRED here or EXEMPT here with a reason. A new secret-minting
// route on the oracle therefore fails this suite until somebody classifies it,
// which is the only version of this table worth committing.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  OPERATION_POLICIES,
  SIDE_EFFECTING_METHODS,
  classifyRequest,
  compileTemplate,
  operationScope,
} from "./idempotency-policy.js";

interface ManifestOperation {
  readonly id: string;
  readonly method: string;
  readonly path: string;
}

const MANIFEST = JSON.parse(
  readFileSync(
    new URL("../../../../apps/agent/src/control-plane/operation-manifest.generated.json", import.meta.url),
    "utf8",
  ),
) as { readonly inventories: { readonly restOperations: readonly ManifestOperation[] } };

const OPERATIONS = MANIFEST.inventories.restOperations;

/** A path that speaks of a credential. Deliberately broad: the point is to catch
 * a route nobody classified, and a false positive costs one line of table. */
const CREDENTIAL_PATH = /token|secret|access-key|\/keys(\/|$)/iu;

describe("the policy table against the frozen operation manifest", () => {
  it("reads a manifest with the operations this table classifies", () => {
    // The join is worthless if the file moved or the shape changed and every
    // lookup quietly returned nothing. Reading the count back first is what
    // stops an empty inventory from making the two cases below vacuous.
    expect(OPERATIONS.length).toBe(300);
  });

  it("classifies only operations the frozen surface actually serves", () => {
    const known = new Set(OPERATIONS.map((operation) => `${operation.method} ${operation.path}`));
    const unknown = OPERATION_POLICIES.filter(
      (policy) => !known.has(`${policy.method} ${policy.template}`),
    ).map((policy) => `${policy.method} ${policy.template}`);
    expect(unknown).toEqual([]);
  });

  it("leaves no side-effecting credential route unclassified", () => {
    const classified = new Set(
      OPERATION_POLICIES.map((policy) => `${policy.method} ${policy.template}`),
    );
    const orphans = OPERATIONS.filter(
      (operation) =>
        SIDE_EFFECTING_METHODS.includes(operation.method) &&
        CREDENTIAL_PATH.test(operation.path) &&
        !classified.has(`${operation.method} ${operation.path}`),
    ).map((operation) => operation.id);
    expect(orphans).toEqual([]);
  });

  it("gives every row a reason, and every family M0.4 §2 names a required row", () => {
    for (const policy of OPERATION_POLICIES) {
      expect(policy.reason.length).toBeGreaterThan(20);
    }
    const required = OPERATION_POLICIES.filter((policy) => policy.class === "required");
    // M0.4 §2 names FOUR families — token, PAT, MCP-token, wire-secret — and a
    // table that had let one of them fall out would still pass every other case
    // here.
    for (const family of ["token", "PAT", "MCP-token", "wire-secret"]) {
      expect(required.some((policy) => policy.reason.startsWith(`${family} —`))).toBe(true);
    }
    expect(required.length).toBe(8);
  });
});

describe("classifyRequest", () => {
  it("requires a key on the access-key mint and not on its origins sibling", () => {
    // The pair that makes a prefix rule wrong. `/access-key` mints the credential
    // and `/access-key/origins` configures it, and a table matching by prefix
    // would bind both.
    expect(classifyRequest("POST", "/api/v1/agent/access-key")).toBe("required");
    expect(classifyRequest("POST", "/api/v1/agent/access-key/origins")).toBe("exempt");
  });

  it("binds a template through its parameter segment", () => {
    expect(classifyRequest("POST", "/api/v1/entities/walle-mcp/session-tokens")).toBe("required");
  });

  it("does not let a parameter swallow a slash", () => {
    // `[^/]+` and not `.+`: with `.+` this path would match the session-token
    // template and a request to a route nobody classified would be REQUIRED.
    expect(classifyRequest("POST", "/api/v1/entities/a/b/session-tokens")).toBe("accepted");
  });

  it("classifies a side-effecting route nobody named as accepted", () => {
    expect(classifyRequest("POST", "/api/v1/agent/agents")).toBe("accepted");
    expect(classifyRequest("DELETE", "/api/v1/agent/agents/1")).toBe("accepted");
  });

  it("classifies every read as not-applicable, whatever its path", () => {
    // A GET to a mint path is still a read. Reserving one would make a read fail
    // because a read was already in flight.
    expect(classifyRequest("GET", "/api/v1/agent/access-key")).toBe("not-applicable");
    expect(classifyRequest("HEAD", "/api/v1/agent/access-key")).toBe("not-applicable");
    expect(classifyRequest("OPTIONS", "/api/v1/agent/access-key")).toBe("not-applicable");
  });

  it("is case-insensitive about the method and only about the method", () => {
    expect(classifyRequest("post", "/api/v1/agent/access-key")).toBe("required");
    expect(classifyRequest("POST", "/API/V1/AGENT/ACCESS-KEY")).toBe("accepted");
  });

  it("does not bind a method the row was not written for", () => {
    // The mint is a POST. A DELETE of the same path is its own row, and it is
    // exempt — a table keyed on path alone would have made revocation require a
    // key.
    expect(classifyRequest("DELETE", "/api/v1/agent/access-key")).toBe("exempt");
  });
});

describe("operationScope", () => {
  it("collapses two ids of one operation onto one scope", () => {
    expect(operationScope("POST", "/api/v1/entities/a/session-tokens")).toBe(
      operationScope("POST", "/api/v1/entities/b/session-tokens"),
    );
  });

  it("never collapses two different operations", () => {
    expect(operationScope("POST", "/api/v1/agent/access-key")).not.toBe(
      operationScope("POST", "/api/v1/agent/access-key/origins"),
    );
  });

  it("falls back to the concrete path for a route the table has not seen", () => {
    expect(operationScope("POST", "/api/v1/agent/agents")).toBe("POST /api/v1/agent/agents");
  });
});

describe("compileTemplate", () => {
  it("escapes a literal segment rather than treating it as a pattern", () => {
    const pattern = compileTemplate("/a.b/c");
    expect(pattern.test("/a.b/c")).toBe(true);
    expect(pattern.test("/axb/c")).toBe(false);
  });

  it("anchors both ends", () => {
    const pattern = compileTemplate("/api/v1/agent/access-key");
    expect(pattern.test("/prefix/api/v1/agent/access-key")).toBe(false);
    expect(pattern.test("/api/v1/agent/access-key/extra")).toBe(false);
  });

  it("tolerates one trailing slash and nothing more", () => {
    const pattern = compileTemplate("/api/v1/agent/access-key");
    expect(pattern.test("/api/v1/agent/access-key/")).toBe(true);
    expect(pattern.test("/api/v1/agent/access-key//")).toBe(false);
  });
});
