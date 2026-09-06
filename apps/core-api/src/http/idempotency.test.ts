// Every branch of M0.4 §2's contract, without a socket.
//
// The statuses are NOT asserted here. They are asserted in `failure.test.ts`
// against `docs/error-taxonomy.json`, and over a real socket in
// `idempotency.integration.test.ts`; what this suite owns is which CODE each
// fact deserves, which is the half a shared status cannot express.
//
// The store double here is a `Map`, and it proves nothing about racing — a
// single-threaded double cannot lose a race, and a store that had quietly
// dropped its `NX` would satisfy every case in this file. That is what
// `idempotency.integration.test.ts` is for, against a real Redis. What a double
// CAN do is put the gate in states a real store reaches rarely or never on
// demand: a record that vanished under a lost claim, a record that is not a
// reservation, a store that is refusing.

import { describe, expect, it } from "vitest";

import type { RequestFingerprint, RequestIdempotency, RequestReservation } from "@platos/kernel";

import {
  ACCEPTABLE_IDEMPOTENCY_KEY,
  decideIdempotency,
  fingerprintFor,
  pathnameOf,
  readIdempotencyKey,
  settlementFor,
  type RequestFacts,
} from "./idempotency.js";

const MINT = "/api/v1/agent/access-key";

function facts(overrides: Partial<RequestFacts> = {}): RequestFacts {
  return {
    method: "POST",
    originalUrl: MINT,
    idempotencyKey: "key-1",
    authorization: "Bearer alpha",
    contentType: "application/json",
    contentLength: "2",
    rawBody: Buffer.from("{}"),
    ...overrides,
  };
}

/** A store that answers whatever the case needs, and counts what it was asked. */
function storeAnswering(reservation: RequestReservation): RequestIdempotency & { asked: number } {
  const store = {
    asked: 0,
    async reserve(): Promise<RequestReservation> {
      store.asked += 1;
      return reservation;
    },
    async record() {
      return { kind: "settled" } as const;
    },
    async release() {
      return { kind: "settled" } as const;
    },
  };
  return store;
}

describe("readIdempotencyKey", () => {
  it("reads a well-formed key", () => {
    expect(readIdempotencyKey("abc-123")).toEqual({ kind: "key", value: "abc-123" });
  });

  it("treats an absent header and a whitespace-only one alike", () => {
    expect(readIdempotencyKey(undefined)).toEqual({ kind: "absent" });
    expect(readIdempotencyKey("   ")).toEqual({ kind: "absent" });
  });

  it("refuses a REPEATED header rather than picking one", () => {
    // Node hands a repeated header over as an array. Two upstream opinions about
    // which request this is are not a key, and choosing either would let a proxy
    // that duplicated the header decide which reservation a mint lands on.
    expect(readIdempotencyKey(["a", "b"])).toEqual({ kind: "malformed" });
  });

  it("refuses a key carrying a character that is not safe in a log or a store key", () => {
    expect(readIdempotencyKey("a b")).toEqual({ kind: "malformed" });
    expect(readIdempotencyKey("a\nb")).toEqual({ kind: "malformed" });
    expect(readIdempotencyKey("a/b")).toEqual({ kind: "malformed" });
  });

  it("refuses a key past the length the shape allows", () => {
    expect(readIdempotencyKey("a".repeat(255))).toEqual({ kind: "key", value: "a".repeat(255) });
    expect(readIdempotencyKey("a".repeat(256))).toEqual({ kind: "malformed" });
  });

  it("accepts a single character, because M0.4 §2 states no minimum", () => {
    expect(ACCEPTABLE_IDEMPOTENCY_KEY.test("a")).toBe(true);
  });
});

describe("pathnameOf", () => {
  it("drops a query string and a fragment", () => {
    expect(pathnameOf(`${MINT}?ttl=300`)).toBe(MINT);
    expect(pathnameOf(`${MINT}#x`)).toBe(MINT);
  });

  it("leaves a bare path alone", () => {
    expect(pathnameOf(MINT)).toBe(MINT);
  });
});

