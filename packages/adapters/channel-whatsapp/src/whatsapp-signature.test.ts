// THE CONSTRUCTION, DRIVEN BY AN INDEPENDENT HMAC — AND EVERY REFUSAL, WITH A
// CODE THAT SAYS WHY.
//
// `rfc4231.test.ts` proves the PRIMITIVE against RFC 4231's published vectors and
// against `rfc2104-oracle.ts`. What it cannot prove is Meta's rule for WHAT is
// signed: the RAW REQUEST BODY, keyed by the app secret, rendered as `sha256=`
// plus lower-case hex. Get that wrong — a timestamp prefix, the parsed body
// re-serialized, base64 instead of hex — and every case written against this
// adapter's own signer passes while production refuses every real delivery.
//
// SO EVERY POSITIVE CASE BELOW IS SIGNED BY THE ORACLE AND VERIFIED BY THE
// ADAPTER, and never by the same code twice. `rfc2104-oracle.ts` produces the
// digest from raw SHA-256; `verify.ts` recomputes it with `createHmac` and
// compares. Agreement is then between RFC 4231's vectors, an RFC 2104
// construction, and this adapter.
//
// WHAT IS STILL NOT JOINED, STATED PLAINLY. That `sha256=` + hex over the raw
// body IS Meta's rule rests on `vendor.ts`'s transcription of Meta's prose and on
// nothing executable. Slack publishes a worked example and `channel-slack`
// transcribes it; Meta does not, so this adapter has no such anchor and does not
// pretend to one.

import { describe, expect, it } from "vitest";

import { createChannelWhatsAppAdapter } from "./adapter.js";
import {
  ALL_FIXTURE_BODIES,
  CUSTOMER_WA_ID,
  FIXTURE_APP_SECRET,
  FIXTURE_INSTANT,
  FIXTURE_VERIFY_TOKEN,
  OTHER_APP_SECRET,
  signWhatsAppDelivery,
  TEXT_MESSAGE_BODY,
} from "./fixtures.js";
import { rfc2104HmacSha256 } from "./rfc2104-oracle.js";
import { WHATSAPP_SIGNATURE_HEADER, WHATSAPP_SIGNATURE_PREFIX } from "./vendor.js";

const adapter = createChannelWhatsAppAdapter();
const secret = { secret: FIXTURE_APP_SECRET };
const SIGNATURE_CODES = ["CHANNELS_SIGNATURE_ABSENT", "CHANNELS_SIGNATURE_INVALID"];

/** A delivery whose header was produced by the ORACLE, never by `verify.ts`. */
function oracleSigned(rawBody: string, appSecret = FIXTURE_APP_SECRET, receivedAt = FIXTURE_INSTANT) {
  const digest = rfc2104HmacSha256(Buffer.from(appSecret, "utf8"), Buffer.from(rawBody, "utf8"));
  return {
    rawBody,
    headers: { [WHATSAPP_SIGNATURE_HEADER]: `${WHATSAPP_SIGNATURE_PREFIX}${digest}` },
    receivedAt,
  };
}

async function codeOf(delivery: ReturnType<typeof signWhatsAppDelivery>, key = FIXTURE_APP_SECRET) {
  const outcome = await adapter.verifyInbound({ secret: key }, delivery);
  return outcome.ok ? "ACCEPTED" : outcome.error.code;
}

function withHeaders(delivery: ReturnType<typeof signWhatsAppDelivery>, headers: Record<string, string>) {
  return { ...delivery, headers };
}

