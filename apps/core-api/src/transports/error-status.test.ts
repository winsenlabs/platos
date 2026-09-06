// What a transport will actually answer with.
//
// `scripts/error-taxonomy.mjs` proves the committed table agrees with the 17
// contexts' mint sites. This proves the FUNCTIONS agree with the committed
// table, for all four hundred codes rather than for a handful somebody
// remembered — a table nothing executes and a function nothing checks are each
// half a mapping.

import { readFileSync } from "node:fs";

import { domainError, type DomainError, type ErrorCategory } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  CATEGORY_STATUS,
  RPC_CATEGORY_CODE,
  STATUS_OVERRIDES,
  httpStatusFor,
  rpcCodeFor,
  toWireError,
} from "./error-status.js";

interface TaxonomyEntry {
  readonly category: ErrorCategory;
  readonly status: number;
  readonly contexts: readonly string[];
}

const TAXONOMY = JSON.parse(
  readFileSync(new URL("../../../../docs/error-taxonomy.json", import.meta.url), "utf8"),
) as { readonly codes: Readonly<Record<string, TaxonomyEntry>> };

const IDENTITY = { errorId: "err-1", requestId: "req-1", contractVersion: "1" };

/** The error a code stands for, rebuilt from the committed taxonomy alone. */
function errorFor(code: string): DomainError {
  const entry = TAXONOMY.codes[code];
  if (entry === undefined) throw new Error(`${code} is not in the taxonomy`);
  return domainError(code, entry.category, "rebuilt from the taxonomy");
}

describe("httpStatusFor, against the whole committed taxonomy", () => {
  it("answers the committed status for every canonical code", () => {
    // 400+ codes, joined to a file this module does not own. A mapping that
    // drifted for ONE code fails here, and there is no way to satisfy it by
    // editing this file alone.
    const disagreements: string[] = [];
    for (const [code, entry] of Object.entries(TAXONOMY.codes)) {
      const answered = httpStatusFor(errorFor(code));
      if (answered !== entry.status) disagreements.push(`${code}: ${answered} != ${entry.status}`);
    }
    expect(disagreements).toEqual([]);
    expect(Object.keys(TAXONOMY.codes).length).toBeGreaterThan(300);
  });

  it("answers the category's status when no override claims the code", () => {
    expect(httpStatusFor(domainError("X_GONE", "not_found", "gone"))).toBe(404);
    expect(httpStatusFor(domainError("X_DENIED", "forbidden", "no"))).toBe(403);
    expect(httpStatusFor(domainError("X_BUSY", "rate_limited", "slow down"))).toBe(429);
  });

  it("answers the OVERRIDE when one claims the code, whatever its category says", () => {
    // The three the live surface really does answer differently, quoted beside
    // each code in `jobs`' catalogue. Without the override these would be 412,
    // 400 and 503, which is not what the deleted service returned.
    expect(httpStatusFor(errorFor("JOB_NOT_REGISTERED"))).toBe(422);
    expect(httpStatusFor(errorFor("JOB_RESULT_REJECTED"))).toBe(422);
    expect(httpStatusFor(errorFor("JOB_TIMEOUT"))).toBe(504);

    expect(CATEGORY_STATUS.precondition_failed).toBe(412);
    expect(CATEGORY_STATUS.invalid_input).toBe(400);
    expect(CATEGORY_STATUS.unavailable).toBe(503);
  });

  it("gives the four idempotency refusals ONE status and four DIFFERENT codes", () => {
    // WIN-260's whole point. They are one instruction to the caller — this
    // request id is spoken for — so 409 is right for all four. What differs is
    // what an operator must do, and that is in `code`, which M0.4 §2 freezes.
    const codes = [
      "IDEMPOTENCY_CONFLICT",
      "JOBS_IDEMPOTENCY_RECORD_ABSENT",
      "JOBS_IDEMPOTENCY_RECORD_MALFORMED",
      "JOBS_IDEMPOTENCY_REPLAY_CODE_UNPROMISED",
    ];
    expect(new Set(codes.map((code) => httpStatusFor(errorFor(code))))).toEqual(new Set([409]));
    expect(new Set(codes).size).toBe(4);
    expect(httpStatusFor(errorFor("IDEMPOTENCY_IN_PROGRESS"))).toBe(409);
  });
});

