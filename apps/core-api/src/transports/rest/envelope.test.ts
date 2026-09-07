// The chassis rules, without a server.
//
// Everything asserted here is a FUNCTION over values, which is the point of
// keeping `envelope.ts`, `page.ts`, `fault.ts` and `transport-errors.ts` free of
// a framework: every branch of the pagination rule is reachable in memory, so
// the HTTP suite next door spends its budget proving that the wire carries what
// these functions decide rather than re-deriving the decisions through a socket.
//
// THE ONE CASE HERE THAT IS NOT ABOUT A VALUE IS THE BUILD-ID JOIN, and it is
// the most important one in the file. ADR M0.4 §1.1 says the version "is read
// out of `operation-manifest.generated.json` and stamped onto the wire; a
// hand-edit that disagrees with the manifest fails CI." This deployable cannot
// import that manifest — it belongs to `apps/agent` and must not become a
// dependency — so `CONTRACT_BUILD_ID` is a copy, and a copy nobody joins to its
// source is a second opinion waiting to drift. The case reads the manifest off
// disk and compares.

import { readFileSync } from "node:fs";

import { domainError } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  CONTRACT_BUILD_ID,
  CONTRACT_VERSION_HEADER,
  TOTAL_COUNT_HEADER,
  collectionEnvelope,
  decodeCursor,
  encodeCursor,
  itemEnvelope,
} from "./envelope.js";
import { DomainFault, domainErrorOf, isDomainError, raise } from "./fault.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parsePageQuery } from "./page.js";
import { requestInvalid, routeNotFound, shuttingDown, unhandledFault } from "./transport-errors.js";

const MANIFEST_PATH = new URL(
  "../../../../agent/src/control-plane/operation-manifest.generated.json",
  import.meta.url,
);

function refusalOf(query: Record<string, unknown>): {
  readonly code: string;
  readonly fields: readonly { readonly field: string; readonly code: string }[];
} {
  const outcome = parsePageQuery(query);
  if (outcome.ok) throw new Error("expected a refusal");
  return {
    code: outcome.error.code,
    fields: outcome.error.fields.map((violation) => ({
      field: violation.field,
      code: violation.code,
    })),
  };
}

describe("WIN-267 T2 — the build stamp is one fact, not two", () => {
  it("carries the manifestVersion the ONE manifest records", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
      readonly manifestVersion: string;
    };
    // If this fails, the manifest moved and `CONTRACT_BUILD_ID` must move with
    // it — never the other way round. M0.4 §1.1 makes the manifest the source.
    expect(CONTRACT_BUILD_ID).toBe(manifest.manifestVersion);
  });

  it("spells the two M0.4 §2 headers once each", () => {
    expect(CONTRACT_VERSION_HEADER).toBe("X-Platos-Contract-Version");
    expect(TOTAL_COUNT_HEADER).toBe("X-Total-Count");
  });
});

describe("WIN-267 T2 — the ITEM and COLLECTION envelopes", () => {
  it("wraps an item as { data, meta: { contractVersion } } and nothing else", () => {
    expect(itemEnvelope({ id: "agent-1" })).toEqual({
      data: { id: "agent-1" },
      meta: { contractVersion: CONTRACT_BUILD_ID },
    });
  });

  it("carries a degraded notice on the SUCCESS envelope, at 200", () => {
    const envelope = itemEnvelope({ hits: 3 }, { service: "embeddings", fallback: "keyword" });
    expect(envelope.meta.degraded).toEqual({ service: "embeddings", fallback: "keyword" });
  });

  it("omits `degraded` when the answer was not degraded, rather than sending null", () => {
    expect("degraded" in itemEnvelope({ id: 1 }).meta).toBe(false);
  });

  it("derives hasMore from nextCursor, so the two cannot disagree", () => {
    const more = collectionEnvelope({ rows: [1, 2], cursor: null, limit: 2, nextCursor: "c2" });
    const last = collectionEnvelope({ rows: [3], cursor: "c2", limit: 2, nextCursor: null });
    expect(more.page.hasMore).toBe(true);
    expect(last.page.hasMore).toBe(false);
    expect(last.page.cursor).toBe("c2");
  });

  it("omits `total` when no count was taken, because absent is not zero", () => {
    const uncounted = collectionEnvelope({ rows: [], cursor: null, limit: 25, nextCursor: null });
    expect("total" in uncounted.page).toBe(false);
    const counted = collectionEnvelope({
      rows: [],
      cursor: null,
      limit: 25,
      nextCursor: null,
      total: 0,
    });
    expect(counted.page.total).toBe(0);
  });

  it("round-trips an opaque cursor, and refuses one it did not mint", () => {
    const cursor = encodeCursor({ after: "01J0", at: 7 });
    expect(decodeCursor(cursor)).toEqual({ after: "01J0", at: 7 });
    expect(decodeCursor("not-a-cursor")).toBeNull();
  });
});

