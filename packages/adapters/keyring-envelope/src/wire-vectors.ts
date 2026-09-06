// KNOWN-ANSWER VECTORS, PRODUCED BY CODE THIS PACKAGE DOES NOT OWN.
//
// WHY THEY EXIST. `envelope.test.ts` in `secrets` pins the HKDF `info` and the
// AEAD associated-data STRINGS, and `envelope-cipher.ts` imports the functions
// that build them, so a test comparing this adapter's derived strings against the
// domain's would be comparing two things one tranche controls. Change the domain
// constant and both sides move together and the assertion still passes — the
// failure mode T7's projection test shipped and this repository has a rule about.
//
// A CIPHERTEXT CANNOT MOVE WITH THE CODE. Every byte below was produced by
// `internal-packages/tenancy-database/src/secrets.ts`'s `encryptCredentialSecret`
// — the extraction source, which is not this package, is not edited by this
// issue, and is the module every pre-V1 envelope in every live database was
// written by. If this adapter's domain separator, field order, NUL separator,
// HKDF salt handling, key width, nonce width, associated data or cipher mode
// differ from that source's by ONE byte, the tag check fails and the vector does
// not open. The assertion therefore joins to something outside the tranche, and
// it is what makes the wire-compatibility claim falsifiable.
//
// HOW TO RE-DERIVE THEM. From the repository root, after
// `pnpm --filter @platos/tenancy-database build`:
//
//   node --input-type=module -e '
//     import { encryptCredentialSecret } from
//       "./internal-packages/tenancy-database/dist/secrets.js";
//     const hex = (b) => Buffer.from(b).toString("hex");
//     const e = encryptCredentialSecret(
//       Buffer.from(ROOT_KEY_HEX, "hex"), CONTEXT, PLAINTEXT);
//     console.log(JSON.stringify({ salt: hex(e.salt), nonce: hex(e.nonce),
//       ciphertext: hex(e.ciphertext), authTag: hex(e.authTag) }));'
//
// A RE-RUN PRODUCES DIFFERENT BYTES, and that is correct rather than a problem
// with the vectors: `encryptCredentialSecret` draws a fresh 32-byte salt and a
// fresh 12-byte nonce every call. What is fixed is that THESE bytes, under THIS
// key and THIS binding, decrypt to THIS plaintext — which is exactly the property
// a stored envelope has and the only one that matters after a rotation.
//
// THE VECTORS CARRY NO REAL SECRET. The root keys are the repeating-pattern keys
// `.env.example` and `apps/agent/test/setup.ts` already publish, and the
// plaintexts are literals invented for this file.

/** One frozen envelope, its key, and what it must open to. */
export interface WireVector {
  /** What the case is for, in the failure message when it stops opening. */
  readonly name: string;
  /** Hex, 64 characters: the AES-256 root key that sealed it. */
  readonly rootKeyHex: string;
  readonly environmentId: string;
  readonly credentialId: string;
  readonly secretRevision: number;
  readonly formatVersion: number;
  readonly rootKeyVersion: number;
  readonly saltHex: string;
  readonly nonceHex: string;
  readonly ciphertextHex: string;
  readonly authTagHex: string;
  /** The plaintext `encryptCredentialSecret` was given. */
  readonly plaintext: string;
}

export const WIRE_VECTORS: readonly WireVector[] = Object.freeze([
  Object.freeze({
    name: "revision 1 under root key version 1",
    rootKeyHex: "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface",
    environmentId: "env_0000000000000000000000001",
    credentialId: "8a0f6d4e-1b23-4c56-9a7b-0d1e2f3a4b5c",
    secretRevision: 1,
    formatVersion: 1,
    rootKeyVersion: 1,
    saltHex: "4156adb01a5fcea3740baa0ad7f7a71a7d12c3b26d6adc47456bd5a4c7bf354e",
    nonceHex: "48aed6447cc6228ec6ad4e60",
    ciphertextHex: "b9fdb625db0bbb6d8c712d3fe9dca9ab902a42f539907c499e",
    authTagHex: "1e21582d35d0be31c4e680f0ae6a07d8",
    plaintext: "sk-live-win259-vector-one",
  }),
  // The SAME root key as the vector above, at a different revision and a
  // different root key VERSION. Both fields are inside the derived key and the
  // associated data, so this vector fails to open the moment either stops
  // reaching the binding — which is the mutation a rotation would otherwise
  // survive silently.
  Object.freeze({
    name: "revision 7 under root key version 2, same key bytes as version 1",
    rootKeyHex: "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface",
    environmentId: "env_0000000000000000000000002",
    credentialId: "3c9d1e77-2a44-4f10-8b6c-5e7f9a0b1c2d",
    secretRevision: 7,
    formatVersion: 1,
    rootKeyVersion: 2,
    saltHex: "cd80e8354304982a320a74aabc08695cb596ab9c1f58b0cd4b3eaabce3ecedd3",
    nonceHex: "b83d2b0ec82116cecb53f116",
    ciphertextHex: "609d5e9ff8608063ee9c0bdea0a5d460326abf9bf484ec285b275909329e668a79",
    authTagHex: "1975693bf141525ba9f9b60cb9117ad2",
    plaintext: "sk-live-win259-vector-two-rotated",
  }),
  // Multi-byte UTF-8, a newline and a tab. The extraction source encodes with
  // `cipher.update(plaintext, "utf8")` and decodes with `.toString("utf8")`; an
  // adapter that encoded latin1, or that trimmed, would open the two ASCII
  // vectors above and fail here.
  Object.freeze({
    name: "non-ASCII plaintext under a third root key",
    rootKeyHex: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    environmentId: "env_0000000000000000000000003",
    credentialId: "d41d8cd9-8f00-4204-a980-0998ecf8427e",
    secretRevision: 1,
    formatVersion: 1,
    rootKeyVersion: 9,
    saltHex: "b57cd65512eb6f5756bede4ae0ccc56529a5be0878ea10766641092e8c75df11",
    nonceHex: "a4950246ae3a982002128588",
    ciphertextHex: "f571c9e9d97b6369fcbc2d820291d09a8c0d937e8781a896094c37c26d176da7f54177",
    authTagHex: "a7b9ce744105db6a6471380c01f5e8fd",
    plaintext: "éàü unicode + newline\nand a tab\t",
  }),
]);

/** Hex to bytes, for a fixture whose whole point is that it is bytes. */
export function hexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