describe("fingerprintFor", () => {
  it("gives two callers with the same key DIFFERENT scopes", () => {
    // The security property. Without the credential in the scope, the second
    // caller to a mint replays the first caller's secret.
    const alpha = fingerprintFor(facts({ authorization: "Bearer alpha" }), "shared");
    const beta = fingerprintFor(facts({ authorization: "Bearer beta" }), "shared");
    expect(alpha.scope).not.toBe(beta.scope);
    expect(alpha.key).toBe(beta.key);
  });

  it("gives one caller repeating a request the SAME fingerprint", () => {
    expect(fingerprintFor(facts(), "k")).toEqual(fingerprintFor(facts(), "k"));
  });

  it("changes the digest when the body changes", () => {
    const sent = fingerprintFor(facts({ rawBody: Buffer.from('{"a":1}') }), "k");
    const other = fingerprintFor(facts({ rawBody: Buffer.from('{"a":2}') }), "k");
    expect(sent.digest).not.toBe(other.digest);
  });

  it("changes the digest when the query changes", () => {
    const plain = fingerprintFor(facts(), "k");
    const queried = fingerprintFor(facts({ originalUrl: `${MINT}?ttl=300` }), "k");
    expect(plain.digest).not.toBe(queried.digest);
    // ...and not the scope: `?ttl=300` on a mint is still that mint.
    expect(plain.scope).toBe(queried.scope);
  });

  it("keeps the scope stable across two ids of one operation", () => {
    const first = fingerprintFor(
      facts({ originalUrl: "/api/v1/entities/a/session-tokens" }),
      "k",
    );
    const second = fingerprintFor(
      facts({ originalUrl: "/api/v1/entities/b/session-tokens" }),
      "k",
    );
    expect(first.scope).toBe(second.scope);
    // The path IS in the digest, so the two are still different requests.
    expect(first.digest).not.toBe(second.digest);
  });

  it("puts no credential and no key material in the scope it builds", () => {
    const fingerprint = fingerprintFor(facts({ authorization: "Bearer super-secret" }), "k");
    expect(fingerprint.scope).not.toContain("super-secret");
    expect(fingerprint.scope).toMatch(/^[0-9a-f]{32}$/u);
  });
});

