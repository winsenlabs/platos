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
// Its bundle has TEN slots, six of them driven ports. `repository` is on the
// same adapter — WIN-258 tranche 2 put it there — and `logger`, `clock` and
// `ids` are kernel ports this process already holds.
//
// WIN-267 A1 AND A2 CLOSED FOUR OF THE FIVE, and the count in
// `IDENTITY_ACCESS_UNASSEMBLED` moves from four to one because of them.
// `hasher` is now `packages/adapters/node-crypto-digest`; `cipher` is now
// `keyring-envelope.mfaSecrets`, a FOURTH port on the thirteenth directory
// rather than a fifteenth directory, because AES-256 root key bytes have
// exactly one custodian in this tree and rule (j2) forbids a second package
// from reaching them; `minter` and `totp` are both
// `packages/adapters/tokenmint-totp`, the fifteenth directory. All three of
// those directories are built UNCONDITIONALLY: none reads configuration, so
// there is nothing an install could get wrong.
//
// ONE DRIVEN PORT REMAINS, AND SO DOES ONE KERNEL PORT, AND THIS FILE STILL
// RETURNS NONE FOR THE CONTEXT.
//
//   * `rateLimiter` is `packages/adapters/redis-ratelimit`, whose
//     `src/adapter.ts` is STILL a generated interface. The tranche that makes it
//     real was written and is not landed here, because its own author marked it
//     incomplete: the suite that would prove the last token unshareable across
//     concurrent consumers has never been run.
//   * `safety` is the kernel `SafetyEventSink`. `packages/contexts/governance`
//     implements it (`createGovernanceSafetyEventSink`), but `app.module.ts`
//     imports `GovernanceContract` as a TYPE only and composes no governance
//     contract, so no object in this process can fill that slot. A rate limiter
//     alone would therefore NOT be enough: `consume-rate-limit.ts` writes
//     `identity.rate_limit.degraded` into this sink, so a bundle without it
//     would crash on the first refusal rather than on the first sign-in.
//
// A CORRECTION TO THE ARITHMETIC THIS NOTE INHERITED. The bundle does not have
// eight slots and identity-access does not have eight driven ports.
// `IdentityAccessPorts` has TEN slots, of which SIX are driven ports named on
// this context's own `application/ports/index.ts` (`repository`, `rateLimiter`,
// `hasher`, `minter`, `totp`, `cipher`) and FOUR are kernel ports (`clock`,
// `ids`, `logger`, `safety`). The original sentence said "four of its eight
// driven ports" and then named five, and it counted `safety` among the kernel
// ports "this process already holds", which it does not hold. Both errors are
// fixed here and both are now read back by `installation.test.ts` against the
// bundle's own type rather than against this prose.
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
 * `installation.test.ts`: the claim "one of its six driven ports has no
 * implementation" is checked against the adapter directories rather than
 * asserted, so this sentence and the check cannot drift apart silently.
 *
 * WIN-267 A1 and A2 moved it from four to one, and the readback moved with it
 * in BOTH directions: the port still missing must appear on no row of
 * `ADAPTER_BINDINGS` and must be named here, and the four that landed must each
 * appear on a NAMED directory and be present in `construction.adapters`. A
 * sentence edited without the adapters, or adapters landed without the
 * sentence, fails there.
 *
 * The sentence also names `safety`, which is not an adapter question at all:
 * it is a kernel port whose only implementation is in a context this root does
 * not compose. `installation.test.ts` checks that clause too, by asserting no
 * binding row satisfies `SafetyEventSink`.
 */
export const IDENTITY_ACCESS_UNASSEMBLED =
  "one of its six driven ports has no implementation: RateLimiter is" +
  " packages/adapters/redis-ratelimit, a generated interface; and its kernel" +
  " SafetyEventSink slot is implemented only by the governance context, which" +
  " this root does not compose";

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