describe("Meta's construction, as an independent HMAC produces it", () => {
  it("accepts every fixture signed by the RFC 2104 oracle", async () => {
    // One case walking every fixture rather than a generated table: the test-case
    // census counts rows statically, and the fixture list is a module value.
    expect(ALL_FIXTURE_BODIES.length).toBeGreaterThanOrEqual(17);
    for (const [name, body] of ALL_FIXTURE_BODIES) {
      // Verification passed if the answer is anything but a signature refusal;
      // several fixtures are deliberately refused AFTER verification, as input
      // defects, and that is a different code.
      expect(SIGNATURE_CODES, name).not.toContain(await codeOf(oracleSigned(body)));
    }
  });

  it("produces byte-identical headers from the oracle and from the adapter's own signer", () => {
    // If these ever differ, one of the two is not computing Meta's construction
    // and every other case in this file is testing a private fiction.
    for (const [name, body] of ALL_FIXTURE_BODIES) {
      expect(oracleSigned(body).headers, name).toEqual(signWhatsAppDelivery(body).headers);
    }
  });

  it("refuses a signature computed over the PARSED-AND-RESERIALIZED body", async () => {
    // THE CASE THAT MATTERS FOR A TRANSPORT. `JSON.stringify(JSON.parse(body))`
    // reorders nothing here but drops the formatting Meta sent, and the signature
    // covers octets. A transport that verified the re-serialized form would work
    // in a suite and fail intermittently in production; this pins that the
    // adapter signs and checks the RAW bytes.
    const pretty = JSON.stringify(JSON.parse(TEXT_MESSAGE_BODY), null, 2);
    expect(pretty).not.toBe(TEXT_MESSAGE_BODY);
    const forged = withHeaders(oracleSigned(TEXT_MESSAGE_BODY), oracleSigned(pretty).headers);
    expect(await codeOf(forged)).toBe("CHANNELS_SIGNATURE_INVALID");
  });
});

describe("a delivery that does not verify is refused, with a code that says why", () => {
  it("refuses INVALID when ONE CHARACTER of the body changes", async () => {
    const genuine = oracleSigned(TEXT_MESSAGE_BODY);
    const tampered = { ...genuine, rawBody: TEXT_MESSAGE_BODY.replace("river", "rivet") };
    expect(tampered.rawBody).not.toBe(genuine.rawBody);
    expect(tampered.rawBody.length).toBe(genuine.rawBody.length);
    expect(await codeOf(tampered)).toBe("CHANNELS_SIGNATURE_INVALID");
  });

  it("refuses INVALID under a real app secret that did not sign it", async () => {
    const genuine = oracleSigned(TEXT_MESSAGE_BODY);
    expect(await codeOf(genuine, OTHER_APP_SECRET)).toBe("CHANNELS_SIGNATURE_INVALID");
    // ...and the same bytes signed by THAT secret verify under it, so the case
    // above is about the key and not about the body.
    expect(await codeOf(oracleSigned(TEXT_MESSAGE_BODY, OTHER_APP_SECRET), OTHER_APP_SECRET)).toBe("ACCEPTED");
  });

  it("refuses INVALID when the configured secret is EMPTY", async () => {
    // An empty key HMACs perfectly well, so a forger who guessed that the install
    // left the variable blank could sign anything. `config/channels.ts` refuses it
    // at boot; this is the second line.
    const forged = oracleSigned(TEXT_MESSAGE_BODY, "");
    expect(await codeOf(forged, "")).toBe("CHANNELS_SIGNATURE_INVALID");
  });

  it("refuses INVALID for one flipped hex digit, a truncation, and trailing garbage", async () => {
    const genuine = oracleSigned(TEXT_MESSAGE_BODY);
    const header = genuine.headers[WHATSAPP_SIGNATURE_HEADER]!;
    const digest = header.slice(WHATSAPP_SIGNATURE_PREFIX.length);
    const flipped = `${digest.slice(0, -1)}${digest.endsWith("0") ? "1" : "0"}`;
    // `${digest}zz` IS THE ONE THAT MATTERS. `Buffer.from(x, "hex")` stops at the
    // first non-hex character, so it decodes to exactly the 32 genuine bytes and
    // would COMPARE EQUAL — a header carrying trailing garbage accepted as clean.
    // Only a grammar check on the string refuses it.
    for (const bad of [flipped, digest.slice(0, -2), `${digest.slice(0, -1)}x`, `${digest}zz`]) {
      expect(
        await codeOf(withHeaders(genuine, { [WHATSAPP_SIGNATURE_HEADER]: `${WHATSAPP_SIGNATURE_PREFIX}${bad}` })),
      ).toBe("CHANNELS_SIGNATURE_INVALID");
    }
  });

  it("refuses INVALID for a header with the wrong prefix, or none", async () => {
    const genuine = oracleSigned(TEXT_MESSAGE_BODY);
    const digest = genuine.headers[WHATSAPP_SIGNATURE_HEADER]!.slice(WHATSAPP_SIGNATURE_PREFIX.length);
    // `sha1=` IS THE DANGEROUS ONE. `X-Hub-Signature` carries a SHA-1 digest under
    // the same header family; an adapter that ignored the prefix would accept a
    // downgraded digest presented in the SHA-256 header.
    for (const bad of [digest, `sha1=${digest}`, `SHA256=${digest}`, `sha256:${digest}`]) {
      expect(await codeOf(withHeaders(genuine, { [WHATSAPP_SIGNATURE_HEADER]: bad }))).toBe(
        "CHANNELS_SIGNATURE_INVALID",
      );
    }
  });

  it("refuses ABSENT with no header, with a blank one, and with the wrong case", async () => {
    const genuine = oracleSigned(TEXT_MESSAGE_BODY);
    const header = genuine.headers[WHATSAPP_SIGNATURE_HEADER]!;
    const cases: ReadonlyArray<Record<string, string>> = [
      {},
      { [WHATSAPP_SIGNATURE_HEADER]: "" },
      { [WHATSAPP_SIGNATURE_HEADER]: "   " },
      // CASE MATTERS ON THIS MAP: the port says the transport lower-cases.
      { "X-Hub-Signature-256": header },
      // The SHA-1 header alone is not this one, however genuine it looks.
      { "x-hub-signature": header },
    ];
    for (const headers of cases) {
      expect(await codeOf(withHeaders(genuine, headers))).toBe("CHANNELS_SIGNATURE_ABSENT");
    }
  });
});

