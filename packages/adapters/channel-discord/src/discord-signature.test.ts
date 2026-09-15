// THE CONSTRUCTION, JOINED TO DISCORD'S OWN LIBRARY — AND EVERY REFUSAL, WITH A
// CODE THAT SAYS WHY.
//
// `rfc8032.test.ts` proves the PRIMITIVE against the standard. What it cannot
// prove is Discord's rule for WHAT is signed: the timestamp header's value
// followed by the raw body, UTF-8, hex signature. Get that wrong — body first, a
// separator, the signature base64 — and every case written against this
// adapter's own signer passes while production refuses every real interaction.
//
// SO THE CONSTRUCTION HAS A SECOND, INDEPENDENT READER. `discord-interactions` is
// the helper library Discord publishes (github.com/discord/discord-interactions-js)
// and `developers/interactions/overview.mdx` points integrators at; its
// `verifyKey(rawBody, signature, timestamp, publicKey)` is the construction in
// Discord's own code, running on WebCrypto rather than on this adapter's
// `node:crypto` call. Every fixture must be accepted by BOTH, and a delivery
// signed the other way round must be refused by BOTH. Agreement is then between
// RFC 8032's key pair, Discord's library, and this adapter.
//
// THE REFUSALS ARE REAL. Each negative is a genuine signed delivery with ONE thing
// changed, and where Discord's library has an opinion it is asked too — so a
// refusal is shown to be one Discord's own code would also make, except for the
// one place this adapter is deliberately stricter: the replay window, which that
// library does not implement at all.

import { InteractionResponseType, InteractionType, verifyKey } from "discord-interactions";
import { describe, expect, it } from "vitest";

import { createChannelDiscordAdapter } from "./adapter.js";
import {
  ALL_FIXTURE_BODIES,
  COMMAND_IN_CHANNEL_BODY,
  FIXTURE_INSTANT,
  FIXTURE_PUBLIC_KEY,
  OTHER_PUBLIC_KEY,
  PING_BODY,
  signDiscordDelivery,
} from "./fixtures.js";
import { DISCORD_CALLBACK_TYPE, DISCORD_INTERACTION_TYPE, DISCORD_SIGNATURE_HEADER, DISCORD_TIMESTAMP_HEADER } from "./vendor.js";

const adapter = createChannelDiscordAdapter();
const secret = { secret: FIXTURE_PUBLIC_KEY };
const SIGNATURE_CODES = ["CHANNELS_SIGNATURE_ABSENT", "CHANNELS_SIGNATURE_INVALID", "CHANNELS_SIGNATURE_STALE"];

async function codeOf(delivery: ReturnType<typeof signDiscordDelivery>, key = FIXTURE_PUBLIC_KEY, subject = adapter) {
  const outcome = await subject.verifyInbound({ secret: key }, delivery);
  return outcome.ok ? "ACCEPTED" : outcome.error.code;
}

function withHeaders(delivery: ReturnType<typeof signDiscordDelivery>, headers: Record<string, string>) {
  return { ...delivery, headers };
}

async function discordAccepts(delivery: ReturnType<typeof signDiscordDelivery>, key = FIXTURE_PUBLIC_KEY) {
  return verifyKey(
    delivery.rawBody,
    delivery.headers[DISCORD_SIGNATURE_HEADER] ?? "",
    delivery.headers[DISCORD_TIMESTAMP_HEADER] ?? "",
    key,
  );
}

