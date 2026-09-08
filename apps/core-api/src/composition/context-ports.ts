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
// WHAT THIS FILE CANNOT ASSEMBLE, AND WHY — THE MEASURED T3 FINDING,
// CORRECTED BY T4 IN THE ONE CLAUSE THAT WAS FALSE.
//
// Seventeen contexts are declared. `app.module.ts` can compose a context only
// when THREE things are true at once, and the count falls away fast:
//
//   1. the context publishes a factory that assembles its whole contract.
//
//      T3 WROTE "ELEVEN do ... SIX do not — `agents`, `tools`, `secrets`,
//      `memory`, `cost-monitoring` and `providers` publish their use cases one
//      by one and no assembler over them." THAT SENTENCE IS FALSE, and T4
//      measured it rather than inheriting it: ALL SEVENTEEN publish a factory.
//      The six named above spell theirs `agentsContract`, `toolsContract`,
//      `secretsContract`, `memoryContract`, `costMonitoringContract` and
//      `providersContract` — the same assembler under a name that does not
//      begin with `create`, which is what a grep for `create*Contract` misses.
//      `CONTEXT_FACTORIES` below is that measurement, and
//      `installation.test.ts` JOINS it to the context packages' own source, so
//      a claim about who publishes a factory can never again be a sentence in a
//      comment that nothing checks.
//
//   2. every driven port in its dependency bundle has an implementation SOMEWHERE
//      in this tree.
//
//   3. that implementation is reachable from a constructed adapter.
//
// TWO contexts clear all three today. `tenancy`: all six of its driven ports
// plus its `UnitOfWork` are properties of a single `PostgresTenancyAdapter`
// (WIN-258 tranches 1 and 3), so a database URL is the whole of what it needs.
// And — WIN-267 T4 — `secrets`: its eight slots are `postgres-tenancy`'s
// `secrets` and `secretsVariables` properties plus its `unitOfWork`,
// `keyring-envelope` under all three of its ports, and the two kernel ports this
// process already holds. Nothing was written to make that true; the bindings
// were declared in WIN-258 T5, the constructor was written in T3, and the only
// thing missing was this file asking for them.
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
// `APPLICATION_ENTRY_PROJECTS` GAINS NO ENTRY IN THIS TRANCHE EITHER, and for a
// different reason than T3's. `packages/contexts/secrets` is ALREADY on that
// list — WIN-258 T5 put it there because `postgres-tenancy` imports the
// in-memory store from it for the conformance differential — and this file needs
// exactly one type from that entry, `SecretsDependencies`, which is the bundle
// shape it assembles. The factory itself, `secretsContract`, is published from
// the package's `.` entry alongside every other context's contract, so composing
// it widens no surface at all.
// ---------------------------------------------------------------------------

import type { Clock, IdGenerator, Logger } from "@platos/kernel";
import type { SecretsDependencies } from "@platos/context-secrets/application/index.js";

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
 * The factory each context publishes, by context name.
 *
 * WIN-267 T4. It exists because a SENTENCE said six contexts published none, and
 * the sentence was wrong — see the correction in the banner. A list of names is
 * no better than a sentence on its own, so `installation.test.ts` reads each
 * context package's `contracts/index.ts` and its `application/` directory and
 * checks that the function named here is the one that package EXPORTS. The join
 * runs both ways: a context missing from this map whose package exports a
 * factory fails, and a name here that no package exports fails.
 *
 * NOTHING IN THIS MODULE CALLS IT. It is a measurement, not a dispatch table:
 * `app.module.ts` imports the three factories it composes by name, because a
 * composition root that resolved its factories out of a string map would be the
 * discovery-by-metadata wiring `http.module.ts` refuses.
 */
export const CONTEXT_FACTORIES: Readonly<Record<string, string>> = Object.freeze({
  agents: "agentsContract",
  channels: "createChannelsContract",
  conversations: "createConversationsContract",
  "cost-monitoring": "costMonitoringContract",
  eventing: "createEventingContract",
  files: "createFilesContract",
  governance: "createGovernanceContract",
  "identity-access": "createIdentityAccessService",
  jobs: "createJobsContract",
  memory: "memoryContract",
  observability: "createObservabilityContract",
  privacy: "createPrivacyContract",
  providers: "providersContract",
  secrets: "secretsContract",
  skills: "createSkillsContract",
  tenancy: "createTenancyService",
  tools: "toolsContract",
});

