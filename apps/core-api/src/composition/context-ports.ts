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
//      THIRTEEN do; FOUR do not -- `agents`, `tools`, `memory` and
//      `cost-monitoring` publish their use cases one by one and no assembler
//      over them.
//
//      THIS SENTENCE USED TO SAY ELEVEN AND SIX, AND IT NAMED `secrets` AND
//      `providers` AMONG THE SIX. It was wrong on both, and it was wrong at v1
//      rather than newly wrong: `secretsContract` has been exported from
//      `packages/contexts/secrets/contracts/index.ts` and `providersContract`
//      from `packages/contexts/providers/contracts/index.ts` since before this
//      note was written, and both are on the `.` entry point every package
//      already publishes. WIN-267 A3 repeated the claim in
//      `PROVIDERS_UNASSEMBLED` and made a decision on it. It is corrected here by
//      MEASUREMENT and, more to the point, by acting on it: both contexts are
//      composed below.
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
// same adapter -- WIN-258 tranche 2 put it there -- and `logger`, `clock` and
// `ids` are kernel ports this process already holds.
//
// WIN-267 A3 COUNTED THE SLOTS AND THE OLD SENTENCE WAS WRONG THREE TIMES OVER,
// which is recorded here rather than quietly corrected because a figure repeated
// without being verified is how this programme has been wrong before. It read
// "its bundle has eight slots ... the other four have NO implementation" and
// then named FIVE of them. `application/dependencies.ts` declares TEN:
// `repository`, `rateLimiter`, `hasher`, `minter`, `totp` and `cipher` -- the SIX
// driven ports its own `ports/index.ts` header enumerates -- plus FOUR kernel
// ports, `clock`, `ids`, `safety` and `logger`. The old sentence omitted `safety`
// from the kernel list, which is the third error and the one that mattered: the
// kernel `SafetyEventSink` is implemented by `governance`, which this root does
// not compose, so it is not a port "this process already holds" either.
//
// ---------------------------------------------------------------------------
// AND NOW THE SUM, WHICH NO BRANCH OF WIN-267 COULD STATE ON ITS OWN. Each
// tranche measured this list against v1 and each was right about itself:
//
//   A1 closed `hasher` -- `packages/adapters/node-crypto-digest` -- and `cipher`
//   -- `keyring-envelope.mfaSecrets`, a FOURTH port on an existing directory
//   rather than a new one, because AES-256 root key bytes have exactly one
//   custodian in this tree and rule (j2) forbids a second package from reaching
//   them.
//
//   A2 closed `minter` and `totp`, both on `packages/adapters/tokenmint-totp`,
//   because the port that WRITES a TOTP secret and the port that READS it must
//   share one base32 alphabet.
//
//   A3 closed `rateLimiter` -- `packages/adapters/redis-ratelimit`, the FIRST
//   directory ever to leave `UNIMPLEMENTED_ADAPTERS` -- and proved the one claim
//   that mattered against a real Redis: 32 concurrent consumers get 32 distinct
//   counts, and replacing its single Lua script with a client-side GET/SET
//   collapses that to 2 and admits 16 requests under a limit of 10.
//
// SO ALL SIX DRIVEN PORTS ARE SATISFIED AND THE CONTEXT IS STILL NOT ASSEMBLED,
// AND THAT IS THE WHOLE OF WHAT IS LEFT. `IDENTITY_ACCESS_UNASSEMBLED` goes from
// naming four ports, then one, to naming NO driven port at all: the only
// unfilled slot is the kernel `SafetyEventSink`.
//
// WHY THAT ONE CANNOT BE CLOSED HERE, MEASURED RATHER THAN ASSERTED. Its only
// implementation is `createGovernanceSafetyEventSink`, which takes a
// `GovernanceDependencies` -- SEVENTEEN slots. FIVE of its ten driven ports had
// no row in `ADAPTER_BINDINGS` and no adapter directory anywhere. WIN-267 G1
// closes TWO of the five and the remaining count is THREE:
//
//   `RatingTargetReader`, `TranscriptReader` and `ActivityReader` are ADR M0.3
//   §2 read seams whose own header says "the composition root implements it by
//   asking whichever context owns the rows" -- `conversations`, `tools` and
//   `jobs`, none of which publishes a contract assembler. These three are what
//   is left.
//
//   `EvalRunQueue` IS CLOSED, and not the way this note predicted. It said the
//   port "needs the kernel `DurableRuntime`, whose directory is one of the seven
//   still on `UNIMPLEMENTED_ADAPTERS`". What the port needs is a DURABLE
//   ACCEPTANCE, and §15 says where a row in the one PostgreSQL database is
//   written: `postgres-tenancy`. Implementing `DurableRuntime` over that same
//   database would have been a different act -- deciding a supplier question
//   whose own configuration group (`PLATOS_DURABLE_RUNTIME_API_URL` plus a
//   secret key) already answers it with an external service.
//
//   `Judge` IS CLOSED TOO, in this file's own deployable rather than in a
//   directory: `composition/governance-judge.ts`. The old sentence "has no
//   directory at all" was true and would have stayed true forever; three rules
//   measured in that file make an adapter for it impossible.
//
// Its bundle also names `AgentsContract`, and `agents` publishes its use cases
// one by one. `@platos/context-governance` does not even publish
// `./application/index.js`, so the factory is not importable from here. THOSE
// two, and the three read seams, are the whole of what is left.
//
// A rate limiter alone would therefore NOT have been enough:
// `consume-rate-limit.ts` writes `identity.rate_limit.degraded` into this sink,
// so a bundle without it would crash on the first refusal rather than on the
// first sign-in.
//
// THAT IS WHY `APPLICATION_ENTRY_PROJECTS` GAINS NO ENTRY IN THIS TRANCHE. The
// generator's own rule for that list is "the contexts `apps/core-api` ACTUALLY
// composes", and an entry without a matching import is the dead surface WIN-297
// declined to create. No context becomes composable here that was not composable
// before; what changed is that one of the two is now composed over REAL
// PostgreSQL instead of over a bundle an install had to hand in.
// ---------------------------------------------------------------------------

