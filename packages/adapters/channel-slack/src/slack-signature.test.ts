// THE SIGNATURE CASES, JOINED TO SLACK'S OWN PUBLISHED TEST VECTOR.
//
// LESSON 1 OF THIS PROGRAMME: an assertion comparing two things you control
// cannot fail. The obvious way to test a signature verifier is to compute an
// HMAC with `node:crypto`, hand it to the verifier, and assert acceptance — and
// that proves only that two copies of the same formula agree. If the formula is
// wrong (the wrong separator, the wrong prefix, the digest hex-cased, the
// timestamp omitted) BOTH sides are wrong together and the suite is green while
// production refuses every real delivery.
//
// SO THE ANCHOR IS EXTERNAL. Slack publishes a complete worked example in its
// request-verification documentation: a signing secret, a timestamp, a request
// body and the exact `v0=` signature they produce. That triple is reproduced
// verbatim below. NOTHING in this repository generated it, no code here can
// change it, and it is the same vector every other Slack integration in the
// world is checked against.
//
// The first case therefore proves something no self-computed HMAC can: that this
// adapter, through the vendor SDK it delegates cryptography to, agrees with
// Slack about what a valid signature IS. `published-vector.ts` re-derives the
// digest independently with `node:crypto` and asserts it equals the published
// constant, so the vector is also proven to be the vector rather than a
// transcription error.
//
// THE REFUSALS ARE THEN REAL REFUSALS. Every negative case below is the
// PUBLISHED VECTOR WITH ONE THING CHANGED — a header removed, one character of
// the body flipped, the clock moved. Nothing is told to fail; the failure comes
// out of the same cryptography that produced the acceptance one case earlier.

import { describe, expect, it } from "vitest";

import { createChannelSlackAdapter } from "./adapter.js";
import {
  PUBLISHED_BODY,
  PUBLISHED_SECRET,
  PUBLISHED_SIGNATURE,
  PUBLISHED_TIMESTAMP,
  publishedDelivery,
  recomputePublishedSignature,
} from "./published-vector.js";

const adapter = createChannelSlackAdapter();

describe("Slack's own published request-verification vector", () => {
  it("reproduces byte-for-byte under node:crypto, so the vector is the vector", () => {
    // If this fails, the constants below were mistyped and every other case in
    // this file is testing a fiction.
    expect(recomputePublishedSignature()).toBe(PUBLISHED_SIGNATURE);
  });

  it("is ACCEPTED", async () => {
    const verified = await adapter.verifyInbound({ secret: PUBLISHED_SECRET }, publishedDelivery());
    expect(verified.ok).toBe(true);
  });

  it("is accepted only against the secret it was signed with", async () => {
    // The secret is changed in its LAST character only. A verifier that ignored
    // the secret entirely, or compared a prefix, would pass the case above and
    // fail here.
    const nearly = `${PUBLISHED_SECRET.slice(0, -1)}6`;
    const verified = await adapter.verifyInbound({ secret: nearly }, publishedDelivery());
    expect(verified.ok).toBe(false);
    expect(verified.ok ? null : verified.error.code).toBe("CHANNELS_SIGNATURE_INVALID");
  });
});

