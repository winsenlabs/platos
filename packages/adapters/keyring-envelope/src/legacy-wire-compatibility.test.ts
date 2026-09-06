// Does this reader speak the two formats every legacy secret was written in?
//
// The six payloads it opens were produced by the two modules
// `secrets/domain/envelope.ts` names as those formats' `legacyOrigin` —
// `internal-packages/tenancy-database/src/auth.ts` and
// `apps/agent/src/auth/secrets.service.ts` — neither of which this issue edits.
// That is the whole design of the file. A suite that sealed a legacy envelope
// with this package's code and opened it with this package's code would compare
// two things one tranche controls: swap the iv and the tag, or read 12 bytes
// where the source writes 16, and both halves move together and it stays green.
// A ciphertext moves with neither.

import { describe, expect, it } from "vitest";

import type { EnvelopeFormatVersion } from "@platos/context-secrets/application/ports/index.js";

import { createLegacyEnvelopeReader } from "./legacy-envelope-reader.js";
import type { LegacyWireVector } from "./legacy-wire-vectors.js";
import { LEGACY_WIRE_VECTORS, legacyKeysFor, legacyVectorsOfFormat } from "./legacy-wire-vectors.js";

/**
 * Open one vector, or report why not.
 *
 * A HELPER AND NOT A LOOP OVER `it()`, for the reason `wire-compatibility.test.ts`
 * gives: `scripts/arch/test-case-census.mjs` refuses an `it()` declared inside a
 * loop, because a construct it cannot count is a construct that can silently lose
 * a case. Each vector gets its own named case and the shared body lives here.
 */
async function openVector(vector: LegacyWireVector) {
  return createLegacyEnvelopeReader(legacyKeysFor(vector)).openLegacy({
    formatVersion: vector.formatVersion as EnvelopeFormatVersion,
    payload: vector.payload,
  });
}

