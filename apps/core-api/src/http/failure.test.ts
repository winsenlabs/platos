// The mapping, EXECUTED — and joined to the committed taxonomy, not to itself.
//
// `error-status.test.ts` proves `httpStatusFor` agrees with
// `docs/error-taxonomy.json` for all four hundred codes. This proves the thing
// that writes bytes calls it, and that what lands on the wire is M0.4 §2's
// envelope and nothing else. The status every case expects is READ OUT OF the
// committed taxonomy rather than written here, so a mutation to `CATEGORY_STATUS`
// cannot move both sides of an assertion at once — the failure mode a projection
// test in WIN-258 T7 was found to have.

import { readFileSync } from "node:fs";

import { domainError, type ErrorCategory } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { CONTRACT_VERSION, mintErrorId, writeFailure, type FailureResponse } from "./failure.js";
import {
  idempotencyKeyMalformed,
  idempotencyKeyRequired,
  idempotencyRecordAbsent,
  idempotencyRecordMalformed,
  idempotencyRequestInFlight,
  idempotencyRequestMismatch,
  idempotencyStoreUnavailable,
} from "./idempotency-errors.js";

interface TaxonomyEntry {
  readonly category: ErrorCategory;
  readonly status: number;
}

const TAXONOMY = JSON.parse(
  readFileSync(new URL("../../../../docs/error-taxonomy.json", import.meta.url), "utf8"),
) as { readonly codes: Readonly<Record<string, TaxonomyEntry>> };

function committedStatus(code: string): number {
  const entry = TAXONOMY.codes[code];
  if (entry === undefined) throw new Error(`${code} is not in the committed taxonomy`);
  return entry.status;
}

interface Written {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function recorder(): FailureResponse & { written: Written } {
  const written: Written = { status: 0, headers: {}, body: "" };
  return {
    written,
    set statusCode(value: number) {
      written.status = value;
    },
    get statusCode(): number {
      return written.status;
    },
    setHeader(name: string, value: string) {
      written.headers[name.toLowerCase()] = value;
      return undefined;
    },
    end(body: string) {
      written.body = body;
      return undefined;
    },
  };
}

/** The seven codes this transport can answer with, each with its constructor. */
const GATE_ERRORS = [
  ["IDEMPOTENCY_KEY_REQUIRED", idempotencyKeyRequired("POST /x")],
  ["IDEMPOTENCY_KEY_MALFORMED", idempotencyKeyMalformed("POST /x")],
  ["IDEMPOTENCY_REQUEST_IN_FLIGHT", idempotencyRequestInFlight("POST /x")],
  ["IDEMPOTENCY_REQUEST_MISMATCH", idempotencyRequestMismatch("POST /x")],
  ["IDEMPOTENCY_RECORD_ABSENT", idempotencyRecordAbsent("POST /x")],
  ["IDEMPOTENCY_RECORD_MALFORMED", idempotencyRecordMalformed("POST /x")],
  ["IDEMPOTENCY_STORE_UNAVAILABLE", idempotencyStoreUnavailable("POST /x", "down")],
] as const;

describe("writeFailure", () => {
  it("answers the status the COMMITTED taxonomy records, for every gate code", () => {
    for (const [code, error] of GATE_ERRORS) {
      const response = recorder();
      const returned = writeFailure(response, error, { errorId: "e", requestId: "r" });
      expect(error.code).toBe(code);
      expect(response.written.status).toBe(committedStatus(code));
      expect(returned).toBe(committedStatus(code));
    }
  });

  it("answers 400 for the one refusal M0.4 §2 states the status of", () => {
    // The ADR writes it out: "**require** it -> `400 IDEMPOTENCY_KEY_REQUIRED`".
    // Read back from the taxonomy so this case cannot pass by agreeing with
    // itself, and compared against the literal the ADR states.
    expect(committedStatus("IDEMPOTENCY_KEY_REQUIRED")).toBe(400);
  });

  it("writes M0.4 §2's envelope and nothing outside it", () => {
    const response = recorder();
    writeFailure(response, idempotencyKeyRequired("POST /x"), {
      errorId: "err-9",
      requestId: "req-9",
    });
    const payload = JSON.parse(response.written.body) as { error: Record<string, unknown> };
    expect(Object.keys(payload)).toEqual(["error"]);
    expect(Object.keys(payload.error).sort()).toEqual(
      ["body", "code", "errorId", "fields", "title", "traceRef", "version"].sort(),
    );
    expect(payload.error.errorId).toBe("err-9");
    expect(payload.error.traceRef).toBe("req-9");
    expect(payload.error.version).toBe(CONTRACT_VERSION);
  });

  it("never puts `details` on the wire", () => {
    // The kernel calls `details` "structured, already-redacted context for logs.
    // Never returned to a client", and the reason to test it at THIS layer is
    // that this is the layer that would leak it.
    const response = recorder();
    writeFailure(
      response,
      idempotencyStoreUnavailable("POST /x", "connect ECONNREFUSED 10.0.0.1:6379"),
      { errorId: "e", requestId: "r" },
    );
    expect(response.written.body).not.toContain("ECONNREFUSED");
    expect(response.written.body).not.toContain("details");
  });

  it("sets Retry-After only where the kernel populates one", () => {
    const unavailable = recorder();
    writeFailure(unavailable, idempotencyStoreUnavailable("POST /x", "down"), {
      errorId: "e",
      requestId: "r",
    });
    expect(unavailable.written.headers["retry-after"]).toBe("1");

    const conflict = recorder();
    writeFailure(conflict, idempotencyRequestInFlight("POST /x"), { errorId: "e", requestId: "r" });
    // A 409 is not retryable on a timer, and a transport that invented a hint
    // would tell a caller to retry a refusal that retrying cannot fix.
    expect(conflict.written.headers["retry-after"]).toBeUndefined();
  });

  it("always writes JSON, so a caller can parse the failure the same way it parses a success", () => {
    const response = recorder();
    writeFailure(response, idempotencyRequestMismatch("POST /x"), { errorId: "e", requestId: "r" });
    expect(response.written.headers["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("omits `fields` when the error carries none", () => {
    const response = recorder();
    writeFailure(response, idempotencyRequestInFlight("POST /x"), { errorId: "e", requestId: "r" });
    const payload = JSON.parse(response.written.body) as { error: Record<string, unknown> };
    expect("fields" in payload.error).toBe(false);
  });

  it("carries a code it has never seen through the same mapping", () => {
    // The gate's seven are not a special case: the executor reads the category
    // table, so a code minted anywhere resolves the same way.
    const response = recorder();
    writeFailure(response, domainError("MADE_UP_CODE", "forbidden", "no"), {
      errorId: "e",
      requestId: "r",
    });
    expect(response.written.status).toBe(403);
  });
});

describe("mintErrorId", () => {
  it("mints a distinct id per failure", () => {
    // One request can fail more than once, and an operator searching a log for
    // the id a caller quoted has to land on one line.
    const ids = new Set([mintErrorId(), mintErrorId(), mintErrorId()]);
    expect(ids.size).toBe(3);
  });
});

describe("CONTRACT_VERSION", () => {
  it("is the MAJOR, which M0.4 §1.2 makes the thing that is frozen", () => {
    expect(CONTRACT_VERSION).toBe("1");
  });
});
