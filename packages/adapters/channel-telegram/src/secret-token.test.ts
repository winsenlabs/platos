// THE INBOUND CHECK, AND AN HONEST ACCOUNT OF WHAT EACH CASE IS WORTH.
//
// READ `adapter.ts`'s HEADER FIRST. Telegram's inbound verification compares the
// `X-Telegram-Bot-Api-Secret-Token` header against a value the integrator itself
// gave `setWebhook`. There is no algorithm, no key pair and no published vector,
// so the obvious suite — set the token, send the token, assert acceptance — is an
// assertion that passes for `return ok()` and is therefore not evidence. This
// file is written so that the cases which CAN fail are the ones doing the work:
//
//   JOINED TO SOMETHING THIS REPOSITORY DOES NOT CONTROL. The first describe
//   block pins `secretsMatch` against `node:crypto`'s OWN `timingSafeEqual`: for
//   every equal-length pair the two must agree exactly, and everywhere
//   `timingSafeEqual` THROWS this must answer `false`. Node's documented
//   behaviour is the oracle, and it is the half that protects the token — a
//   byte-at-a-time comparison is a remote timing oracle, and an unguarded
//   `timingSafeEqual` is a 500 an anonymous caller can trigger at will.
//
//   REFUSALS, WHICH ARE REAL DEFECTS A PLAUSIBLE IMPLEMENTATION HAS. A wrong
//   token, a missing header, a blank header, a token that is a PREFIX of the right
//   one, one LONGER than it, and a configured token outside `setWebhook`'s own
//   documented grammar. Each of those passes under some wrong implementation —
//   `startsWith`, `===` against `undefined`, an unguarded length — and fails here.
//
//   AND ONE ACCEPTANCE, LABELLED AS THE WEAK ONE. "The right token is accepted"
//   is here because its absence would be worse, not because it proves anything.

import { timingSafeEqual } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createChannelTelegramAdapter } from "./adapter.js";
import {
  FIXTURE_INSTANT,
  FIXTURE_SECRET_TOKEN,
  OTHER_SECRET_TOKEN,
  PRIVATE_MESSAGE_BODY,
  telegramDelivery,
} from "./fixtures.js";
import { secretsMatch } from "./secret-token.js";
import { TELEGRAM_SECRET_TOKEN_HEADER, TELEGRAM_SECRET_TOKEN_PATTERN } from "./vendor.js";

const adapter = createChannelTelegramAdapter();

async function codeOf(headers: Record<string, string>, configured = FIXTURE_SECRET_TOKEN) {
  const outcome = await adapter.verifyInbound(
    { secret: configured },
    { ...telegramDelivery(PRIVATE_MESSAGE_BODY), headers },
  );
  return outcome.ok ? "ACCEPTED" : outcome.error.code;
}

/** What `node:crypto` says about two strings, or `THREW` where it refuses to say. */
function nodeVerdict(left: string, right: string): boolean | "THREW" {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  try {
    return timingSafeEqual(a, b);
  } catch {
    return "THREW";
  }
}