describe("the category table", () => {
  it("resolves a plausible status for every category the kernel declares", () => {
    // Exhaustiveness is the compiler's job — `Record<ErrorCategory, number>`
    // will not build with a member missing — so what is left at runtime is that
    // no entry is a placeholder.
    for (const [category, status] of Object.entries(CATEGORY_STATUS)) {
      expect(Number.isInteger(status), category).toBe(true);
      expect(status, category).toBeGreaterThanOrEqual(400);
      expect(status, category).toBeLessThan(600);
    }
  });

  it("overrides only codes whose category default is a DIFFERENT number", () => {
    // An override that agrees with its category is dead weight, and dead weight
    // in a mapping table is what drifts first.
    for (const [code, status] of Object.entries(STATUS_OVERRIDES)) {
      const entry = TAXONOMY.codes[code];
      expect(entry, `${code} is overridden but is not a canonical code`).toBeDefined();
      expect(status, code).not.toBe(CATEGORY_STATUS[(entry as TaxonomyEntry).category]);
    }
  });

  it("covers exactly the categories the taxonomy actually uses", () => {
    const used = new Set(Object.values(TAXONOMY.codes).map((entry) => entry.category));
    for (const category of used) expect(CATEGORY_STATUS[category], category).toBeDefined();
  });
});

describe("rpcCodeFor", () => {
  it("maps a bad request to the JSON-RPC slot that means one", () => {
    expect(rpcCodeFor(domainError("X_BAD", "invalid_input", "bad"))).toBe(-32602);
    expect(rpcCodeFor(domainError("X_GONE", "not_found", "gone"))).toBe(-32601);
  });

  it("collapses the rest onto -32603, and the canonical code survives it", () => {
    // The collapse is the protocol's, not this table's: JSON-RPC has four
    // reserved slots and this system has four hundred codes. What makes it
    // survivable is that the code travels separately, so this asserts the
    // collapse AND the survival in one case.
    const collapsed = [
      domainError("X_AUTH", "unauthenticated", "no"),
      domainError("X_DENIED", "forbidden", "no"),
      domainError("X_CONFLICT", "conflict", "no"),
      domainError("X_BUSY", "rate_limited", "no"),
      domainError("X_DOWN", "unavailable", "no"),
      domainError("X_BUG", "internal", "no"),
    ];
    expect(new Set(collapsed.map(rpcCodeFor))).toEqual(new Set([-32603]));
    expect(new Set(collapsed.map((error) => toWireError(error, IDENTITY).code)).size).toBe(
      collapsed.length,
    );
    expect(Object.keys(RPC_CATEGORY_CODE).sort()).toEqual(Object.keys(CATEGORY_STATUS).sort());
  });
});

describe("toWireError", () => {
  it("builds the M0.4 §2 envelope and nothing else", () => {
    const envelope = toWireError(domainError("X_GONE", "not_found", "gone"), IDENTITY);
    expect(Object.keys(envelope).sort()).toEqual([
      "body",
      "code",
      "errorId",
      "title",
      "traceRef",
      "version",
    ]);
  });

  it("NEVER puts `details` on the wire", () => {
    // The kernel calls details "structured, already-redacted context for logs.
    // Never returned to a client". A builder that spread the DomainError would
    // pass every other case here and leak on the first error carrying one.
    const error = domainError("X_DENIED", "forbidden", "no", {
      details: { internalUserId: "user-77", reason: "not-a-member" },
    });
    const envelope = toWireError(error, IDENTITY);
    expect(JSON.stringify(envelope)).not.toContain("user-77");
    expect(JSON.stringify(envelope)).not.toContain("not-a-member");
    expect("details" in envelope).toBe(false);
  });

  it("carries field violations when there are any, and omits the key when there are none", () => {
    const withFields = toWireError(
      domainError("X_BAD", "invalid_input", "bad", {
        fields: [{ field: "name", code: "required", message: "required" }],
      }),
      IDENTITY,
    );
    expect(withFields.fields).toEqual([{ field: "name", code: "required", message: "required" }]);
    expect("fields" in toWireError(domainError("X_GONE", "not_found", "gone"), IDENTITY)).toBe(false);
  });

  it("carries retryAfterSec only where the kernel populates it", () => {
    const limited = domainError("X_BUSY", "rate_limited", "slow down", { retryAfterSeconds: 30 });
    expect(toWireError(limited, IDENTITY).retryAfterSec).toBe(30);
    expect("retryAfterSec" in toWireError(domainError("X_GONE", "not_found", "gone"), IDENTITY)).toBe(
      false,
    );
  });

  it("uses the correlation id it is HANDED rather than minting one", () => {
    // `runtime/correlation.ts` decides what a request id is, once, at the
    // process edge. A transport that minted a second one would hand the caller a
    // traceRef that appears in no log line.
    const envelope = toWireError(domainError("X_GONE", "not_found", "gone"), {
      errorId: "err-9",
      requestId: "req-from-the-edge",
      contractVersion: "1",
    });
    expect(envelope.traceRef).toBe("req-from-the-edge");
    expect(envelope.errorId).toBe("err-9");
  });
});
