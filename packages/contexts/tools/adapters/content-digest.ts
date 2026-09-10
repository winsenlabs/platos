// `ContentDigest` over `node:crypto`. Lowercase hex SHA-256, and nothing else.
//
// WHY IT IS HERE AND NOT IN `packages/adapters/`. ADR M0.3 §5.1 rule (h)
// (`SDK_CONTAINMENT.mcp-sdk-only-in-tools`) homes `@modelcontextprotocol/*` in
// `packages/contexts/tools/(adapters|transport)/`, so `ToolDispatch` — the other
// port this directory implements — cannot be a `packages/adapters/` directory.
// The digest follows it because the composition root imports ONE barrel from
// this context, not because the digest needs containment: it holds no SDK, no
// key and no handle. `apps/core-api/src/composition/adapter-bindings.ts` already
// states the reason a digest gets no binding row of its own — it is "a
// synchronous host hash with no failure channel and no row".
//
// WHY IT IS NOT `packages/adapters/node-crypto-digest`, WHICH COMPUTES THE SAME
// BYTES. That directory implements `identity-access`'s `SecretHasher` and is the
// closest thing in this tree to a home for a keyless digest. It cannot be
// reached from here: `adapters-only-from-core` permits `packages/adapters/*` to
// be imported by `apps/core-api` and by an adapter's own modules and by nothing
// else, so a context directory naming it fails the boundary check. The
// composition root COULD hand the same object to both ports — the signatures
// differ (`hash(secret): TokenHash` returns a branded identifier;
// `sha256Hex(input): string` returns a bare string), so it would be two methods
// on one object rather than one — and that is a decision about a package
// manifest, not about arithmetic. The bytes are identical either way, which is
// what `content-digest.test.ts` pins against FIPS 180-4 rather than against the
// other implementation.
//
// -----------------------------------------------------------------------------
// THE DIGEST IS PERSISTED, SO MOVING IT IS A MIGRATION AND NOT A REFACTOR.
//
// `Tool.schemaHash` is the truncated digest of the canonical tool document and
// is what makes a re-registration idempotent: `register-tools.ts` compares the
// hash it computes to the hash on the row and rewrites nothing when they agree.
// An implementation that chose uppercase hex, base64, a salt or SHA-512 would
// fail no test in this package — the port's own header says SHA-256/HEX/LOWERCASE
// for exactly that reason — and would instead remint every tool row in every
// installation on the next sync.
//
// The MCP session pool key is the second consumer and it fails differently: the
// key is the digest of the canonical resolved header set, so two credentials
// that hashed to one key would SHARE a session, which is a cross-tenant leak
// rather than a churn. `domain/mcp-client.ts` computes the canonical form; this
// only hashes it.
// -----------------------------------------------------------------------------

import { createHash } from "node:crypto";

import type { ContentDigest } from "../application/ports/index.js";

/**
 * The one algorithm this boundary computes, named once.
 *
 * A constant rather than a literal at the call site for the reason
 * `node-crypto-digest` gives for its own: the algorithm and the encoding are one
 * decision with two halves, and two independent literals can be edited apart.
 */
const DIGEST = "sha256";

/** Node's `hex` is lower-case and always has been; the port fixes lower-case. */
const ENCODING = "hex";

/**
 * Build the digest.
 *
 * NO ARGUMENTS AND NO `Result`, and both absences are claims. There is no
 * configuration a SHA-256 could refuse and no failure an operator could fix, so
 * a failure channel here would be a branch no input could reach — the
 * unfalsifiable shape this repository has a rule about.
 */
export function createContentDigest(): ContentDigest {
  return {
    sha256Hex(input: string): string {
      // `update(input, "utf8")` NAMES the encoding even though Node defaults to
      // it. The port says "the UTF-8 bytes of `input`", and a reader checking
      // that claim should not have to know the default to confirm it — the same
      // reason `hashSecret` in the extraction source names it.
      return createHash(DIGEST).update(input, "utf8").digest(ENCODING);
    },
  };
}