describe("Discord's construction, as Discord's own library reads it", () => {
  it("accepts every fixture through discord-interactions AND verifies each one here", async () => {
    // One case walking every fixture rather than a generated table: the test-case
    // census counts rows statically, and the fixture list is a module value.
    expect(ALL_FIXTURE_BODIES.length).toBeGreaterThanOrEqual(12);
    for (const [name, body] of ALL_FIXTURE_BODIES) {
      const delivery = signDiscordDelivery(body);
      expect(await discordAccepts(delivery), name).toBe(true);
      // Verification passed if the answer is anything but a signature refusal;
      // two fixtures are deliberately refused AFTER verification, as input defects.
      expect(SIGNATURE_CODES, name).not.toContain(await codeOf(delivery));
    }
  });

  it("refuses a delivery signed over body + timestamp, and so does Discord's library", async () => {
    // THE ORDERING CASE. Everything about this delivery is genuine except the
    // order of the two halves of the signed message. If the adapter concatenated
    // the other way round, it would accept this and refuse every real delivery.
    const genuine = signDiscordDelivery(COMMAND_IN_CHANNEL_BODY);
    const timestamp = genuine.headers[DISCORD_TIMESTAMP_HEADER]!;
    const reversed = signDiscordDelivery(`${COMMAND_IN_CHANNEL_BODY}${timestamp}`, { timestamp: "" });
    const forged = withHeaders(genuine, {
      [DISCORD_TIMESTAMP_HEADER]: timestamp,
      [DISCORD_SIGNATURE_HEADER]: reversed.headers[DISCORD_SIGNATURE_HEADER]!,
    });
    expect(await discordAccepts(forged)).toBe(false);
    expect(await codeOf(forged)).toBe("CHANNELS_SIGNATURE_INVALID");
    expect(await discordAccepts(genuine)).toBe(true);
    expect(await codeOf(genuine)).toBe("ACCEPTED");
  });

  it("uses the interaction and callback numbers Discord's library defines", () => {
    // `vendor.ts` transcribes these from the documentation; this joins the
    // transcription to Discord's code. A wrong PONG kills the endpoint.
    expect(DISCORD_INTERACTION_TYPE.PING).toBe(InteractionType.PING);
    expect(DISCORD_INTERACTION_TYPE.APPLICATION_COMMAND).toBe(InteractionType.APPLICATION_COMMAND);
    expect(DISCORD_INTERACTION_TYPE.MESSAGE_COMPONENT).toBe(InteractionType.MESSAGE_COMPONENT);
    expect(DISCORD_INTERACTION_TYPE.APPLICATION_COMMAND_AUTOCOMPLETE).toBe(InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE);
    expect(DISCORD_INTERACTION_TYPE.MODAL_SUBMIT).toBe(InteractionType.MODAL_SUBMIT);
    expect(DISCORD_CALLBACK_TYPE.PONG).toBe(InteractionResponseType.PONG);
    expect(DISCORD_CALLBACK_TYPE.CHANNEL_MESSAGE_WITH_SOURCE).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(DISCORD_CALLBACK_TYPE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE).toBe(
      InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    );
  });
});