function vector(name: string): LegacyWireVector {
  const found = LEGACY_WIRE_VECTORS.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no legacy vector named: ${name}`);
  return found;
}

const FORMAT_2_TOTP = "format 2, a TOTP secret as `beginTotpEnrollment` stores one";
const FORMAT_2_LONG = "format 2, a longer payload under a second key";
const FORMAT_2_UNICODE = "format 2, non-ASCII plaintext under a third key";
const FORMAT_3_API_KEY = "format 3, an API key as `SecretsService.encrypt` stores one";
const FORMAT_3_JSON = "format 3, a service-account JSON fragment under a second key";
const FORMAT_3_UNICODE = "format 3, non-ASCII plaintext under a third key";

describe("format 2 — dotted base64url, 12-byte iv, written by auth.ts", () => {
  it("opens a TOTP secret the extraction source sealed", async () => {
    const subject = vector(FORMAT_2_TOTP);
    const opened = await openVector(subject);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.reveal()).toBe(subject.plaintext);
  });

  it("opens a payload longer than one AES block", async () => {
    // The TOTP vector's ciphertext is exactly 16 bytes. A field split with an
    // off-by-one could open that one by alignment; it cannot open this one.
    const subject = vector(FORMAT_2_LONG);
    const opened = await openVector(subject);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.reveal()).toBe(subject.plaintext);
  });

  it("opens multi-byte UTF-8, a newline and a tab", async () => {
    const subject = vector(FORMAT_2_UNICODE);
    const opened = await openVector(subject);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.reveal()).toBe(subject.plaintext);
  });
});

describe("format 3 — one packed base64 string, 16-byte iv, written by the agent", () => {
  it("opens an API key the extraction source sealed", async () => {
    const subject = vector(FORMAT_3_API_KEY);
    const opened = await openVector(subject);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.reveal()).toBe(subject.plaintext);
  });

  it("opens a payload whose base64 carries `/` and `+`", async () => {
    // The base64 and base64url alphabets differ in exactly two characters. A
    // reader that used format 2's alphabet here would decode different bytes.
    const subject = vector(FORMAT_3_JSON);
    expect(subject.payload).toMatch(/[/+]/u);
    const opened = await openVector(subject);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.reveal()).toBe(subject.plaintext);
  });

  it("opens multi-byte UTF-8, a newline and a tab", async () => {
    const subject = vector(FORMAT_3_UNICODE);
    const opened = await openVector(subject);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.reveal()).toBe(subject.plaintext);
  });
});

describe("the discriminator is load-bearing", () => {
  it("refuses a format-3 payload presented as format 2, by WIDTH and not by tag", async () => {
    // THE CASE THE WHOLE `formatVersion` FIELD EXISTS FOR. Both formats pack iv,
    // then tag, then ciphertext; only the iv width and the alphabet differ. Read
    // as format 2, this payload splits on dots it does not contain — so the
    // failure is named, and an operator learns the column's declared format is
    // wrong rather than chasing a key that was never wrong.
    const subject = vector(FORMAT_3_API_KEY);
    const opened = await createLegacyEnvelopeReader({
      keys: { "2": subject.legacyKeyHex },
    }).openLegacy({ formatVersion: 2, payload: subject.payload });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.error.code).toBe("LEGACY_ENVELOPE_UNREADABLE");
    expect(opened.error.details?.reason).toBe("payload_is_not_a_dotted_base64url_triple");
  });

  it("refuses a format-2 payload presented as format 3", async () => {
    const subject = vector(FORMAT_2_TOTP);
    const opened = await createLegacyEnvelopeReader({
      keys: { "3": subject.legacyKeyHex },
    }).openLegacy({ formatVersion: 3, payload: subject.payload });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.error.details?.reason).toBe("payload_is_not_base64");
  });

  it("refuses the canonical format with its own reason", async () => {
    // Format 1 is not a legacy shape and reaching this verb with it is a mistake
    // about the caller's own data. It gets a reason of its own so an operator's
    // log can tell it from `format_not_a_known_version`.
    const opened = await createLegacyEnvelopeReader({ keys: {} }).openLegacy({
      formatVersion: 1,
      payload: "anything",
    });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.error.details?.reason).toBe("format_is_already_canonical");
  });
});

describe("the key is judged, and its absence is the fail-closed default", () => {
  it("refuses when no legacy key is configured for the format", async () => {
    // An installation that has finished migrating DROPS these keys, and from that
    // day every call lands here. The default is reached by deleting configuration
    // rather than by shipping code.
    const subject = vector(FORMAT_2_TOTP);
    const opened = await createLegacyEnvelopeReader({ keys: {} }).openLegacy({
      formatVersion: 2,
      payload: subject.payload,
    });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.error.details?.reason).toBe("legacy_key_absent_for_format");
  });

  it("refuses a key that is not 32 bytes of hex", async () => {
    const subject = vector(FORMAT_2_TOTP);
    const opened = await createLegacyEnvelopeReader({ keys: { "2": "abcd" } }).openLegacy({
      formatVersion: 2,
      payload: subject.payload,
    });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.error.details?.reason).toBe("legacy_key_is_not_32_bytes");
  });

  it("refuses the RIGHT payload under the WRONG key, and says so distinctly", async () => {
    // The negative control that proves the six positives are not vacuous: same
    // vector, same format, a key from another vector. GCM's tag check is the only
    // thing that can refuse it, and its reason is distinct from every reason a
    // width or an encoding produces.
    const subject = vector(FORMAT_2_TOTP);
    const other = vector(FORMAT_2_LONG);
    expect(subject.legacyKeyHex).not.toBe(other.legacyKeyHex);
    const opened = await createLegacyEnvelopeReader({
      keys: { "2": other.legacyKeyHex },
    }).openLegacy({ formatVersion: 2, payload: subject.payload });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.error.details?.reason).toBe("legacy_envelope_open_failed");
  });

  it("refuses a payload whose tag has been flipped", async () => {
    const subject = vector(FORMAT_3_API_KEY);
    const packed = Buffer.from(subject.payload, "base64");
    packed[20] = (packed[20] ?? 0) ^ 0xff;
    const opened = await createLegacyEnvelopeReader(legacyKeysFor(subject)).openLegacy({
      formatVersion: 3,
      payload: packed.toString("base64"),
    });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.error.details?.reason).toBe("legacy_envelope_open_failed");
  });
});

describe("the fixture itself", () => {
  it("covers both formats under three distinct keys each", () => {
    // A fixture that quietly lost its format-3 half would make three cases above
    // pass on the wrong vector, so the shape of the fixture is asserted too.
    expect(legacyVectorsOfFormat(2)).toHaveLength(3);
    expect(legacyVectorsOfFormat(3)).toHaveLength(3);
    expect(new Set(legacyVectorsOfFormat(2).map((one) => one.legacyKeyHex)).size).toBe(3);
    expect(new Set(legacyVectorsOfFormat(3).map((one) => one.legacyKeyHex)).size).toBe(3);
  });

  it("names the module `envelope.ts` records as each format's origin", () => {
    // JOINS THE FIXTURE TO THE DOMAIN. The vectors' whole authority is that they
    // came from the extraction sources; if a future edit re-derived them from
    // somewhere else, the `origin` would stop matching the descriptor and this
    // case would say so.
    const origins = new Map(
      LEGACY_WIRE_VECTORS.map((one) => [one.formatVersion, one.origin] as const),
    );
    expect(origins.get(2)).toBe("internal-packages/tenancy-database/src/auth.ts");
    expect(origins.get(3)).toBe("apps/agent/src/auth/secrets.service.ts");
  });
});
