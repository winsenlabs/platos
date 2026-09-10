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
    //
    // 300 -> 308 (WIN-267 R1). The manifest is no longer the agent's alone: the
    // generator walks `apps/core-api/src/transports` as a second scan root, and
    // R1 landed the first EIGHT routes there — `GET /api/v1/identity/session`,
    // `GET`+`POST /api/v1/organizations`, `GET`+`POST /api/v1/projects`,
    // `GET /api/v1/environments/:environmentId/end-users`, and `POST`+`DELETE
    // /api/v1/bff/session`. 300 agent operations + 8 core-api operations = 308,
    // and `summary.restScanRoots` in the manifest carries the same split.
    //
    // NONE OF THE EIGHT NEEDS A POLICY ROW. `OPERATION_POLICIES` classifies the
    // one-time-secret mints as `required` and names the exemptions; the R1 routes
    // mint no secret, so they take the unlisted default (`accepted`: a key is
    // honoured if sent and not demanded). The credential-path case below is what
    // proves that is a classification rather than an oversight — it would fail if
    // any of the eight looked like a credential route.
    // 308 -> 309 (WIN-272, M4.6): the stream lane's one route. It is a GET, so
    // `classifyRequest` puts it in the `none` bucket — an `Idempotency-Key` on a
    // read is meaningless and this table says so by omission rather than by a row.
    //
    // 309 -> 310: `POST /api/v1/agent/agents/:agentId/chat/stream`, the route that
    // took the 20,000-character message out of the request line. IT IS A CARRIED
    // PIN AND NOT THIS TRANCHE'S ROUTE — the manifest was regenerated when the
    // route landed and this count was not moved with it, so `pnpm --filter
    // @platos/core-api test` has been one assertion red ever since. Recorded here
    // rather than silently corrected because it is the SIXTH pin of the seven-
    // artifact sequence a new agent route costs, and the list that sequence is
    // written down in does not name this file.
    //
    // IT NEEDS NO POLICY ROW EITHER, and that is a classification rather than an
    // omission: the route mints no credential, so it takes the unlisted default
    // (`accepted` — a key is honoured if sent and not demanded), and the
    // credential-path case below would fail if its path looked like a secret's.
    //
    // 310 -> 313 (WIN-268, M4.2): the tier-2 MCP policy surface's three routes at
    // `/mcp/platform/environments/:environmentId/policies`. THE `PUT` IS THE ONE
    // WORTH READING TWICE. It is a mutating operation that mints no credential, so
    // it takes the unlisted default `accepted` rather than a `required` row — and
    // that is the classification the two token mints beside it do NOT take. The
    // difference is not "how dangerous": it is that a replayed policy upsert
    // converges on the same single row keyed `@@unique([organizationId, pattern])`,
    // while a replayed mint would leave a second live credential behind. Demanding
    // a key here would refuse three hundred operations' worth of callers for a
    // property the operation already has by construction.
    expect(OPERATIONS.length).toBe(313);
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

// ---------------------------------------------------------------------------
// WIN-270 (M4.4) — THE GENERATED SDK'S COPY OF THIS DECISION, JOINED BACK.
//
// `scripts/sdk/v1-contract.mjs` emits a TypeScript and a Python client for the
// V1 surface, and each generated operation carries an idempotency CLASS so the
// client knows whether an `Idempotency-Key` is mandatory. That class is read off
// THIS FILE — the generator parses `OPERATION_POLICIES` out of the source rather
// than restating it — but it is computed over route TEMPLATES at generation
// time, while `classifyRequest` answers over a CONCRETE path at runtime, by
// pattern.
//
// Two implementations of one rule is exactly the shape this programme keeps
// getting burned by, so they are joined by EXECUTION. Every operation in the
// emitted fixture has its template instantiated into a concrete path and handed
// to the real `classifyRequest`; the answers must agree. A generator that
// learned a different rule — or a `classifyRequest` that changed — fails here,
// in the file that owns the decision, rather than in a client nobody runs.
// ---------------------------------------------------------------------------

interface SdkFixtureOperation {
  readonly operationId: string;
  readonly method: string;
  readonly template: string;
  readonly idempotency: string;
  readonly expected: { readonly sendsIdempotencyKey: boolean };
}

const SDK_FIXTURE = JSON.parse(
  readFileSync(new URL("../../../../tests/sdk-contract/v1-fixtures.json", import.meta.url), "utf8"),
) as { readonly operations: readonly SdkFixtureOperation[] };

/** A template with every `:param` replaced by a segment that cannot contain a slash. */
function instantiate(template: string): string {
  return template.replaceAll(/:([A-Za-z0-9_]+)/gu, (_match, name: string) => `win270-${name}`);
}

describe("the generated SDK's idempotency classes against classifyRequest", () => {
  it("reads a fixture with operations in it", () => {
    expect(SDK_FIXTURE.operations.length).toBeGreaterThan(0);
  });

  it.each(SDK_FIXTURE.operations.map((entry) => [entry.operationId, entry] as const))(
    "%s is classified the same way at generation time and at runtime",
    (_id, entry) => {
      expect(classifyRequest(entry.method, instantiate(entry.template))).toBe(entry.idempotency);
    },
  );

  it("sends a key for exactly the classes M0.4 section 2 puts the header on", () => {
    for (const entry of SDK_FIXTURE.operations) {
      const bound = entry.idempotency === "required" || entry.idempotency === "accepted";
      expect(entry.expected.sendsIdempotencyKey, entry.operationId).toBe(bound);
    }
  });

  it("carries every V1 mint this table requires a key for", () => {
    const requiredHere = OPERATION_POLICIES.filter((policy) => policy.class === "required").map(
      (policy) => `${policy.method} ${policy.template}`,
    );
    const requiredInSdk = SDK_FIXTURE.operations
      .filter((entry) => entry.idempotency === "required")
      .map((entry) => `${entry.method} ${entry.template}`);
    expect(requiredInSdk.length).toBeGreaterThan(0);
    // The SDK covers the SERVED V1 surface, which is a subset of the whole
    // frozen surface this table classifies — so containment, not equality. An
    // SDK operation the table does not require a key for would fail the
    // per-operation case above; this one catches the other direction, an SDK
    // that invented a `required` nothing here asks for.
    for (const entry of requiredInSdk) expect(requiredHere).toContain(entry);
  });
});