describe("the comparison answers to node:crypto's own semantics", () => {
  const equalLength: ReadonlyArray<readonly [string, string]> = Object.freeze([
    [FIXTURE_SECRET_TOKEN, FIXTURE_SECRET_TOKEN],
    [FIXTURE_SECRET_TOKEN, OTHER_SECRET_TOKEN],
    // One character apart, at the FRONT — where a short-circuiting comparison
    // returns fastest and a timing oracle is widest.
    ["Aaaaaaaaaaaaaaaa", "Baaaaaaaaaaaaaaa"],
    // One character apart, at the BACK.
    ["aaaaaaaaaaaaaaaA", "aaaaaaaaaaaaaaaB"],
    ["x", "x"],
    ["x", "y"],
    // Case matters: a token is compared, not folded.
    [FIXTURE_SECRET_TOKEN, FIXTURE_SECRET_TOKEN.toUpperCase()],
  ]);

  it("agrees with timingSafeEqual on every equal-length pair", () => {
    for (const [left, right] of equalLength) {
      expect(Buffer.byteLength(left)).toBe(Buffer.byteLength(right));
      const node = nodeVerdict(left, right);
      expect(node, `${left} vs ${right}`).not.toBe("THREW");
      expect(secretsMatch(left, right), `${left} vs ${right}`).toBe(node);
    }
    // ...and the table is not vacuous: it holds both verdicts.
    const verdicts = equalLength.map(([left, right]) => secretsMatch(left, right));
    expect(new Set(verdicts)).toEqual(new Set([true, false]));
  });

  it("answers FALSE — never a throw — exactly where timingSafeEqual raises", () => {
    // THE CASE THAT IS A 500 IF IT IS GOT WRONG. On a public endpoint the caller
    // chooses the header, so an unguarded `timingSafeEqual` hands an anonymous
    // request the power to decide this process's response code — and the
    // difference between a 500 and a refusal is a length oracle for the token.
    const mismatched: ReadonlyArray<readonly [string, string]> = Object.freeze([
      [FIXTURE_SECRET_TOKEN, ""],
      [FIXTURE_SECRET_TOKEN, FIXTURE_SECRET_TOKEN.slice(0, -1)],
      [FIXTURE_SECRET_TOKEN, `${FIXTURE_SECRET_TOKEN}x`],
      [FIXTURE_SECRET_TOKEN, "x"],
      [FIXTURE_SECRET_TOKEN, "x".repeat(4096)],
    ]);
    for (const [configured, presented] of mismatched) {
      expect(nodeVerdict(configured, presented), presented).toBe("THREW");
      expect(() => secretsMatch(configured, presented)).not.toThrow();
      expect(secretsMatch(configured, presented), presented).toBe(false);
    }
  });

  it("refuses an EMPTY configured token, so an install with none authenticates nobody", () => {
    // Without this guard, `secretsMatch("", "")` would be TRUE — and every
    // anonymous caller presenting a blank header would be admitted.
    expect(secretsMatch("", "")).toBe(false);
    expect(secretsMatch("", FIXTURE_SECRET_TOKEN)).toBe(false);
  });

  it("is not a prefix test, which is the defect `startsWith` would leave", () => {
    expect(secretsMatch(FIXTURE_SECRET_TOKEN, FIXTURE_SECRET_TOKEN.slice(0, 8))).toBe(false);
    expect(secretsMatch(FIXTURE_SECRET_TOKEN.slice(0, 8), FIXTURE_SECRET_TOKEN)).toBe(false);
  });
});

describe("the fixture token is one setWebhook would have accepted", () => {
  it("matches the alphabet and length the Bot API documents", () => {
    // A fixture outside the vendor's grammar would make every case below a test
    // of a delivery Telegram could never have produced.
    expect(TELEGRAM_SECRET_TOKEN_PATTERN.test(FIXTURE_SECRET_TOKEN)).toBe(true);
    expect(TELEGRAM_SECRET_TOKEN_PATTERN.test(OTHER_SECRET_TOKEN)).toBe(true);
    expect(FIXTURE_SECRET_TOKEN.length).toBe(OTHER_SECRET_TOKEN.length);
    // ...and the grammar refuses what setWebhook refuses.
    for (const bad of ["", "has space", "has/slash", "a".repeat(257), "tok€n"]) {
      expect(TELEGRAM_SECRET_TOKEN_PATTERN.test(bad), bad).toBe(false);
    }
  });
});