import type { Clock, IdGenerator, Logger } from "@platos/kernel";

import { DEFAULT_PROVIDER_CATALOGUE, DEFAULT_PROVIDERS_POLICY } from "@platos/context-providers";

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
  "every one of its six driven ports now has an implementation and its kernel" +
  " SafetyEventSink slot does not: IdentityAccessRepository is postgres-tenancy," +
  " RateLimiter is redis-ratelimit, SecretHasher is node-crypto-digest," +
  " MfaSecretCipher is keyring-envelope, TokenMinter is tokenmint-totp and" +
  " TotpCodeVerifier is tokenmint-totp; SafetyEventSink is implemented only by" +
  " the governance context, whose own bundle names three driven ports no adapter" +
  " directory satisfies (RatingTargetReader, TranscriptReader, ActivityReader)" +
  " and an AgentsContract no factory assembles, so this root cannot compose it";

/**
 * The governance ports that keep the sink out of reach, named once.
 *
 * READ BACK BY `installation.test.ts` against `ADAPTER_BINDINGS`: every one of
 * them must appear on NO row of the binding table. That is what turns "governance
 * cannot be composed" from an author's belief into a checked property -- the day
 * an adapter directory implements one of these, the count of what is left drops
 * and this list has to move with it.
 *
 * WIN-267 G1 IS THAT DAY, TWICE, AND THE TWO DEPARTURES ARE DIFFERENT IN KIND.
 *
 *   `EvalRunQueue` LEFT BY GAINING A BINDING. It is
 *   `postgres-tenancy:EvalRunQueue`, the sixteenth row on that directory and the
 *   sixth `governance` owns, because ADR M0.3 §1 row 14's "eval runs enqueue as
 *   durable jobs" is a ROW in the one PostgreSQL database and §15 says a row in
 *   that database is written from the one directory holding its client. This
 *   list moved with it, in the direction the paragraph above demands, and
 *   `composition-root.mjs` checks the binding itself.
 *
 *   `Judge` LEFT WITHOUT ONE, and that is why it is named in
 *   `GOVERNANCE_ROOT_SATISFIED_PORTS` below rather than dropped. It has an
 *   implementation -- `composition/governance-judge.ts` -- and it will never have
 *   an adapter directory, which that file measures three ways: `provider-sdk-only`
 *   pins every provider client to `model-router-providers`; `ModelRouter`'s every
 *   method takes a `ProviderCredential` the caller must already hold, while
 *   `Judge.ask` is handed a scope and a model spec and none; and the port
 *   requires a PRICE, which only `ProvidersContract.priceModelUsage` produces. A
 *   list that said "no adapter directory satisfies Judge" would therefore have
 *   stayed true forever while being read as "still missing".
 */
export const GOVERNANCE_UNBOUND_PORTS: readonly string[] = Object.freeze([
  "RatingTargetReader",
  "TranscriptReader",
  "ActivityReader",
]);

/**
 * Governance ports satisfied by THIS DEPLOYABLE rather than by an adapter.
 *
 * READ BACK BY `installation.test.ts` IN BOTH DIRECTIONS, which is the only
 * thing that makes the split above honest: each name here must appear on NO row
 * of `ADAPTER_BINDINGS` -- so a port that later gains a directory cannot sit
 * here unnoticed -- and `composeApplication` must publish a non-null port for it
 * once the context it is built over is composed. A name moved into this list
 * without an implementation fails the second half; an implementation landed in
 * an adapter without the name moving out fails the first.
 *
 * `read-seams.ts` says the composition root implements its three "by asking
 * whichever context owns the rows". This is the same shape for the same reason,
 * against the context that owns the keys, the routes and the rate cards.
 */
