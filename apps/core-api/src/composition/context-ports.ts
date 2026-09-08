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
//   1. the context publishes a factory that assembles its whole contract, AND
//      this package can import it. SEVENTEEN publish one; NINE are importable.
//
//      THIS CONDITION USED TO BE ONE CLAUSE AND IT WAS FALSE THREE TIMES OVER.
//      It read "THIRTEEN do; FOUR do not -- `agents`, `tools`, `memory` and
//      `cost-monitoring` publish their use cases one by one and no assembler
//      over them", and before that "ELEVEN and SIX", naming `secrets` and
//      `providers` among the six. Every version of it has been wrong in the same
//      direction and wrong at v1 rather than newly wrong. `agentsContract`,
//      `toolsContract`, `memoryContract` and `costMonitoringContract` sit in
//      their own packages' `contracts/index.ts` beside `secretsContract` and
//      `providersContract` -- the `.` entry point this file already imports
//      `DEFAULT_PROVIDERS_POLICY` from -- and the other eleven contexts publish
//      a `create*Contract` or `create*Service` in `application/`. WIN-267 G3
//      grepped for the four the way A3 should have grepped for the two, and
//      found the same answer: there is no context in this tree without an
//      assembler, and there never was.
//
//      SO THE CONDITION IS SPLIT, because the half that is real is a MANIFEST
//      question and not an authoring one. Nine factories can be named from here:
//      six from `.`, and `identity-access`, `tenancy` and `skills` from the
//      `./application/index.js` their manifests publish. The other eight --
//      `UNIMPORTABLE_CONTEXT_FACTORIES` below -- publish only `.`,
//      `./application/ports/index.js` and `./application/testing/index.js`, so
//      their factory exists, is tested, and cannot be imported by the one file
//      entitled to call it. That is WIN-297's finding, unchanged and still open
//      for eight contexts; the fix is a line of `APPLICATION_ENTRY_PROJECTS`
//      each, and that generator's own rule holds it back until the context is
//      actually composed.
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
// `GovernanceDependencies` -- SEVENTEEN slots. FIVE of its ten driven ports have
// no row in `ADAPTER_BINDINGS` and no adapter directory anywhere:
// `RatingTargetReader`, `TranscriptReader` and `ActivityReader` are ADR M0.3 §2
// read seams whose own header says "the composition root implements it by asking
// whichever context owns the rows" -- `conversations`, `tools` and `jobs`;
// `EvalRunQueue` needs the kernel `DurableRuntime`, whose directory is one of
// the seven still on `UNIMPLEMENTED_ADAPTERS`; and `Judge` has no directory at
// all. `@platos/context-governance` also publishes no `./application/index.js`,
// so `createGovernanceContract` is not importable from here even once those five
// land -- see `UNIMPORTABLE_CONTEXT_FACTORIES`.
//
// AND ITS `AgentsContract` SLOT IS NOT AN ASSEMBLER PROBLEM, WHICH IS WIN-267
// G3's FINDING. This paragraph used to end "and `agents` publishes its use cases
// one by one", and that was false: `agentsContract` is exported from
// `packages/contexts/agents/contracts/index.ts`, the same `.` entry point
// `app.module.ts` already imports the `AgentsContract` TYPE from. What actually
// blocks the slot is that the root must hand over a composed `agents`, and
// `agents` is itself short: `AgentVersionLock` and `MacroRecorder` are on no row
// of `ADAPTER_BINDINGS` (`AGENTS_UNBOUND_PORTS`), and its `skills` peer is a
// tenth context this root does not compose -- `skills` needs
// `SkillSourceFetcher`, `EnvironmentKeyDirectory` and `SkillSandbox`, none of
// which has a directory, and a `files` peer whose `ObjectStore` is
// `objectstore-minio`, still on `UNIMPLEMENTED_ADAPTERS`.
//
// SO THE CHAIN IS FIVE CONTEXTS DEEP AND IT IS WORTH WRITING DOWN, because the
// sentence this replaced read as though `governance` were the last mile:
//
//   identity-access <- governance <- agents <- skills <- files <- objectstore-minio
//
// ELEVEN driven ports across those four contexts have no adapter directory --
// governance's five, agents' two, skills' three and files' one. FOUR of the
// eight missing manifest lines are on this path too: `files` and `governance`
// on the chain itself, and `conversations` and `jobs` among the three contexts
// the read seams must be implemented over. The third of those, `tools`, is one
// of the nine already importable, from its own `.` entry point.
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
  " the governance context, whose own bundle names five driven ports no adapter" +
  " directory satisfies (RatingTargetReader, TranscriptReader, ActivityReader," +
  " Judge, EvalRunQueue), whose createGovernanceContract this root cannot import" +
  " because @platos/context-governance publishes no ./application/index.js, and" +
  " whose AgentsContract slot needs a composed agents -- agentsContract does" +
  " assemble that contract, from the package's own . entry point, but agents" +
  " names two driven ports no adapter directory satisfies (AgentVersionLock," +
  " MacroRecorder) and a skills peer this root does not compose; so this root" +
  " cannot compose it";