describe("this adapter never mints CHANNELS_SIGNATURE_STALE, and that is a decision", () => {
  it("accepts a genuine delivery received a week after the customer sent it", async () => {
    // `verify.ts` states the reasoning: Meta signs no timestamp, the only instant
    // inside the signed bytes is the customer's SEND time, and Meta retries an
    // undelivered webhook for days — so a window would throw away exactly the
    // deliveries an outage delayed, labelled as an authentication failure.
    // WHEN THIS FAILS, someone has added a replay window; the defence that
    // replaced it is the inbox's idempotency on the message id, and
    // `signed-admission.test.ts` is where that is proven.
    const week = new Date(FIXTURE_INSTANT.getTime() + 7 * 24 * 3_600_000);
    expect(await codeOf(oracleSigned(TEXT_MESSAGE_BODY, FIXTURE_APP_SECRET, week))).toBe("ACCEPTED");
    const past = new Date(FIXTURE_INSTANT.getTime() - 7 * 24 * 3_600_000);
    expect(await codeOf(oracleSigned(TEXT_MESSAGE_BODY, FIXTURE_APP_SECRET, past))).toBe("ACCEPTED");
  });

  it("mints exactly TWO distinguishable codes, each carrying only the provider", async () => {
    const genuine = oracleSigned(TEXT_MESSAGE_BODY);
    const outcomes = await Promise.all([
      adapter.verifyInbound(secret, withHeaders(genuine, {})),
      adapter.verifyInbound(secret, { ...genuine, rawBody: `${TEXT_MESSAGE_BODY} ` }),
    ]);
    const codes = outcomes.map((outcome) => (outcome.ok ? "ACCEPTED" : outcome.error.code));
    expect([...new Set(codes)].sort()).toEqual(SIGNATURE_CODES);
    for (const outcome of outcomes) {
      if (outcome.ok) continue;
      expect(outcome.error.category).toBe("unauthenticated");
      expect(outcome.error.details).toEqual({ provider: "whatsapp" });
      const rendered = `${outcome.error.message} ${JSON.stringify(outcome.error.details)}`;
      expect(rendered).not.toContain(FIXTURE_APP_SECRET);
      expect(rendered).not.toContain(genuine.headers[WHATSAPP_SIGNATURE_HEADER]!);
      expect(rendered).not.toContain(CUSTOMER_WA_ID);
    }
  });
});

