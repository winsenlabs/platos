// LEGACY KNOWN-ANSWER VECTORS, PRODUCED BY THE TWO MODULES THIS PACKAGE IS
// MIGRATING AWAY FROM.
//
// WHY THEY EXIST, AND IT IS THE SAME REASON `wire-vectors.ts` EXISTS. A suite
// that sealed a legacy envelope with this package's own code and then opened it
// with this package's own code would be comparing two things one tranche
// controls: reverse the iv and the tag, or read 12 bytes where the source writes
// 16, and BOTH halves move together and the assertion still passes. That is the
// failure mode this repository has already paid for once.
//
// A CIPHERTEXT CANNOT MOVE WITH THE CODE. Every payload below was produced by
// the module named on it — `internal-packages/tenancy-database/src/auth.ts` for
// format 2, `apps/agent/src/auth/secrets.service.ts` for format 3 — which are the
// `legacyOrigin` values `secrets/domain/envelope.ts` records for those two
// formats, are not edited by this issue, and are the modules that wrote every
// legacy secret in every live database. If this reader's field order, iv width,
// tag width, base64 alphabet or cipher mode differs from a source's by ONE byte,
// the tag check fails and the vector does not open.
//
// THE TWO FORMATS DIFFER IN EXACTLY ONE PLACE AND IT IS EASY TO MISS. Both pack
// iv, then tag, then ciphertext. Format 2 dots them as three base64url fields
// with a 12-byte iv; format 3 concatenates them into ONE base64 string with a
// 16-byte iv. A reader that used one iv width for both would open one format's
// vectors and fail the other's — which is why there are vectors for both, under
// three different keys each, rather than one of each.
//
// HOW TO RE-DERIVE THEM. From the repository root:
//
//   format 2, after `pnpm --filter @platos/tenancy-database build`:
//     node --input-type=module -e '
//       import { encryptSecret } from
//         "./internal-packages/tenancy-database/dist/auth.js";
//       console.log(encryptSecret(PLAINTEXT, LEGACY_KEY_HEX));'
//
//   format 3, which reads its key from the environment and validates the whole
//   agent environment on construction, so the other five variables must be set
//   and `PLATOS_CREDENTIAL_ROOT_KEYS` must DIFFER from `PLATOS_ENCRYPTION_KEY`:
//     PLATOS_ENCRYPTION_KEY=<hex> ... tsx -e '
//       const { SecretsService } = require("./apps/agent/src/auth/secrets.service");
//       console.log(new SecretsService().encrypt(PLAINTEXT));'
//
// A RE-RUN PRODUCES DIFFERENT BYTES, and that is correct rather than a problem:
// both sources draw a fresh iv on every call. What is fixed is that THESE bytes,
// under THIS key, decrypt to THIS plaintext — which is exactly the property a
// stored legacy column has, and the only one a migration depends on.
//
// THE VECTORS CARRY NO REAL SECRET. The keys are the repeating-pattern values
// `.env.example` already publishes, and the plaintexts are literals invented for
// this file.

/** One frozen legacy envelope, its key, and what it must open to. */
export interface LegacyWireVector {
  /** What the case is for, in the failure message when it stops opening. */
  readonly name: string;
  /** 2 or 3. The discriminator, never inferred from the payload's shape. */
  readonly formatVersion: 2 | 3;
  /** The module that produced this payload — `envelope.ts`'s `legacyOrigin`. */
  readonly origin: string;
  /** Hex, 64 characters: the raw AES-256 key that sealed it. */
  readonly legacyKeyHex: string;
  /** The column's value, verbatim. */
  readonly payload: string;
  /** What the source was given. */
  readonly plaintext: string;
}

const AUTH_ORIGIN = "internal-packages/tenancy-database/src/auth.ts";
const AGENT_ORIGIN = "apps/agent/src/auth/secrets.service.ts";