describe("a delivery that does not verify is refused, with a code that says why", () => {
  it("refuses INVALID when ONE CHARACTER of the body changes", async () => {
    const genuine = signDiscordDelivery(COMMAND_IN_CHANNEL_BODY);
    const tampered = { ...genuine, rawBody: COMMAND_IN_CHANNEL_BODY.replace("river", "rivet") };
    expect(tampered.rawBody).not.toBe(genuine.rawBody);
    expect(tampered.rawBody.length).toBe(genuine.rawBody.length);
    expect(await discordAccepts(tampered)).toBe(false);
    expect(await codeOf(tampered)).toBe("CHANNELS_SIGNATURE_INVALID");
  });

  it("refuses INVALID when the timestamp changes by one second, still inside the window", async () => {
    // The timestamp is INSIDE the signed message. Moving it one second keeps the
    // request well within the replay window, so only the cryptography can refuse
    // it — which is the proof that the timestamp is signed and not merely read.
    const genuine = signDiscordDelivery(COMMAND_IN_CHANNEL_BODY);
    const moved = String(Number(genuine.headers[DISCORD_TIMESTAMP_HEADER]) + 1);
    const tampered = withHeaders(genuine, { ...genuine.headers, [DISCORD_TIMESTAMP_HEADER]: moved });
    expect(await discordAccepts(tampered)).toBe(false);
    expect(await codeOf(tampered)).toBe("CHANNELS_SIGNATURE_INVALID");
  });

  it("refuses INVALID under a real key that did not sign it", async () => {
    // RFC 8032 TEST 2's key: a valid point, just not the signer.
    const genuine = signDiscordDelivery(COMMAND_IN_CHANNEL_BODY);
    expect(await discordAccepts(genuine, OTHER_PUBLIC_KEY)).toBe(false);
    expect(await codeOf(genuine, OTHER_PUBLIC_KEY)).toBe("CHANNELS_SIGNATURE_INVALID");
  });

  it("refuses INVALID for one flipped hex digit of the signature, and for a malformed one", async () => {
    const genuine = signDiscordDelivery(COMMAND_IN_CHANNEL_BODY);
    const signature = genuine.headers[DISCORD_SIGNATURE_HEADER]!;
    const flipped = `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
    // `${signature}zz` IS THE ONE THAT MATTERS. `Buffer.from(x, "hex")` stops at
    // the first non-hex character, so it decodes to exactly the 64 genuine bytes
    // and would VERIFY — a signature header carrying trailing garbage accepted as
    // if it were clean. Only a grammar check on the string refuses it.
    for (const bad of [flipped, signature.slice(0, -2), `${signature.slice(0, -1)}x`, `${signature}zz`]) {
      expect(await codeOf(withHeaders(genuine, { ...genuine.headers, [DISCORD_SIGNATURE_HEADER]: bad }))).toBe(
        "CHANNELS_SIGNATURE_INVALID",
      );
    }
  });

  it("refuses INVALID when the configured key is not a key at all", async () => {
    const genuine = signDiscordDelivery(COMMAND_IN_CHANNEL_BODY);
    expect(await codeOf(genuine, "not-a-public-key")).toBe("CHANNELS_SIGNATURE_INVALID");
    expect(await codeOf(genuine, FIXTURE_PUBLIC_KEY.slice(0, 62))).toBe("CHANNELS_SIGNATURE_INVALID");
    // The same truncation hazard on the KEY: `zz` after 64 genuine digits decodes
    // to the genuine key, and a configured value with a typo'd tail would verify.
    expect(await codeOf(genuine, `${FIXTURE_PUBLIC_KEY}zz`)).toBe("CHANNELS_SIGNATURE_INVALID");
  });

  it("refuses STALE for a genuine delivery received an hour late, which Discord's library would accept", async () => {
    // THE ONE PLACE THIS ADAPTER IS STRICTER THAN DISCORD'S HELPER, stated as an
    // assertion so the difference cannot be forgotten. The library checks the
    // signature and never the instant; a captured interaction replays through it
    // forever. Here it is refused, and refused as a CLOCK problem.
    const late = signDiscordDelivery(COMMAND_IN_CHANNEL_BODY, {
      receivedAt: new Date(FIXTURE_INSTANT.getTime() + 3_600_000),
    });
    expect(await discordAccepts(late)).toBe(true);
    expect(await codeOf(late)).toBe("CHANNELS_SIGNATURE_STALE");
  });

  it("refuses STALE for a timestamp an hour in the FUTURE, which is the same replay", async () => {
    const early = signDiscordDelivery(COMMAND_IN_CHANNEL_BODY, {
      receivedAt: new Date(FIXTURE_INSTANT.getTime() - 3_600_000),
    });
    expect(await codeOf(early)).toBe("CHANNELS_SIGNATURE_STALE");
  });

  it("accepts at the window edge and refuses one second past it, on both sides", async () => {
    const at = (seconds: number) =>
      signDiscordDelivery(COMMAND_IN_CHANNEL_BODY, { receivedAt: new Date(FIXTURE_INSTANT.getTime() + seconds * 1000) });
    expect(await codeOf(at(300))).toBe("ACCEPTED");
    expect(await codeOf(at(-300))).toBe("ACCEPTED");
    expect(await codeOf(at(301))).toBe("CHANNELS_SIGNATURE_STALE");
    expect(await codeOf(at(-301))).toBe("CHANNELS_SIGNATURE_STALE");
  });

  it("refuses STALE for a timestamp that is not whole seconds", async () => {
    // Signed over the odd timestamp, so the signature is VALID for it: the only
    // thing wrong is the instant it claims.
    for (const timestamp of ["not-a-time", "1775044800.5", "+1775044800"]) {
      expect(await codeOf(signDiscordDelivery(COMMAND_IN_CHANNEL_BODY, { timestamp }))).toBe("CHANNELS_SIGNATURE_STALE");
    }
  });

  it("refuses ABSENT with no headers, with only one, and with a blank one", async () => {
    const genuine = signDiscordDelivery(COMMAND_IN_CHANNEL_BODY);
    const timestamp = genuine.headers[DISCORD_TIMESTAMP_HEADER]!;
    const signature = genuine.headers[DISCORD_SIGNATURE_HEADER]!;
    const cases: ReadonlyArray<Record<string, string>> = [
      {},
      { [DISCORD_SIGNATURE_HEADER]: signature },
      { [DISCORD_TIMESTAMP_HEADER]: timestamp },
      { [DISCORD_TIMESTAMP_HEADER]: timestamp, [DISCORD_SIGNATURE_HEADER]: "  " },
      // CASE MATTERS ON THIS MAP: the port says the transport lower-cases.
      { "X-Signature-Timestamp": timestamp, "X-Signature-Ed25519": signature },
    ];
    for (const headers of cases) {
      expect(await codeOf(withHeaders(genuine, headers))).toBe("CHANNELS_SIGNATURE_ABSENT");
    }
  });

  it("widens the window only when the install says so", async () => {
    const late = signDiscordDelivery(COMMAND_IN_CHANNEL_BODY, {
      receivedAt: new Date(FIXTURE_INSTANT.getTime() + 3_600_000),
    });
    expect(await codeOf(late, FIXTURE_PUBLIC_KEY, createChannelDiscordAdapter({ requestMaxAgeSeconds: 7200 }))).toBe(
      "ACCEPTED",
    );
  });

  it("follows a rotated key on the next delivery, and back again", async () => {
    // The parsed key is cached per runtime. A cache keyed on anything but the
    // key string would keep accepting under the old key after a rotation.
    const subject = createChannelDiscordAdapter();
    const genuine = signDiscordDelivery(COMMAND_IN_CHANNEL_BODY);
    expect(await codeOf(genuine, FIXTURE_PUBLIC_KEY, subject)).toBe("ACCEPTED");
    expect(await codeOf(genuine, OTHER_PUBLIC_KEY, subject)).toBe("CHANNELS_SIGNATURE_INVALID");
    expect(await codeOf(genuine, FIXTURE_PUBLIC_KEY, subject)).toBe("ACCEPTED");
  });
});

describe("a refusal tells the caller nothing a forger could grind against", () => {
  it("mints THREE distinguishable codes, each carrying only the provider", async () => {
    const genuine = signDiscordDelivery(PING_BODY);
    const outcomes = await Promise.all([
      adapter.verifyInbound(secret, withHeaders(genuine, {})),
      adapter.verifyInbound(secret, signDiscordDelivery(PING_BODY, { receivedAt: new Date(FIXTURE_INSTANT.getTime() + 3_600_000) })),
      adapter.verifyInbound(secret, { ...genuine, rawBody: `${PING_BODY} ` }),
    ]);
    const codes = outcomes.map((outcome) => (outcome.ok ? "ACCEPTED" : outcome.error.code));
    expect([...new Set(codes)].sort()).toEqual(SIGNATURE_CODES);
    for (const outcome of outcomes) {
      if (outcome.ok) continue;
      expect(outcome.error.category).toBe("unauthenticated");
      expect(outcome.error.details).toEqual({ provider: "discord" });
      const rendered = `${outcome.error.message} ${JSON.stringify(outcome.error.details)}`;
      expect(rendered).not.toContain(FIXTURE_PUBLIC_KEY);
      expect(rendered).not.toContain(genuine.headers[DISCORD_SIGNATURE_HEADER]!);
      expect(rendered).not.toContain(genuine.headers[DISCORD_TIMESTAMP_HEADER]!);
    }
  });
});
