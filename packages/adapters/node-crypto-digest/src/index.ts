// The published surface of the keyless-digest adapter.
//
// `createSecretHasher` is exported beside the adapter for the same reason
// `keyring-envelope` exports `createEnvelopeCipher`: a suite that wants the port
// and not the `adapterName` tag should not have to reach past a barrel to get
// it. Nothing else leaves this package — there is no state, no handle and no key
// for an export to disclose.

export type { NodeCryptoDigestAdapter } from "./adapter.js";
export { createNodeCryptoDigestAdapter } from "./adapter.js";

export { createSecretHasher } from "./secret-hasher.js";