describe("verifyInbound refuses, with a code that says why", () => {
  it("refuses ABSENT with no header, a blank header, and the wrong case", async () => {
    const cases: ReadonlyArray<Record<string, string>> = [
      {},
      { [TELEGRAM_SECRET_TOKEN_HEADER]: "" },
      { [TELEGRAM_SECRET_TOKEN_HEADER]: "   " },
      // CASE MATTERS ON THIS MAP: the port says the transport lower-cases.
      { "X-Telegram-Bot-Api-Secret-Token": FIXTURE_SECRET_TOKEN },
    ];
    for (const headers of cases) {
      expect(await codeOf(headers)).toBe("CHANNELS_SIGNATURE_ABSENT");
    }
  });

  it("refuses INVALID for a wrong token, a prefix, a longer one, and one with whitespace", async () => {
    for (const token of [
      OTHER_SECRET_TOKEN,
      FIXTURE_SECRET_TOKEN.slice(0, -1),
      `${FIXTURE_SECRET_TOKEN}x`,
      // NOT TRIMMED. A token with a trailing space is a different token, and
      // trimming would quietly widen the set of strings that authenticate.
      `${FIXTURE_SECRET_TOKEN} `,
      FIXTURE_SECRET_TOKEN.toUpperCase(),
    ]) {
      expect(await codeOf({ [TELEGRAM_SECRET_TOKEN_HEADER]: token }), token).toBe("CHANNELS_SIGNATURE_INVALID");
    }
  });

  it("refuses INVALID when the INSTALL's token is one setWebhook would not accept", async () => {
    // Such a token could never arrive, so every delivery would be refused as a
    // forgery and the endpoint would look broken rather than misconfigured.
    for (const configured of ["", "has space", "a".repeat(257)]) {
      expect(
        await codeOf({ [TELEGRAM_SECRET_TOKEN_HEADER]: configured === "" ? "x" : configured }, configured),
        configured,
      ).toBe("CHANNELS_SIGNATURE_INVALID");
    }
  });

  it("accepts the configured token — the weak case, kept because its absence would be worse", async () => {
    // STATED AS WHAT IT IS. This compares a value the suite set against a header
    // the suite wrote, and it passes for any implementation that returns success.
    // The cases above are the ones that can fail.
    expect(await codeOf({ [TELEGRAM_SECRET_TOKEN_HEADER]: FIXTURE_SECRET_TOKEN })).not.toBe(
      "CHANNELS_SIGNATURE_INVALID",
    );
    expect(await codeOf({ [TELEGRAM_SECRET_TOKEN_HEADER]: FIXTURE_SECRET_TOKEN })).not.toBe(
      "CHANNELS_SIGNATURE_ABSENT",
    );
  });

  it("mints exactly TWO distinguishable codes, each carrying only the provider", async () => {
    const outcomes = await Promise.all([
      adapter.verifyInbound({ secret: FIXTURE_SECRET_TOKEN }, { ...telegramDelivery(PRIVATE_MESSAGE_BODY), headers: {} }),
      adapter.verifyInbound(
        { secret: FIXTURE_SECRET_TOKEN },
        telegramDelivery(PRIVATE_MESSAGE_BODY, { secretToken: OTHER_SECRET_TOKEN }),
      ),
    ]);
    const codes = outcomes.map((outcome) => (outcome.ok ? "ACCEPTED" : outcome.error.code));
    expect([...new Set(codes)].sort()).toEqual(["CHANNELS_SIGNATURE_ABSENT", "CHANNELS_SIGNATURE_INVALID"]);
    for (const outcome of outcomes) {
      if (outcome.ok) continue;
      expect(outcome.error.category).toBe("unauthenticated");
      expect(outcome.error.details).toEqual({ provider: "telegram" });
      const rendered = `${outcome.error.message} ${JSON.stringify(outcome.error.details)}`;
      expect(rendered).not.toContain(FIXTURE_SECRET_TOKEN);
      expect(rendered).not.toContain(OTHER_SECRET_TOKEN);
    }
  });

  it("never mints CHANNELS_SIGNATURE_STALE, however old the delivery is", async () => {
    // `verify.ts` states the reasoning: nothing is signed, so a window would be a
    // window over an UNAUTHENTICATED claim — the `date` inside the update is a
    // value any caller holding the token can write. What defends against a repeat
    // is the inbox's idempotency on `update_id`.
    const week = new Date(FIXTURE_INSTANT.getTime() + 7 * 24 * 3_600_000);
    const outcome = await adapter.verifyInbound(
      { secret: FIXTURE_SECRET_TOKEN },
      telegramDelivery(PRIVATE_MESSAGE_BODY, { receivedAt: week }),
    );
    expect(outcome.ok).toBe(true);
  });
});