export const LEGACY_WIRE_VECTORS: readonly LegacyWireVector[] = Object.freeze([
  // ---- format 2: dotted base64url, 12-byte iv --------------------------------
  Object.freeze({
    name: "format 2, a TOTP secret as `beginTotpEnrollment` stores one",
    formatVersion: 2 as const,
    origin: AUTH_ORIGIN,
    legacyKeyHex: "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface",
    payload: "x0JM-S8luiMZ3CqM.0vMkPpQef8pEUOc3RYJuSw.pAbE_Brm0bG2fxXynmv32w",
    plaintext: "JBSWY3DPEHPK3PXP",
  }),
  // A LONGER PLAINTEXT UNDER A DIFFERENT KEY. The first vector's ciphertext is 16
  // bytes, which is exactly one AES block; a reader with an off-by-one in the
  // field split could still open it by accident. This one cannot be opened by an
  // accident of alignment.
  Object.freeze({
    name: "format 2, a longer payload under a second key",
    formatVersion: 2 as const,
    origin: AUTH_ORIGIN,
    legacyKeyHex: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    payload:
      "KKt_VZ-jg7JVK7aK.kqovcK5ArcwolzHU0KkzzQ.lVTvQwLAu3J7TeOsC-APXJ30OWODCXYWagtnPPFy6zi1cdHTKK0TLJU",
    plaintext: "plt_ml_win259-format-two-migration-vector",
  }),
  // MULTI-BYTE UTF-8, A NEWLINE AND A TAB. `encryptSecret` encodes with
  // `cipher.update(secret, "utf8")` and `decryptSecret` decodes with
  // `.toString("utf8")`. A reader that decoded latin1, or trimmed, would open the
  // two ASCII vectors above and fail here.
  Object.freeze({
    name: "format 2, non-ASCII plaintext under a third key",
    formatVersion: 2 as const,
    origin: AUTH_ORIGIN,
    legacyKeyHex: "cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe",
    payload: "6fakOhRY7B1ADOO2.xyTMZOEq-wjuL8RsEiS_WA.lMoGxyg-YdMmwt_7Z22gLivxSyzw-V8RvtP5ypx0PcHdb7E",
    plaintext: "éàü unicode + newline\nand a tab\t",
  }),

  // ---- format 3: one packed base64 string, 16-byte iv ------------------------
  Object.freeze({
    name: "format 3, an API key as `SecretsService.encrypt` stores one",
    formatVersion: 3 as const,
    origin: AGENT_ORIGIN,
    legacyKeyHex: "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface",
    payload: "We/wHf7H2z4cV9ZceG0O167bbEgOQmtKUKl4TmqZxN+KIA5YUxAlSE3PXnx6Cr17cd4ZhZwKSmGnCuXR8I+yYejQ",
    plaintext: "sk-live-win259-format-three-vector",
  }),
  // A JSON FRAGMENT, BECAUSE THAT IS WHAT THE SOURCE'S `encryptFile` PATH STORES.
  // It also contains `/` and `+`, so a reader that used the base64URL alphabet
  // here — the alphabet format 2 uses — would decode it to different bytes and
  // fail the tag check.
  Object.freeze({
    name: "format 3, a service-account JSON fragment under a second key",
    formatVersion: 3 as const,
    origin: AGENT_ORIGIN,
    legacyKeyHex: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    payload:
      "4iMKluqua7CyeyAchSdM3iIziePzDNohEs/3EeJhSaDgJ8koz/DS6X8uCxpXPKzsiupW6mmu0HQpoR9RKBqFYKwlee6bJy2UJ7CMvoRI9kI=",
    plaintext: '{"type":"service_account","project_id":"win259"}',
  }),
  Object.freeze({
    name: "format 3, non-ASCII plaintext under a third key",
    formatVersion: 3 as const,
    origin: AGENT_ORIGIN,
    legacyKeyHex: "cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe",
    payload: "bNoPLjz1v2s3ynjkw5sGuOoLJCrX7Mst15hMcqlf0KYZh50HZSLLif0YMNoOs/se4BdjspB2x71aRB+wwI7HIo/WaA==",
    plaintext: "éàü unicode + newline\nand a tab\t",
  }),
]);

/** The vectors for one format. Both suites and the migration proof slice by this. */
export function legacyVectorsOfFormat(formatVersion: 2 | 3): readonly LegacyWireVector[] {
  return LEGACY_WIRE_VECTORS.filter((vector) => vector.formatVersion === formatVersion);
}

/** A reader input holding exactly the key one vector needs, and no other. */
export function legacyKeysFor(vector: LegacyWireVector): { keys: Record<string, string> } {
  return { keys: { [String(vector.formatVersion)]: vector.legacyKeyHex } };
}
