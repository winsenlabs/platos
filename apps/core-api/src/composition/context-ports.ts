// Turning constructed ADAPTERS into the port BUNDLES a context is built from.
//
// WHY IT IS NOT IN `adapter-bindings.ts`. That file is the one place entitled to
// NAME an adapter package (`scripts/arch/composition-root.mjs` rule (C1)), and
// this file names none: it reads `SuppliedAdapters`, which is a type that file
// publishes, and hands the properties on it to a context's own dependency shape.
// The split is the difference between "which vendor implements this port" and
// "which slot on which context does that object go in", and only the first of
// those is a rule about adapter packages.
//
// WHY IT IS NOT IN `app.module.ts` EITHER. The composition root's job is to
// decide what a context is built FROM and then build it; this is the arithmetic
// of getting the bundle right, and it has an answer that can be wrong in a way
// the type system cannot see — `sessionRevoker` and `operators` are both edges
// into `identity-access` and both come off the same adapter, so a bundle
// assembled from key order rather than from names would type-check with two
// ports transposed. Naming the slots explicitly here, once, is what makes that
// impossible; `postgres-tenancy`'s own header says the property names "are those
// names exactly, so the bundle a root builds is this adapter's own keys".
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE CANNOT ASSEMBLE, AND WHY — THE MEASURED T3 FINDING
//
// Seventeen contexts are declared. `app.module.ts` can compose a context only
// when THREE things are true at once, and the count falls away fast:
//
//   1. the context publishes a factory that assembles its whole contract.
//      ELEVEN do (`createTenancyService`, `createIdentityAccessService`, and the
//      nine `create*Contract` functions); SIX do not — `agents`, `tools`,
//      `secrets`, `memory`, `cost-monitoring` and `providers` publish their use
//      cases one by one and no assembler over them.
//
//   2. every driven port in its dependency bundle has an implementation SOMEWHERE
//      in this tree.
//
//   3. that implementation is reachable from a constructed adapter.
//
// EXACTLY ONE context clears all three today, and it is `tenancy`: all six of
// its driven ports plus its `UnitOfWork` are properties of a single
// `PostgresTenancyAdapter` (WIN-258 tranches 1 and 3), so a database URL is the
// whole of what it needs.
//
// `identity-access` is the near miss, and naming why is the point of this note.
// Its bundle has eight slots. `repository` is on the same adapter — WIN-258
// tranche 2 put it there — and `logger`, `clock` and `ids` are kernel ports this
// process already holds. The other four have NO implementation in this
// repository: `rateLimiter` is `packages/adapters/redis-ratelimit`, whose
// `src/adapter.ts` is still a generated interface; `hasher`, `minter`, `totp` and
// `cipher` are named on the context's own ports and satisfied by no adapter
// directory at all — `keyring-envelope`'s `Hasher` is `secrets`' port, a
// different type in a different package, and nothing implements
// `SecretHasher`, `TokenMinter`, `TotpCodeVerifier` or `MfaSecretCipher`. So the
// context is still composed from a SUPPLIED bundle, exactly as it was, and this
// file returns none for it rather than assembling seven slots out of eight and
// leaving the eighth to crash at first sign-in.
//
// THAT IS WHY `APPLICATION_ENTRY_PROJECTS` GAINS NO ENTRY IN THIS TRANCHE. The
// generator's own rule for that list is "the contexts `apps/core-api` ACTUALLY
// composes", and an entry without a matching import is the dead surface WIN-297
// declined to create. No context becomes composable here that was not composable
// before; what changed is that one of the two is now composed over REAL
// PostgreSQL instead of over a bundle an install had to hand in.
// ---------------------------------------------------------------------------

import type { Clock, IdGenerator, Logger } from "@platos/kernel";

import type { SuppliedContextPorts } from "../app.module.js";
import type { SuppliedAdapters } from "./adapter-bindings.js";

/** The kernel ports every context bundle carries, held once for the process. */
export interface ContextPortDependencies {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

/** One context this root knows how to build and could not, and the reason. */
export interface UnassembledContext {
  readonly context: string;
  readonly reason: string;
}

export interface ContextPortAssembly {
  readonly ports: SuppliedContextPorts;
  readonly unassembled: readonly UnassembledContext[];
}

/**
 * The reason `identity-access` is not assembled here, stated once.
 *
 * A constant rather than an inline string because it is READ BACK by
 * `installation.test.ts`: the claim "four of its eight slots have no
 * implementation" is checked against the adapter directories rather than
 * asserted, so this sentence and the check cannot drift apart silently.
 */
export const IDENTITY_ACCESS_UNASSEMBLED =
  "four of its eight driven ports have no implementation: RateLimiter is" +
  " packages/adapters/redis-ratelimit, a generated interface, and SecretHasher," +
  " TokenMinter, TotpCodeVerifier and MfaSecretCipher are satisfied by no adapter" +
  " directory";

/**
 * Assemble every context bundle the constructed adapters can satisfy.
 *
 * A slot is filled from a NAMED property of the adapter that carries it, never
 * from a spread and never positionally. `postgres-tenancy` publishes tenancy's
 * five non-repository ports under `TenancyDependencies`' own slot names for
 * exactly this reason, and the repository itself is the adapter — the interface
 * extends `TenancyRepository`, which is what `PORT_SATISFACTION` proves.
 */
export function assembleContextPorts(
  adapters: SuppliedAdapters,
  dependencies: ContextPortDependencies,
): ContextPortAssembly {
  const unassembled: UnassembledContext[] = [];
  const postgres = adapters["postgres-tenancy"];

  if (postgres === undefined) {
    unassembled.push(
      Object.freeze({
        context: "tenancy",
        reason: "its repository, locks, session revoker, revocation counter, invitation token issuer and operator directory are all postgres-tenancy, which is not constructed",
      }),
    );
  }
  unassembled.push(
    Object.freeze({ context: "identity-access", reason: IDENTITY_ACCESS_UNASSEMBLED }),
  );

  return Object.freeze({
    ports: Object.freeze(
      postgres === undefined
        ? {}
        : {
            tenancy: {
              repository: postgres,
              locks: postgres.locks,
              sessionRevoker: postgres.sessionRevoker,
              accessKeyRevocation: postgres.accessKeyRevocation,
              invitationTokens: postgres.invitationTokens,
              operators: postgres.operators,
              unitOfWork: postgres.unitOfWork,
              clock: dependencies.clock,
              ids: dependencies.ids,
              logger: dependencies.logger,
            },
          },
    ),
    unassembled: Object.freeze([...unassembled]),
  });
}