/**
 * The one port that keeps `providers` out of the composition root, stated once.
 *
 * WIN-267 T4 measured this rather than assuming it, and the measurement is the
 * reason this tranche serves the provider-key mint through no core-api handler.
 * NINE of `ProvidersDependencies`' ten slots are reachable: `ProvidersRepository`
 * and `UnitOfWork` are `postgres-tenancy`, `ModelRouter` is
 * `model-router-providers`, `secrets` is the context this tranche composes,
 * `tenancy` was already composed, and `clock`, `ids`, `policy` and `catalogue`
 * are this process's own or the context's published defaults.
 *
 * `ProviderProbeCache` is the tenth and it has NO BINDING ROW AT ALL — the
 * binding table says so in its own words: "§13's map has no home for it and no
 * canonical store should hold it". A composition root can therefore satisfy it
 * only by writing an implementation, and the two available shapes are both
 * decisions this tranche is not entitled to take:
 *
 *   an IN-PROCESS map would make `forgetProvider` per-instance, which is
 *   precisely the stale-`healthy`-after-a-leak hole `evict-probe-cache.ts` was
 *   written to close;
 *
 *   a store over `redis-cache`'s `Cache` would be an adapter in all but name,
 *   living in the composition root and answering a port ADR M0.3 §13 has
 *   deliberately not given a home.
 *
 * It is a constant because `installation.test.ts` reads it back and JOINS it to
 * `ADAPTER_BINDINGS`: the claim "no row binds this port" is checked against the
 * table rather than believed.
 */
export const PROVIDERS_UNASSEMBLED =
  "ProviderProbeCache is bound to no adapter in ADAPTER_BINDINGS, so nine of the" +
  " ten slots on ProvidersDependencies are reachable and the tenth can be" +
  " satisfied only by an implementation this composition root would have to own";

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
  const keyring = adapters["keyring-envelope"];

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

  // WIN-267 T4 — `secrets`, and the two halves it needs named separately.
  //
  // The vault's eight slots come off TWO directories, and an install can have
  // one without the other: a database with no `PLATOS_SECURITY_ENCRYPTION_KEY`
  // is a common half-configured state, and so is a key ring with no store. So
  // the reason a caller reads says WHICH half is missing rather than "secrets is
  // unassembled", because the operator response to the two is a different
  // variable.
  const secrets: SecretsDependencies | null =
    postgres === undefined || keyring === undefined
      ? null
      : {
          repository: postgres.secrets,
          variables: postgres.secretsVariables,
          // ONE OBJECT IN THREE SLOTS, and that is the adapter's own shape
          // rather than a shortcut: `KeyringEnvelopeAdapter extends KeyRing,
          // AeadCipher, Hasher`, and `PORT_SATISFACTION` proves each of the
          // three separately at compile time. Naming the slots is what stops the
          // ring reaching the cipher's parameter on a future refactor that made
          // them different objects.
          keyRing: keyring,
          cipher: keyring,
          hasher: keyring,
          clock: dependencies.clock,
          ids: dependencies.ids,
          unitOfWork: postgres.unitOfWork,
        };
  if (secrets === null) {
    const missing =
      postgres === undefined && keyring === undefined
        ? "postgres-tenancy (its repository, variables and unit of work) and keyring-envelope (its key ring, cipher and hasher)"
        : postgres === undefined
          ? "postgres-tenancy, which carries its repository, its variables and its unit of work"
          : "keyring-envelope, which carries its key ring, its cipher and its hasher";
    unassembled.push(
      Object.freeze({ context: "secrets", reason: `${missing} is not constructed` }),
    );
  }

  return Object.freeze({
    ports: Object.freeze({
      ...(postgres === undefined
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
          }),
      ...(secrets === null ? {} : { secrets }),
    }),
    unassembled: Object.freeze([...unassembled]),
  });
}
