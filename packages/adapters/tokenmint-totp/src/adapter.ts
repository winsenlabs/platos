// The fourteenth adapter directory: `identity-access`'s TWO randomness ports,
// behind one custodian of one alphabet.
//
// WHY TWO PORTS AND ONE DIRECTORY, UNDER ADR M0.3 §15.
//
// §15's amendment is about a VENDOR CLIENT: one client, one directory, however
// many ports sit behind it. There is no vendor client here at all — both ports
// are `node:crypto` — so §15 neither permits nor forbids this pairing on its own
// terms, and `keyring-envelope` is the precedent for the case it does not reach.
// The argument that does apply is the one that file makes: two ports belong in
// one directory when SPLITTING them would break something that must hold.
//
// What must hold here is that the base32 the minter WRITES is the base32 the
// verifier READS. `TokenMinter.mintTotpSecret` emits the shared secret and
// `TotpCodeVerifier.generate` decodes it, and if the two ever disagree by one
// character of alphabet the failure appears as "the code from my phone is
// rejected" on every enrolment — a support ticket, not a stack trace. Put them in
// two directories and the encoder and the decoder are two packages that can be
// versioned apart; put them here and `base32.ts` is one module both import, which
// is the whole of the guarantee.
//
// WHY THE OTHER TWO IDENTITY-ACCESS PORTS ARE NOT HERE. `SecretHasher` and
// `MfaSecretCipher` are the same tranche's siblings and they are deliberately
// somebody else's directory: a hasher is one-way and a cipher is reversible, and
// `keyring-envelope`'s header already records why custody of a reversible
// envelope does not belong beside anything that merely produces randomness.
// Nothing in this directory can decrypt or verify anything.
//
// WHY IT IS SPREAD FLAT RATHER THAN CARRIED ON PROPERTIES. `mint`,
// `mintTotpSecret`, `mintRecoveryCodes`, `verify` and `generate` are five names
// with no collision, so one interface extends both ports and the composition
// root proves each binding against the adapter object itself.

import type {
  TokenMinter,
  TotpCodeVerifier,
} from "@platos/context-identity-access/application/ports/index.js";

import { createTokenMinter } from "./token-minter.js";
import { createTotpCodeVerifier } from "./totp-code-verifier.js";

export interface TokenmintTotpAdapter extends TokenMinter, TotpCodeVerifier {
  readonly adapterName: "tokenmint-totp";
}

/**
 * Build the adapter.
 *
 * IT TAKES NO CONFIGURATION AND CANNOT FAIL, and both halves of that are worth
 * stating because every other constructed adapter in this tree does the
 * opposite. `postgres-tenancy` needs a URL, `keyring-envelope` needs key material
 * and answers a `Result` because a ring can be unparseable. This one holds no
 * connection, no key and no setting: its entire dependency is the process's
 * CSPRNG. So a composition root wires it unconditionally, it appears in no
 * configuration group, and there is no state in which an install has it declined.
 */
export function createTokenmintTotpAdapter(): TokenmintTotpAdapter {
  const minter = createTokenMinter();
  const totp = createTotpCodeVerifier();
  return {
    adapterName: "tokenmint-totp",
    mint: minter.mint,
    mintTotpSecret: minter.mintTotpSecret,
    mintRecoveryCodes: minter.mintRecoveryCodes,
    verify: totp.verify,
    generate: totp.generate,
  };
}
