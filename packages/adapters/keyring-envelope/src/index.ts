// The published surface of the key-management adapter.
//
// `RootKeyRingResolver` and `createRootKeyRing` are exported alongside the
// adapter because the composition root is the one place entitled to name this
// package, and it is the place that reads `PLATOS_CREDENTIAL_ROOT_KEYS` and has
// to refuse to start on a ring that will not parse. Nothing that resolves a
// handle to BYTES is exported: `resolve` is reachable only through the closure
// `createRootKeyRing` returns, and no export here hands key material out.

export type { KeyringEnvelopeAdapter } from "./adapter.js";
export { buildKeyringEnvelope, createKeyringEnvelopeAdapter } from "./adapter.js";

export type { RootKeyRingInput, RootKeyRingResolver } from "./root-key-ring.js";
export { createRootKeyRing } from "./root-key-ring.js";

export { createEnvelopeCipher } from "./envelope-cipher.js";
export { createSecretHasher } from "./secret-hasher.js";
