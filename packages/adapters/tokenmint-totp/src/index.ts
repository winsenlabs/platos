// The published surface of the randomness adapter.
//
// The two `create*` functions beside the whole-adapter one are exported for the
// same reason `keyring-envelope` exports `createSecretHasher` beside
// `createKeyringEnvelopeAdapter`: a caller that needs exactly one of the two
// ports should be able to hold exactly one of them, and holding the pair is a
// wider grant than it needs.
//
// `MINTED_TOKEN_BYTES` is exported because it is the tranche's PINNED CLAIM
// about production and the only place it is written down, so a reader wanting to
// know what width a `plt_ent_` token carries can import the answer rather than
// re-derive it. Nothing here hands out randomness, a key or a secret.

export type { TokenmintTotpAdapter } from "./adapter.js";
export { createTokenmintTotpAdapter } from "./adapter.js";

export { createTokenMinter, MINTED_TOKEN_BYTES, RECOVERY_CODE_BYTES, TOTP_SECRET_BYTES } from "./token-minter.js";
export { RecoveryCodeCountError } from "./token-minter.js";
export { createTotpCodeVerifier } from "./totp-code-verifier.js";
export { Base32SecretError, decodeBase32, encodeBase32 } from "./base32.js";