describe("the subscription handshake, which is a GET with no body and no signature", () => {
  const verify = { verifyToken: FIXTURE_VERIFY_TOKEN };
  const query = (token: string, challenge = "1158201444") =>
    `hub.mode=subscribe&hub.challenge=${challenge}&hub.verify_token=${encodeURIComponent(token)}`;

  it("echoes the challenge verbatim and admits nothing", () => {
    const outcome = adapter.verifySubscription(verify, { rawQuery: query(FIXTURE_VERIFY_TOKEN) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.kind).toBe("handshake");
    // THE WHOLE RESPONSE BODY Meta requires, and it is NOT JSON. A quoted or
    // wrapped challenge fails the subscription and no webhook is ever delivered.
    expect(outcome.value.handshakeEcho).toBe("1158201444");
    expect(outcome.value.providerEventId).toBeNull();
    expect(outcome.value.message).toBeNull();
    expect(outcome.value.verifiedBody).toBe(query(FIXTURE_VERIFY_TOKEN));
  });

  it("refuses INVALID for a wrong token, a prefix of the token, and a longer one", () => {
    // THE LENGTH CASES ARE THE POINT. `timingSafeEqual` throws on a length
    // mismatch, and the caller chooses the query — so an unguarded comparison
    // lets an anonymous GET decide whether this process answers 500, and the
    // difference between "wrong length" and "wrong value" leaks the token's size.
    for (const token of [
      "not-the-token",
      FIXTURE_VERIFY_TOKEN.slice(0, -1),
      `${FIXTURE_VERIFY_TOKEN}x`,
      "",
      FIXTURE_VERIFY_TOKEN.toUpperCase(),
    ]) {
      const outcome = adapter.verifySubscription(verify, { rawQuery: query(token) });
      expect(outcome.ok ? "ACCEPTED" : outcome.error.code, token).toBe("CHANNELS_SIGNATURE_INVALID");
    }
  });

  it("refuses ABSENT when the request is not a subscription handshake at all", () => {
    for (const rawQuery of [
      "",
      "hub.mode=unsubscribe&hub.challenge=1&hub.verify_token=x",
      `hub.mode=subscribe&hub.verify_token=${FIXTURE_VERIFY_TOKEN}`,
      `hub.mode=subscribe&hub.challenge=&hub.verify_token=${FIXTURE_VERIFY_TOKEN}`,
      "hub.mode=subscribe&hub.challenge=1",
    ]) {
      const outcome = adapter.verifySubscription(verify, { rawQuery });
      expect(outcome.ok ? "ACCEPTED" : outcome.error.code, rawQuery).toBe("CHANNELS_SIGNATURE_ABSENT");
    }
  });

  it("refuses INVALID when the install configured no verify token", () => {
    const outcome = adapter.verifySubscription({ verifyToken: "" }, { rawQuery: query("") });
    expect(outcome.ok ? "ACCEPTED" : outcome.error.code).toBe("CHANNELS_SIGNATURE_INVALID");
  });

  it("carries nothing a caller could grind against", () => {
    const outcome = adapter.verifySubscription(verify, { rawQuery: query("wrong") });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.details).toEqual({ provider: "whatsapp" });
    expect(`${outcome.error.message}`).not.toContain(FIXTURE_VERIFY_TOKEN);
  });
});
