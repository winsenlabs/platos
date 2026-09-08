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
//
// WIN-267 A3 COUNTED THE SLOTS AND THE OLD SENTENCE WAS WRONG THREE TIMES OVER,
// which is recorded here rather than quietly corrected because a figure repeated
// without being verified is how this programme has been wrong before. It read
// "its bundle has eight slots ... the other four have NO implementation" and
// then named FIVE of them. `application/dependencies.ts` declares TEN:
// `repository`, `rateLimiter`, `hasher`, `minter`, `totp` and `cipher` — the SIX
// driven ports its own `ports/index.ts` header enumerates — plus FOUR kernel
// ports, `clock`, `ids`, `safety` and `logger`. The old sentence omitted `safety`
// from the kernel list, which is the third error and the one that mattered: the
// kernel `SafetyEventSink` is implemented by `governance`, which this root does
// not compose, so it is not a port "this process already holds" either.
//
// AFTER THIS TRANCHE, FOUR OF THE SIX ARE STILL UNSATISFIED. `repository` is on
// the ORM adapter (WIN-258 tranche 2) and `rateLimiter` is now
// `packages/adapters/redis-ratelimit`, constructed from the same
// `PLATOS_STORE_REDIS_URL` the cache is. `hasher`, `minter`, `totp` and `cipher`
// are named on the context's own ports and satisfied by no adapter directory at
// all — `keyring-envelope`'s `Hasher` is `secrets`' port, a different type in a
// different package, and nothing implements `SecretHasher`, `TokenMinter`,
// `TotpCodeVerifier` or `MfaSecretCipher`. So the context is still composed from
// a SUPPLIED bundle, and this file returns none for it rather than assembling
// six slots out of ten and leaving the rest to crash at first sign-in.
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
/**
 * The reason `providers` is not assembled here, stated once.
 *
 * WIN-267 A3. It is recorded for the first time, and the reason it moved is the
 * reason it is worth recording: `ProviderProbeCache` was satisfied by no adapter
 * in this tree, and now it is — `redis-cache`'s fourth port. So the only thing
 * left between this root and a composed `providers` is condition (1) of the
 * three above, which is a FACTORY and not an adapter.
 *
 * READ BACK BY `installation.test.ts`, like the sentence below it: every claim
 * in it is checked against the binding table and the constructed adapters rather
 * than taken on trust, so this sentence and the tree cannot drift apart.
 *
 * ALSO SAID PLAINLY: this tranche did NOT make `providers` composable, and an
 * agent brief that says otherwise is wrong about this tree. `secrets` publishes
 * no assembler either, and `ProvidersDependencies` names a whole `SecretsPeer`,
 * so composing `providers` needs two contexts to publish factories first. What
 * changed is that the ADAPTER gap closed.
 */
export const PROVIDERS_UNASSEMBLED =
  "it publishes its use cases one by one and no factory that assembles its whole" +
  " contract, so this root has nothing to call; every driven port it names now has" +
  " an implementation — ProvidersRepository and ModelRouter already did, and WIN-267" +
  " A3 gave ProviderProbeCache one on redis-cache — and its secrets peer is a context" +
  " that publishes no assembler either";

export const IDENTITY_ACCESS_UNASSEMBLED =
  "four of its six driven ports have no implementation: SecretHasher," +
  " TokenMinter, TotpCodeVerifier and MfaSecretCipher are satisfied by no adapter" +
  " directory. RateLimiter is packages/adapters/redis-ratelimit, which WIN-267 A3" +
  " turned from a generated interface into a constructed adapter, and the kernel" +
  " SafetyEventSink its bundle also names is implemented by governance, which this" +
  " root does not compose";

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
  unassembled.push(Object.freeze({ context: "providers", reason: PROVIDERS_UNASSEMBLED }));

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