describe("decideIdempotency", () => {
  it("mints IDEMPOTENCY_KEY_REQUIRED when a one-time-secret mint arrives with no key", async () => {
    // THE REFUSAL M0.4 §2 NAMES, and the reason this dimension was held back:
    // the code existed nowhere in the tree but a shape test.
    const store = storeAnswering({ kind: "reserved" });
    const decision = await decideIdempotency(facts({ idempotencyKey: undefined }), store);
    expect(decision).toEqual({
      kind: "refuse",
      error: expect.objectContaining({ code: "IDEMPOTENCY_KEY_REQUIRED", category: "invalid_input" }),
    });
    // ...and the store was never asked. A mint with no key is refused BEFORE a
    // reservation is attempted, so a store outage cannot turn this into a 503.
    expect(store.asked).toBe(0);
  });

  it("names the operation on the refusal and never the key", async () => {
    const decision = await decideIdempotency(
      facts({ idempotencyKey: undefined }),
      storeAnswering({ kind: "reserved" }),
    );
    if (decision.kind !== "refuse") throw new Error("expected a refusal");
    expect(decision.error.details).toEqual({ operation: `POST ${MINT}` });
    expect(decision.error.fields).toEqual([
      expect.objectContaining({ field: "headers.idempotency-key", code: "missing" }),
    ]);
  });

  it("mints IDEMPOTENCY_KEY_MALFORMED for a key that is not a key", async () => {
    const decision = await decideIdempotency(
      facts({ idempotencyKey: "not a key" }),
      storeAnswering({ kind: "reserved" }),
    );
    if (decision.kind !== "refuse") throw new Error("expected a refusal");
    expect(decision.error.code).toBe("IDEMPOTENCY_KEY_MALFORMED");
    // The offending value is NOT echoed. It is attacker-controlled and `details`
    // is rendered into log lines.
    expect(JSON.stringify(decision.error)).not.toContain("not a key");
  });

  it("refuses a malformed key on an ACCEPTED operation too", async () => {
    // A key that cannot be honoured is not the same fact as no key at all, and
    // proceeding would silently drop a promise the caller thinks it has.
    const decision = await decideIdempotency(
      facts({ originalUrl: "/api/v1/agent/agents", idempotencyKey: "not a key" }),
      storeAnswering({ kind: "reserved" }),
    );
    if (decision.kind !== "refuse") throw new Error("expected a refusal");
    expect(decision.error.code).toBe("IDEMPOTENCY_KEY_MALFORMED");
  });

  it("lets an ACCEPTED operation through with no key at all", async () => {
    const store = storeAnswering({ kind: "reserved" });
    const decision = await decideIdempotency(
      facts({ originalUrl: "/api/v1/agent/agents", idempotencyKey: undefined }),
      store,
    );
    expect(decision).toEqual({ kind: "proceed", held: null });
    expect(store.asked).toBe(0);
  });

  it("reserves nothing for a read, whatever headers it carries", async () => {
    const store = storeAnswering({ kind: "reserved" });
    const decision = await decideIdempotency(facts({ method: "GET" }), store);
    expect(decision).toEqual({ kind: "proceed", held: null });
    expect(store.asked).toBe(0);
  });

  it("reserves nothing for an EXEMPT operation, even one carrying a key", async () => {
    const store = storeAnswering({ kind: "reserved" });
    const decision = await decideIdempotency(facts({ originalUrl: "/oauth/token" }), store);
    expect(decision).toEqual({ kind: "proceed", held: null });
    expect(store.asked).toBe(0);
  });

  it("fails closed when a key was sent and no store is bound", async () => {
    const decision = await decideIdempotency(facts(), null);
    if (decision.kind !== "refuse") throw new Error("expected a refusal");
    expect(decision.error.code).toBe("IDEMPOTENCY_STORE_UNAVAILABLE");
    expect(decision.error.retryAfterSeconds).toBe(1);
  });

  it("hands back the reservation it now holds", async () => {
    const decision = await decideIdempotency(facts(), storeAnswering({ kind: "reserved" }));
    if (decision.kind !== "proceed") throw new Error("expected to proceed");
    expect(decision.held).toEqual<RequestFingerprint>(fingerprintFor(facts(), "key-1"));
  });

  it("replays a settled twin rather than running again", async () => {
    const response = { status: 201, body: '{"secret":"s"}', contentType: "application/json" };
    const decision = await decideIdempotency(facts(), storeAnswering({ kind: "replay", response }));
    expect(decision).toEqual({ kind: "replay", response });
  });

  it("gives each of the five store facts its OWN code", async () => {
    // The lesson this dimension was written around: two guards returning one
    // code cannot be told apart. Four of these five answer 409 and none of them
    // shares a code with another.
    const cases: readonly [RequestReservation, string][] = [
      [{ kind: "in-flight" }, "IDEMPOTENCY_REQUEST_IN_FLIGHT"],
      [{ kind: "mismatch" }, "IDEMPOTENCY_REQUEST_MISMATCH"],
      [{ kind: "absent" }, "IDEMPOTENCY_RECORD_ABSENT"],
      [{ kind: "malformed" }, "IDEMPOTENCY_RECORD_MALFORMED"],
      [{ kind: "unavailable", reason: "connect ECONNREFUSED" }, "IDEMPOTENCY_STORE_UNAVAILABLE"],
    ];
    const answered: string[] = [];
    for (const [reservation, code] of cases) {
      const decision = await decideIdempotency(facts(), storeAnswering(reservation));
      if (decision.kind !== "refuse") throw new Error(`expected a refusal for ${reservation.kind}`);
      expect(decision.error.code).toBe(code);
      answered.push(decision.error.code);
    }
    expect(new Set(answered).size).toBe(cases.length);
  });

  it("carries the store's own reason into the unavailable refusal", async () => {
    const decision = await decideIdempotency(
      facts(),
      storeAnswering({ kind: "unavailable", reason: "connect ECONNREFUSED" }),
    );
    if (decision.kind !== "refuse") throw new Error("expected a refusal");
    expect(decision.error.details).toEqual({
      operation: `POST ${MINT}`,
      reason: "connect ECONNREFUSED",
    });
  });
});

describe("settlementFor", () => {
  it("records an answer the operation actually reached, refusal included", () => {
    expect(settlementFor(201, 100)).toBe("record");
    expect(settlementFor(422, 100)).toBe("record");
    expect(settlementFor(499, 100)).toBe("record");
  });

  it("RELEASES a 5xx, so the retry the caller sent a key for can run", () => {
    expect(settlementFor(500, 100)).toBe("release");
    expect(settlementFor(503, 100)).toBe("release");
  });

  it("releases rather than recording a body it could not hold whole", () => {
    // A replay that returned half a secret is worse than a replay that never
    // happens.
    expect(settlementFor(200, 64 * 1024)).toBe("record");
    expect(settlementFor(200, 64 * 1024 + 1)).toBe("release");
  });
});