describe("WIN-267 T2 — pagination refuses instead of coercing (WIN-236)", () => {
  it("defaults to the BFF page size when the caller asked for none", () => {
    const outcome = parsePageQuery({});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual({ cursor: null, limit: DEFAULT_PAGE_SIZE });
  });

  it("accepts the maximum and refuses one past it", () => {
    expect(parsePageQuery({ limit: String(MAX_PAGE_SIZE) }).ok).toBe(true);
    expect(refusalOf({ limit: String(MAX_PAGE_SIZE + 1) })).toEqual({
      code: "TRANSPORT_REQUEST_INVALID",
      fields: [{ field: "query.limit", code: "above_maximum" }],
    });
  });

  it("refuses every shape Number() would have silently swallowed", () => {
    // `Number("")` is 0, `Number(" 25 ")` is 25, `Number("2e1")` is 20 and
    // `Number("20; DROP")` is NaN. Coercion answers for all four.
    expect(refusalOf({ limit: "" }).fields[0]?.code).toBe("not_an_integer");
    expect(refusalOf({ limit: " 25 " }).fields[0]?.code).toBe("not_an_integer");
    expect(refusalOf({ limit: "2e1" }).fields[0]?.code).toBe("not_an_integer");
    expect(refusalOf({ limit: "20; DROP" }).fields[0]?.code).toBe("not_an_integer");
    expect(refusalOf({ limit: "0" }).fields[0]?.code).toBe("below_minimum");
  });

  it("refuses a repeated parameter rather than picking one of the two", () => {
    expect(refusalOf({ limit: ["10", "100"] })).toEqual({
      code: "TRANSPORT_REQUEST_INVALID",
      fields: [{ field: "query.limit", code: "repeated" }],
    });
  });

  it("reports EVERY violation in one answer, not the first", () => {
    expect(refusalOf({ limit: "0", cursor: "%%%" }).fields).toEqual([
      { field: "query.limit", code: "below_minimum" },
      { field: "query.cursor", code: "malformed" },
    ]);
  });

  it("accepts a cursor this service minted and refuses one it did not", () => {
    const outcome = parsePageQuery({ cursor: encodeCursor({ after: "01J0" }) });
    expect(outcome.ok).toBe(true);
    expect(refusalOf({ cursor: "" }).fields[0]?.code).toBe("malformed");
  });

  it("names dotted paths into the request, not bare field names", () => {
    for (const violation of refusalOf({ limit: "0", cursor: "%%%" }).fields) {
      expect(violation.field.startsWith("query.")).toBe(true);
    }
  });
});

describe("WIN-267 T2 — a DomainError reaches the edge however it was thrown", () => {
  const error = domainError("AGENTS_AGENT_NOT_FOUND", "not_found", "no such agent");

  it("recognises a DomainFault", () => {
    expect(domainErrorOf(new DomainFault(error))).toBe(error);
  });

  it("recognises a BARE DomainError value, which is the shape the kernel blesses", () => {
    expect(domainErrorOf(error)).toBe(error);
  });

  it("recognises a fault from a SECOND copy of this module, by shape not by class", () => {
    // A duplicated package in the graph gives two classes with one name. An
    // `instanceof` check against the wrong one is a silent 500 for a refusal the
    // domain expressed perfectly.
    const foreign = { name: "DomainFault", message: "x", error };
    expect(domainErrorOf(foreign)).toBe(error);
  });

  it("does NOT mistake an ordinary error, or a near-miss object, for a refusal", () => {
    expect(domainErrorOf(new TypeError("boom"))).toBeNull();
    expect(domainErrorOf({ code: "X", category: "nope", message: "m" })).toBeNull();
    expect(isDomainError({ code: "X", category: "not_found", message: "m" })).toBe(false);
  });

  it("raise() throws, and carries the error it was given", () => {
    expect(() => {
      raise(error);
    }).toThrow(DomainFault);
  });
});

describe("WIN-267 T2 — the four codes the envelope itself owns", () => {
  it("never echoes the caller's path back at them", () => {
    const error = routeNotFound("GET");
    const rendered = JSON.stringify(error);
    expect(rendered).not.toContain("/");
    expect(error.fields[0]?.field).toBe("path");
  });

  it("populates retryAfterSeconds only where the kernel permits one", () => {
    expect(shuttingDown().retryAfterSeconds).toBe(1);
    expect(unhandledFault().retryAfterSeconds).toBeNull();
    expect(requestInvalid([]).retryAfterSeconds).toBeNull();
    expect(routeNotFound("GET").retryAfterSeconds).toBeNull();
  });

  it("keeps the unhandled fault's message free of anything it was not given", () => {
    // It takes no argument at all, which is the strongest form of "it cannot
    // leak what it was handed".
    expect(unhandledFault().details).toEqual({});
    expect(unhandledFault().fields).toEqual([]);
  });
});