export const GOVERNANCE_ROOT_SATISFIED_PORTS: readonly string[] = Object.freeze(["Judge"]);

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
  const cache = adapters["redis-cache"];
  const router = adapters["model-router-providers"];

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

  // WIN-267 composition. `secrets` needs a store, a variable store and the three
  // cryptography ports, and every one of them is a NAMED property of a
  // constructed adapter. It declines on the FIRST directory that is missing, and
  // it names WHICH — an operator reading `/readyz` with a database but no
  // `PLATOS_SECURITY_ENCRYPTION_KEY` must be told about the key ring rather than
  // about "secrets".
  const secretsMissing: string[] = [];
  if (postgres === undefined) secretsMissing.push("postgres-tenancy (SecretsRepository, EnvironmentVariableRepository, UnitOfWork)");
  if (keyring === undefined) secretsMissing.push("keyring-envelope (KeyRing, AeadCipher, Hasher)");
  if (secretsMissing.length > 0) {
    unassembled.push(
      Object.freeze({
        context: "secrets",
        reason: `its driven ports are all satisfied and ${secretsMissing.join(" and ")} ${secretsMissing.length === 1 ? "is" : "are"} not constructed`,
      }),
    );
  }

  // `providers` takes eight of its ten slots from adapters and kernel ports, and
  // TWO from composed PEERS — `tenancy` for the authorization seam and `secrets`
  // for the vault hand-off. Those two are built in `app.module.ts`, which is why
  // this file hands over everything BUT them: a bundle assembled here would have
  // to hold a context contract, and contexts are what the composition root
  // builds. `policy` and `catalogue` are DOMAIN VALUES with published defaults —
  // `providers/domain/catalogue.ts` says outright that "every rule takes it as a
  // parameter, so an installation can extend the provider list without a code
  // change" — so taking the shipped ones here is the documented default and not
  // an invention of this file's.
  const providersMissing: string[] = [];
  if (postgres === undefined) providersMissing.push("postgres-tenancy (ProvidersRepository, UnitOfWork)");
  if (router === undefined) providersMissing.push("model-router-providers (ModelRouter)");
  if (cache === undefined) providersMissing.push("redis-cache (ProviderProbeCache)");
  if (keyring === undefined) providersMissing.push("keyring-envelope, through the secrets peer it calls on every path that touches key material");
  if (providersMissing.length > 0) {
    unassembled.push(
      Object.freeze({
        context: "providers",
        reason: `every driven port it names has an implementation and ${providersMissing.join(", ")} ${providersMissing.length === 1 ? "is" : "are"} not constructed`,
      }),
    );
  }

  const ports: {
    -readonly [Key in keyof SuppliedContextPorts]?: SuppliedContextPorts[Key];
  } = {};

  if (postgres !== undefined) {
    ports.tenancy = {
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
    };
  }

  if (postgres !== undefined && keyring !== undefined) {
    // `secrets` and `secretsVariables` are two DIFFERENT properties of the ORM
    // adapter and the only two of this bundle's ports that could not be spread
    // into it, which `PORT_SATISFACTION` records by indexing both through the
    // property rather than through the adapter. Naming them here is what makes a
    // transposition impossible: `SecretsRepository` and
    // `EnvironmentVariableRepository` are structurally different, so a
    // positional bundle would fail the compiler, but the three cryptography
    // ports below are all satisfied by the SAME object and a positional bundle
    // of those three would type-check with any two of them swapped.
    ports.secrets = {
      repository: postgres.secrets,
      variables: postgres.secretsVariables,
      keyRing: keyring,
      cipher: keyring,
      hasher: keyring,
      clock: dependencies.clock,
      ids: dependencies.ids,
      unitOfWork: postgres.unitOfWork,
    };
  }

  if (postgres !== undefined && keyring !== undefined && router !== undefined && cache !== undefined) {
    ports.providers = {
      repository: postgres,
      modelRouter: router,
      probeCache: cache.probes,
      clock: dependencies.clock,
      ids: dependencies.ids,
      unitOfWork: postgres.unitOfWork,
      policy: DEFAULT_PROVIDERS_POLICY,
      catalogue: DEFAULT_PROVIDER_CATALOGUE,
    };
  }

  return Object.freeze({
    ports: Object.freeze({ ...ports }),
    unassembled: Object.freeze([...unassembled]),
  });
}
