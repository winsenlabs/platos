// The `Hasher` — scrypt with a per-digest salt, verified in constant time.
//
// WHAT IT IS FOR. `crypto.ts`: "for the transitional `Credential.secretHash`
// verifier the schema flags. It is a port rather than a domain function for the
// same reason the cipher is, and it is deliberately separate from the cipher so a
// hash can never be mistaken for a reversible envelope."
//
// WHY IT IS IN THIS DIRECTORY AND NOT THE STORE'S. The digest it produces sits in
// a column the ORM writes, so `postgres-tenancy` was the obvious home and is the
// wrong one: the whole point of `secretHash` is that a store holding it cannot
// recover the secret, and a store that also OWNS the hashing parameters can lower
// them. Custody of the cost parameter belongs with custody of the key.
//
// WHY scrypt AND NOT SHA-256. The input is a credential secret — an API key, a
// token, a password-equivalent — and the digest lands in a row an operator can
// read. A bare digest of a low-entropy secret is a dictionary away from the
// plaintext. scrypt is memory-hard and its cost is pinned below, so an offline
// attempt costs the attacker what it costs the verifier.
//
// WHY `verify` DOES NOT RE-DERIVE AND COMPARE STRINGS. `timingSafeEqual` over the
// raw digest bytes is the only comparison here. `===` on hex strings leaks the
// length of the shared prefix through the compare loop, and the port's own
// comment is explicit: "Constant-time in the adapter. The domain must not compare
// digests itself."

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

import type { Hasher, Result, SecretMaterial } from "@platos/context-secrets/application/ports/index.js";
import { err, invalidKeyRing, ok } from "@platos/context-secrets/application/ports/index.js";

/**
 * The serialised digest's shape: `scrypt$<N>$<r>$<p>$<saltHex>$<digestHex>`.
 *
 * The COST IS IN THE STRING rather than only in this file, so a digest written
 * under today's parameters still verifies after they are raised. A verifier that
 * assumed the current constants would fail every older row the moment the cost
 * moved, and the failure would look exactly like a wrong secret.
 */
const SCHEME = "scrypt";

/** CPU/memory cost. 2^15 — the same order the Node documentation's example uses. */
const COST = 32768;
const BLOCK_SIZE = 8;
const PARALLELISATION = 1;
const SALT_BYTES = 16;
const DIGEST_BYTES = 32;

/**
 * `scrypt` needs `maxmem` above the default 32 MiB at this cost:
 * 128 * N * r = 128 * 32768 * 8 = 32 MiB exactly, and the check is `>`.
 */
const MAX_MEMORY = 64 * 1024 * 1024;

function derive(value: string, salt: Uint8Array, cost: number, blockSize: number, parallelisation: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(value, "utf8"),
      Buffer.from(salt),
      DIGEST_BYTES,
      { N: cost, r: blockSize, p: parallelisation, maxmem: MAX_MEMORY },
      (error, derived) => (error ? reject(error) : resolve(new Uint8Array(derived))),
    );
  });
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function fromHex(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

interface ParsedDigest {
  readonly cost: number;
  readonly blockSize: number;
  readonly parallelisation: number;
  readonly salt: Uint8Array;
  readonly digest: Uint8Array;
}

function parseDigest(encoded: string): ParsedDigest | null {
  const parts = encoded.split("$");
  if (parts.length !== 6) return null;
  const [scheme, cost, blockSize, parallelisation, salt, digest] = parts as [string, string, string, string, string, string];
  if (scheme !== SCHEME) return null;
  const numbers = [cost, blockSize, parallelisation].map((part) =>
    /^[1-9][0-9]*$/u.test(part) ? Number(part) : Number.NaN,
  );
  if (numbers.some((value) => !Number.isSafeInteger(value))) return null;
  const saltBytes = fromHex(salt);
  const digestBytes = fromHex(digest);
  if (saltBytes === null || digestBytes === null) return null;
  // A digest of the wrong width would make `timingSafeEqual` THROW rather than
  // answer false, and a thrown exception out of `verify` is a 500 where a `false`
  // belongs. It is refused by length before it reaches the comparison.
  if (digestBytes.length !== DIGEST_BYTES) return null;
  return {
    cost: numbers[0] as number,
    blockSize: numbers[1] as number,
    parallelisation: numbers[2] as number,
    salt: saltBytes,
    digest: digestBytes,
  };
}

export function createSecretHasher(): Hasher {
  return {
    async hash(value: SecretMaterial): Promise<Result<string>> {
      const salt = new Uint8Array(randomBytes(SALT_BYTES));
      const digest = await derive(value.reveal(), salt, COST, BLOCK_SIZE, PARALLELISATION);
      return ok(`${SCHEME}$${COST}$${BLOCK_SIZE}$${PARALLELISATION}$${toHex(salt)}$${toHex(digest)}`);
    },

    async verify(value: SecretMaterial, digest: string): Promise<Result<boolean>> {
      const parsed = parseDigest(digest);
      // A digest this adapter cannot parse is NOT `false`. `false` says "the
      // secret is wrong", and a caller that acts on it rotates a credential that
      // was never wrong. An unparseable digest says the stored row is not one of
      // ours, which is an operator's problem and refused as one.
      if (parsed === null) return err(invalidKeyRing("secret_digest_unparseable"));
      const candidate = await derive(
        value.reveal(),
        parsed.salt,
        parsed.cost,
        parsed.blockSize,
        parsed.parallelisation,
      );
      return ok(timingSafeEqual(Buffer.from(candidate), Buffer.from(parsed.digest)));
    },
  };
}