describe("a signature that does not verify is refused, with a code that says why", () => {
  it("refuses ABSENT when neither header is present", async () => {
    const verified = await adapter.verifyInbound(
      { secret: PUBLISHED_SECRET },
      publishedDelivery({ headers: {} }),
    );
    expect(verified.ok).toBe(false);
    expect(verified.ok ? null : verified.error.code).toBe("CHANNELS_SIGNATURE_ABSENT");
  });

  it("refuses ABSENT when the signature is present and the timestamp is not", async () => {
    // Half-signed is not signed. Accepting this would let a captured signature
    // be replayed at any instant, because the instant would never be checked.
    const verified = await adapter.verifyInbound(
      { secret: PUBLISHED_SECRET },
      publishedDelivery({ headers: { "x-slack-signature": PUBLISHED_SIGNATURE } }),
    );
    expect(verified.ok).toBe(false);
    expect(verified.ok ? null : verified.error.code).toBe("CHANNELS_SIGNATURE_ABSENT");
  });

  it("refuses ABSENT for a header that is present and empty", async () => {
    const verified = await adapter.verifyInbound(
      { secret: PUBLISHED_SECRET },
      publishedDelivery({
        headers: { "x-slack-request-timestamp": PUBLISHED_TIMESTAMP, "x-slack-signature": "   " },
      }),
    );
    expect(verified.ok).toBe(false);
    expect(verified.ok ? null : verified.error.code).toBe("CHANNELS_SIGNATURE_ABSENT");
  });

  it("refuses INVALID when ONE BYTE of the body changes", async () => {
    // The single most important negative in this file. The signature, the
    // timestamp, the secret and the clock are all the published ones; only the
    // body moved, by one character in the middle of a value. A verifier that
    // hashed anything other than the exact received octets — a re-serialized
    // parse, a trimmed string, a prefix — would accept this.
    const tampered = PUBLISHED_BODY.replace("roadrunner", "roadrunneR");
    expect(tampered).not.toBe(PUBLISHED_BODY);
    expect(tampered.length).toBe(PUBLISHED_BODY.length);

    const verified = await adapter.verifyInbound(
      { secret: PUBLISHED_SECRET },
      publishedDelivery({ rawBody: tampered }),
    );
    expect(verified.ok).toBe(false);
    expect(verified.ok ? null : verified.error.code).toBe("CHANNELS_SIGNATURE_INVALID");
  });

  it("refuses INVALID when one hex digit of the signature changes", async () => {
    const flipped = PUBLISHED_SIGNATURE.endsWith("3")
      ? `${PUBLISHED_SIGNATURE.slice(0, -1)}4`
      : `${PUBLISHED_SIGNATURE.slice(0, -1)}3`;
    const verified = await adapter.verifyInbound(
      { secret: PUBLISHED_SECRET },
      publishedDelivery({
        headers: { "x-slack-request-timestamp": PUBLISHED_TIMESTAMP, "x-slack-signature": flipped },
      }),
    );
    expect(verified.ok).toBe(false);
    expect(verified.ok ? null : verified.error.code).toBe("CHANNELS_SIGNATURE_INVALID");
  });

  it("refuses STALE for a valid signature outside the replay window", async () => {
    // NOTHING ABOUT THE REQUEST IS WRONG. It is Slack's vector, signed by Slack,
    // verifying perfectly — received an hour late. That is the replay a captured
    // request enables, and STALE rather than INVALID is what tells an operator
    // to look at a clock instead of at a secret.
    const late = new Date((Number(PUBLISHED_TIMESTAMP) + 3600) * 1000);
    const verified = await adapter.verifyInbound(
      { secret: PUBLISHED_SECRET },
      publishedDelivery({ receivedAt: late }),
    );
    expect(verified.ok).toBe(false);
    expect(verified.ok ? null : verified.error.code).toBe("CHANNELS_SIGNATURE_STALE");
  });

  it("refuses STALE for a timestamp in the FUTURE, which is the same replay", async () => {
    const early = new Date((Number(PUBLISHED_TIMESTAMP) - 3600) * 1000);
    const verified = await adapter.verifyInbound(
      { secret: PUBLISHED_SECRET },
      publishedDelivery({ receivedAt: early }),
    );
    expect(verified.ok).toBe(false);
    expect(verified.ok ? null : verified.error.code).toBe("CHANNELS_SIGNATURE_STALE");
  });

  it("accepts at the window edge and refuses one second past it", async () => {
    // The boundary, both sides, because an off-by-one here is worth exactly one
    // window of extra replay and is invisible in every other case.
    const edge = new Date((Number(PUBLISHED_TIMESTAMP) + 300) * 1000);
    const past = new Date((Number(PUBLISHED_TIMESTAMP) + 301) * 1000);
    expect((await adapter.verifyInbound({ secret: PUBLISHED_SECRET }, publishedDelivery({ receivedAt: edge }))).ok).toBe(true);
    const refused = await adapter.verifyInbound({ secret: PUBLISHED_SECRET }, publishedDelivery({ receivedAt: past }));
    expect(refused.ok ? null : refused.error.code).toBe("CHANNELS_SIGNATURE_STALE");
  });

  it("refuses STALE for a timestamp that is not a number at all", async () => {
    const verified = await adapter.verifyInbound(
      { secret: PUBLISHED_SECRET },
      publishedDelivery({
        headers: { "x-slack-request-timestamp": "not-a-time", "x-slack-signature": PUBLISHED_SIGNATURE },
      }),
    );
    expect(verified.ok).toBe(false);
    expect(verified.ok ? null : verified.error.code).toBe("CHANNELS_SIGNATURE_STALE");
  });

  it("widens the window only when the install says so", async () => {
    const late = new Date((Number(PUBLISHED_TIMESTAMP) + 3600) * 1000);
    const widened = createChannelSlackAdapter({ requestMaxAgeSeconds: 7200 });
    expect((await widened.verifyInbound({ secret: PUBLISHED_SECRET }, publishedDelivery({ receivedAt: late }))).ok).toBe(true);
  });
});

describe("a refusal tells the caller nothing a forger could grind against", () => {
  it("carries the provider and no comparison, expected value or clock delta", async () => {
    const late = new Date((Number(PUBLISHED_TIMESTAMP) + 3600) * 1000);
    const cases = [
      await adapter.verifyInbound({ secret: PUBLISHED_SECRET }, publishedDelivery({ headers: {} })),
      await adapter.verifyInbound({ secret: PUBLISHED_SECRET }, publishedDelivery({ receivedAt: late })),
      await adapter.verifyInbound({ secret: `${PUBLISHED_SECRET}x` }, publishedDelivery()),
    ];
    for (const outcome of cases) {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.error.category).toBe("unauthenticated");
      expect(Object.keys(outcome.error.details)).toEqual(["provider"]);
      const rendered = `${outcome.error.message} ${JSON.stringify(outcome.error.details)}`;
      expect(rendered).not.toContain(PUBLISHED_SECRET);
      expect(rendered).not.toContain(PUBLISHED_SIGNATURE);
      expect(rendered).not.toContain(PUBLISHED_TIMESTAMP);
    }
  });

  it("mints THREE distinguishable codes rather than one", async () => {
    // Lesson 7: two guards returning the same code cannot be told apart. The
    // three refusals above must be three values, and this is the case that
    // fails if a later edit collapses them.
    const late = new Date((Number(PUBLISHED_TIMESTAMP) + 3600) * 1000);
    const codes = new Set(
      await Promise.all(
        [
          publishedDelivery({ headers: {} }),
          publishedDelivery({ receivedAt: late }),
          publishedDelivery({ rawBody: `${PUBLISHED_BODY}&extra=1` }),
        ].map(async (delivery) => {
          const outcome = await adapter.verifyInbound({ secret: PUBLISHED_SECRET }, delivery);
          return outcome.ok ? "ACCEPTED" : outcome.error.code;
        }),
      ),
    );
    expect([...codes].sort()).toEqual([
      "CHANNELS_SIGNATURE_ABSENT",
      "CHANNELS_SIGNATURE_INVALID",
      "CHANNELS_SIGNATURE_STALE",
    ]);
  });
});
