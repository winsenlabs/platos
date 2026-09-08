// WIN-267 T4 — THE FOUR REFUSALS A ONE-TIME-SECRET MINT OWNS.
//
// `transport-errors.ts` states the rule these follow: "the request envelope's
// own failures belong to the edge that owns the envelope. No context mints one
// of these, because no context knows a header exists." These four are the same
// shape one layer in — failures of the COMPOSITION and of the ROUTE's own
// preconditions, which no bounded context can have an opinion about because no
// bounded context knows which of its peers an install composed.
//
//   MINT_CONTEXT_UNCOMPOSED   the context this mint needs is not composed here.
//   MINT_PRINCIPAL_NOT_OPERATOR  the credential authenticated, and it is not an
//                             operator's. `identity-access` answered the
//                             question it was asked; the TIER requirement is
//                             this operation's, not that context's.
//   MINT_SCOPE_NOT_ENVIRONMENT  the credential is genuine and addressed above an
//                             environment. A vault is keyed by environment, so
//                             an organization-scoped bearer names no vault.
//   MINT_CREDENTIAL_UNKNOWN   there is no credential to rotate under this name.
//
// FOUR CODES AND NOT ONE, WHICH IS THE FIFTH LESSON THIS PROGRAMME PAID FOR:
// "two guards returning the same error code cannot be told apart — mint distinct
// codes". Collapsing these into one `MINT_UNAVAILABLE` would leave an operator
// unable to tell a half-composed install from a caller holding the wrong token
// from a channel that was never vaulted, and those have three different
// responses: wire an adapter, fix the caller, create the credential.
//
// NOT ONE OF THEM ECHOES ATTACKER-CONTROLLED TEXT, for the reason
// `transport-errors.ts` gives at length. The CONTEXT NAME is a closed set this
// module writes; the TIER and the SCOPE KIND are closed unions
// `identity-access` publishes; the channel connection id is NOT echoed, even
// though `MINT_CREDENTIAL_UNKNOWN` is about one.

import { domainError, type DomainError } from "@platos/kernel";

/**
 * A context this mint needs is not composed in this install.
 *
 * `unavailable` AND NOT `internal`. It is not a defect: `app.module.ts` composes
 * a context only when the ports it needs are reachable, and an install part-way
 * through wiring is a state the composition root is DESIGNED to reach and
 * `/readyz` already reports. A caller's correct response is to wait for the
 * install to finish, which is what `unavailable` tells it and `internal` would
 * not.
 *
 * `retryAfterSeconds` is deliberately ABSENT even though the kernel permits one
 * for this category. A missing adapter is not fixed by waiting a fixed number of
 * seconds — it is fixed by an operator — and a number here would tell a client
 * to retry on a schedule that cannot help.
 */
export function mintContextUncomposed(context: string): DomainError {
  return domainError(
    "MINT_CONTEXT_UNCOMPOSED",
    "unavailable",
    "This operation is not available in this installation.",
    {
      fields: [
        {
          field: "installation",
          code: "context_uncomposed",
          message: `The ${context} context is not composed in this installation.`,
        },
      ],
    },
  );
}

/**
 * The credential authenticated and is not an operator's.
 *
 * `forbidden` rather than `unauthenticated`: the caller proved who it is, and
 * the answer is that this identity may not perform this operation. Answering 401
 * would tell a correctly-authenticated end user to present a credential it
 * already presented.
 */
export function mintPrincipalNotOperator(tier: string): DomainError {
  return domainError(
    "MINT_PRINCIPAL_NOT_OPERATOR",
    "forbidden",
    "Only an operator credential may mint a secret.",
    {
      fields: [
        {
          field: "authorization",
          code: "tier_not_operator",
          message: `This credential authenticates a ${tier} principal.`,
        },
      ],
    },
  );
}

/**
 * The credential is genuine and is not addressed at one environment.
 *
 * A vault is keyed by environment — `secrets`' own grant carries the whole
 * ancestry — so an organization- or project-scoped bearer names no single vault
 * and this operation has nothing to rotate. It is `forbidden` rather than
 * `invalid_input` because nothing about the REQUEST is malformed: the caller
 * sent a well-formed request with a credential that does not reach this far
 * down the tree.
 */
export function mintScopeNotEnvironment(kind: string): DomainError {
  return domainError(
    "MINT_SCOPE_NOT_ENVIRONMENT",
    "forbidden",
    "This operation is addressed at one environment and the credential is not.",
    {
      fields: [
        {
          field: "authorization",
          code: "scope_not_environment",
          message: `This credential is scoped at ${kind}.`,
        },
      ],
    },
  );
}

/**
 * Nothing is vaulted under the name this channel's webhook secret would use.
 *
 * `not_found`, and the channel connection id is NOT echoed back. The id came
 * from the path and is attacker-controlled; `message` reaches the log line and
 * the wire, and a 404 that quoted its own path parameter is the log-forging
 * primitive `transport-errors.ts` refuses to build.
 */
export function mintCredentialUnknown(_channelConnectionId: string): DomainError {
  return domainError(
    "MINT_CREDENTIAL_UNKNOWN",
    "not_found",
    "No credential is vaulted for this channel connection's webhook secret.",
    {
      fields: [
        {
          field: "id",
          code: "credential_unknown",
          message: "This channel connection has no webhook credential to rotate.",
        },
      ],
    },
  );
}