/**
 * The five governance ports that keep the sink out of reach, named once.
 *
 * READ BACK BY `installation.test.ts` against `ADAPTER_BINDINGS`: every one of
 * them must appear on NO row of the binding table. That is what turns "governance
 * cannot be composed" from an author's belief into a checked property -- the day
 * an adapter directory implements one of these, the count of what is left drops
 * and this list has to move with it.
 */
export const GOVERNANCE_UNBOUND_PORTS: readonly string[] = Object.freeze([
  "RatingTargetReader",
  "TranscriptReader",
  "ActivityReader",
  "Judge",
  "EvalRunQueue",
]);

/**
 * The two `agents` ports that keep the peer BEHIND that sink out of reach.
 *
 * WIN-267 G3. They exist because the clause they replace was FALSE. The sentence
 * above used to end "and an AgentsContract no factory assembles", and
 * `agentsContract` has been exported from
 * `packages/contexts/agents/contracts/index.ts` -- the `.` entry point
 * `app.module.ts` already imports `AgentsContract` FROM -- since before that
 * sentence was written. It is the third claim of that exact shape this
 * programme has had to withdraw: `secrets` and `providers` sat uncomposed
 * against the same wording and were composed the moment somebody grepped.
 *
 * SO THE BLOCKER IS RESTATED WHERE IT ACTUALLY IS, and it is two adapter
 * directories rather than an assembler. `AgentsDependencies` names FOUR driven
 * ports: `AgentsRepository` and `ScaffoldingRepository` are `postgres-tenancy`
 * (WIN-258 T5, two rows of `ADAPTER_BINDINGS`), and these two are on no row of
 * that table and in no `packages/adapters/` directory.
 *
 * READ BACK BY `installation.test.ts` AGAINST `ADAPTER_BINDINGS`, in both
 * directions, exactly as `GOVERNANCE_UNBOUND_PORTS` is: each name here must
 * appear on NO binding row, and the two that ARE bound must be present by owner.
 * The day a directory implements one of these, that case fails and this list has
 * to move -- which is what stops a correction from going stale the way the
 * sentence it replaced did.
 */
export const AGENTS_UNBOUND_PORTS: readonly string[] = Object.freeze([
  "AgentVersionLock",
  "MacroRecorder",
]);

/**
 * The eight contexts whose contract factory this root cannot IMPORT.
 *
 * WIN-267 G3, and it is the other half of the same correction. The note at the
 * head of this file used to say FOUR contexts "publish their use cases one by
 * one and no assembler over them", naming `agents`, `tools`, `memory` and
 * `cost-monitoring`. All four publish one, and all four publish it from `.`:
 * `agentsContract`, `toolsContract`, `memoryContract` and
 * `costMonitoringContract` sit in their packages' own `contracts/index.ts`
 * beside `secretsContract` and `providersContract`. SEVENTEEN of seventeen
 * contexts publish a factory over their whole contract; ZERO do not.
 *
 * WHAT IS REAL IS A DIFFERENT PROBLEM WITH A DIFFERENT FIX. Nine factories are
 * reachable from here -- six from `.` and three (`identity-access`, `tenancy`,
 * `skills`) from the `./application/index.js` their manifests publish. The eight
 * below keep theirs in `application/` behind a manifest that publishes only
 * `.`, `./application/ports/index.js` and `./application/testing/index.js`, so
 * `createGovernanceContract` and its seven siblings cannot be named here at all.
 * That is one line of `APPLICATION_ENTRY_PROJECTS` per context, not an assembler
 * to write -- and `gen-v1-skeleton.mjs`'s own rule says why the line is not here
 * yet: the list is "the contexts `apps/core-api` ACTUALLY composes", so the
 * entry follows the composition rather than leading it.
 *
 * IT MATTERS MOST FOR `governance`. A tranche that lands all five of
 * `GOVERNANCE_UNBOUND_PORTS` still cannot compose the context, because the
 * factory is not importable -- so the port work and the manifest line have to
 * land together, and this constant is what says so before somebody discovers it
 * at the end.
 *
 * READ BACK BY `installation.test.ts` BY IMPORTING: each subpath is resolved at
 * run time and must REJECT. A negative about packaging is exactly the kind of
 * claim this file has been wrong about before, so it is measured against Node's
 * own resolver rather than asserted, and the day a manifest publishes one of
 * these the case fails and this list has to move.
 */
export const UNIMPORTABLE_CONTEXT_FACTORIES: readonly string[] = Object.freeze([
  "channels",
  "conversations",
  "eventing",
  "files",
  "governance",
  "jobs",
  "observability",
  "privacy",
]);

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
