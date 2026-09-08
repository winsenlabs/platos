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
//      THIS SENTENCE HAS NOW BEEN WRONG TWICE, THE SAME WAY, AND THE COUNT ONLY
//      EVER MOVED WHEN SOMEBODY LOOKED. It said ELEVEN and SIX and named
//      `secrets` and `providers` among the six; both had been exported the whole
//      time, and WIN-267 A3 repeated the claim in `PROVIDERS_UNASSEMBLED` before
//      measuring it. It then said THIRTEEN and FOUR and named `agents`, `tools`,
//      `memory` and `cost-monitoring`. WIN-267 G2 counted the factories, and
//      every one of those four has one:
//
//        agentsContract           packages/contexts/agents/contracts/index.ts:332
//        toolsContract            packages/contexts/tools/contracts/index.ts:269
//        memoryContract           packages/contexts/memory/contracts/index.ts:388
//        costMonitoringContract   packages/contexts/cost-monitoring/contracts/index.ts:280
//
//      and the three this file called assembler-less on the governance path have
//      one apiece as well -- `createConversationsContract`,
//      `createJobsContract`, `createGovernanceContract` -- reached from
//      `application/` rather than from `contracts/index.ts` in two of the three
//      cases, which is how they were missed.
//
//      SO CONDITION 1 IS NOT WHAT STOPS ANY CONTEXT BEING COMPOSED. Conditions 2
//      and 3 are, and they are measured per context below. A context whose
//      assembler exists and whose bundle cannot be filled is still unassembled;
//      what is no longer true is that four contexts publish "use cases one by
//      one".
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
// `GovernanceDependencies` -- SEVENTEEN slots. FIVE of its ten driven ports had
// no row in `ADAPTER_BINDINGS` and no adapter directory anywhere. WIN-267 G1 and
// G2 CLOSE ALL FIVE, and the three ways they closed are different in kind, which
// is why the count is kept as three lists rather than one:
//
//   `RatingTargetReader`, `TranscriptReader` and `ActivityReader` GAINED
//   BINDINGS on `postgres-tenancy` (G2). Their own header says "the composition
//   root implements it by asking whichever context owns the rows" --
//   `conversations`, `tools` and `jobs` -- and the sentence that called that
//   impossible was wrong twice over; see the correction below.
//
//   `EvalRunQueue` GAINED A BINDING TOO (G1), and not the way this note
//   predicted. It said the port "needs the kernel `DurableRuntime`, whose
//   directory is one of the seven still on `UNIMPLEMENTED_ADAPTERS`". What the
//   port needs is a DURABLE ACCEPTANCE, and §15 says where a row in the one
//   PostgreSQL database is written: `postgres-tenancy`. Implementing
//   `DurableRuntime` over that same database would have been a different act --
//   deciding a supplier question whose own configuration group
//   (`PLATOS_DURABLE_RUNTIME_API_URL` plus a secret key) already answers with an
//   external service.
//
//   `Judge` IS SATISFIED WITHOUT A BINDING (G1), in this deployable rather than
//   in a directory: `composition/governance-judge.ts`. The old sentence "has no
//   directory at all" was true and would have stayed true forever; three rules
//   measured in that file make an adapter for it impossible.
//
// SO `GOVERNANCE_UNBOUND_PORTS` IS EMPTY AND GOVERNANCE STILL DOES NOT COMPOSE.
// What is left is not a driven port at all. Its bundle names `AgentsContract`,
// and `@platos/context-governance` publishes no `./application/index.js`, so the
// factory is not importable from here -- see `UNIMPORTABLE_CONTEXT_FACTORIES`
// below. That is a MANIFEST line and a peer context, not an adapter, and
// neither G1 nor G2 could close it alone.
//
// AND THE `AgentsContract` SLOT IS NOT AN ASSEMBLER PROBLEM EITHER, WHICH IS
// WIN-267 G3's FINDING. This paragraph used to end "and `agents` publishes its
// use cases one by one", and that was false: `agentsContract` is exported from
// `packages/contexts/agents/contracts/index.ts`, the same `.` entry point
// `app.module.ts` already imports the `AgentsContract` TYPE from. What actually
// blocks the slot is that the root must hand over a COMPOSED `agents`, and
// `agents` is itself short: `AgentVersionLock` and `MacroRecorder` are on no row
// of `ADAPTER_BINDINGS` (`AGENTS_UNBOUND_PORTS`), and its `skills` peer is a
// tenth context this root does not compose -- `skills` needs
// `SkillSourceFetcher`, `EnvironmentKeyDirectory` and `SkillSandbox`, none of
// which has a directory, and a `files` peer whose `ObjectStore` is
// `objectstore-minio`, still on `UNIMPLEMENTED_ADAPTERS`.
//
// IT WAS FIVE UNTIL WIN-267 G2, AND THE THREE THAT LEFT WERE LEFT FOR A REASON
// THAT WAS NEVER TRUE. The sentence said `RatingTargetReader`,
// `TranscriptReader` and `ActivityReader` were unsatisfiable because their own
// header says "the composition root implements it by asking whichever context
// owns the rows" -- `conversations`, `tools` and `jobs` -- "none of which
// publishes a contract assembler". BOTH HALVES WERE WRONG, and measurably so:
//
//   the OWNERS are not somewhere else. `CANONICAL_STORE_ADAPTERS` in
//   `scripts/arch/table-ownership.mjs` maps all EIGHTEEN owners, those three
//   included, to `packages/adapters/postgres-tenancy`. Under ADR M0.3 §15 that
//   directory IS `conversations`' and `tools`' and `jobs`' canonical store and
//   the sole writer of `Thread`, `Turn`, `ToolCallAudit` and `AgentApproval`.
//   Asking the owner and asking that directory are the same act, so the seams
//   are three rows on it and no thirteenth package was needed.
//
//   and the ASSEMBLER CLAIM IS FALSE FOR ALL SEVENTEEN CONTEXTS, not only for
//   these three. Counted rather than believed, with the file and line:
//   `createConversationsContract` (conversations/application/conversations-contract.ts:134),
//   `toolsContract` (tools/contracts/index.ts:269), `createJobsContract`
//   (jobs/application/jobs-contract.ts:224), `agentsContract`
//   (agents/contracts/index.ts:332), `memoryContract`
//   (memory/contracts/index.ts:388), `costMonitoringContract`
//   (cost-monitoring/contracts/index.ts:280). The note near the top of this file
//   says "FOUR do not -- `agents`, `tools`, `memory` and `cost-monitoring`" and
//   names an assembler for each of the four in the list above. This is the SECOND
//   time that paragraph has been wrong in the same way: it named `secrets` and
//   `providers` before, and both were exported the whole time.
//
// THAT CORRECTION IS RECORDED HERE AND ACTED ON ONLY FOR THE THREE SEAMS. Whether
// `AgentsContract` can be BUILT is a different question from whether an assembler
// exists -- its own bundle has to be satisfiable too -- and this tranche has not
// measured that. It is a sibling's, and the clause below still names it.
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

import type { Clock, IdGenerator, Logger, SafetyEventSink } from "@platos/kernel";

import { DEFAULT_PROVIDER_CATALOGUE, DEFAULT_PROVIDERS_POLICY } from "@platos/context-providers";
import { DEFAULT_GOVERNANCE_POLICY } from "@platos/context-governance";
import { createGovernanceSafetyEventSink } from "@platos/context-governance/application/index.js";

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
  /**
   * The kernel `SafetyEventSink` this assembly minted, or null when no store
   * carried its ledger.
   *
   * PUBLISHED SO THE IDENTITY CAN BE PINNED. `governance-contract.ts` requires
   * this port to be minted once and handed back by identity; a caller that could
   * not SEE the object could not check that the bundle it went into holds the
   * same one. `installation.test.ts` asserts exactly that.
   */
  readonly safetyEventSink: SafetyEventSink | null;
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
  "every one of its TEN slots now has an implementation and the context is" +
  " COMPOSED wherever the directories carrying them are constructed; " +
  "IdentityAccessRepository is postgres-tenancy, RateLimiter is redis-ratelimit," +
  " SecretHasher is node-crypto-digest, MfaSecretCipher is keyring-envelope," +
  " TokenMinter and TotpCodeVerifier are tokenmint-totp, clock, ids and logger" +
  " are kernel ports this process holds, and the kernel SafetyEventSink is" +
  " governance's own createGovernanceSafetyEventSink over postgres-tenancy's" +
  " SafetyLedger. In THIS install ";

/**
 * WHICH SOURCE FILLS EACH OF `identity-access`' TEN SLOTS, named once.
 *
 * THE INVERSION. This constant replaces a sentence that said which port had NO
 * implementation, and it is read back the other way round:
 * `installation.test.ts` asserts that every slot here is satisfied, that each
 * adapter-sourced one appears on a row of `ADAPTER_BINDINGS` under this owner,
 * that each row's directory is NOT on `UNIMPLEMENTED_ADAPTERS`, and that a fully
 * declared install CONSTRUCTED it -- and then that the composed context is
 * actually present on `app.contexts`. Removing any one of those adapters must
 * turn that case RED, which is the property the old "is not composed, because"
 * sentence could never have: a claim about absence goes green when the subject
 * disappears.
 *
 * `safety` IS THE ONE THAT IS NOT AN ADAPTER, and it is spelled as its own
 * origin rather than folded in with the kernel three. `clock`, `ids` and
 * `logger` are ports this PROCESS holds; `safety` is a port GOVERNANCE
 * implements, built here from three named inputs. That difference is the whole
 * history of this file, so the map records it rather than flattening it.
 */
export const IDENTITY_ACCESS_SLOT_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  repository: "postgres-tenancy",
  rateLimiter: "redis-ratelimit",
  hasher: "node-crypto-digest",
  minter: "tokenmint-totp",
  totp: "tokenmint-totp",
  cipher: "keyring-envelope",
  clock: "kernel",
  ids: "kernel",
  logger: "kernel",
  safety: "governance:createGovernanceSafetyEventSink",
});

/**
 * WHY `governance` ITSELF IS STILL NOT COMPOSED, measured rather than asserted.
 *
 * WIN-267 G1 and G2 satisfied all ten of its driven ports, so the sentence this
 * programme has repeated since T3 -- "five driven ports no adapter directory
 * satisfies" -- is spent. What is left is not a port and cannot be closed by an
 * adapter, and it is stated here in full because the tranche brief that produced
 * this file expected the opposite and a reader deserves the measurement rather
 * than the expectation:
 *
 *   `GovernanceDependencies.agents` is an `AgentsContract`, and this root must
 *   hand over a COMPOSED `agents`. `agentsContract` EXISTS -- WIN-267 G3
 *   withdrew the claim that it did not -- but `AgentsDependencies` names
 *   `versionLock: AgentVersionLock` and `recorder: MacroRecorder`, both on no
 *   row of `ADAPTER_BINDINGS` (`AGENTS_UNBOUND_PORTS`), and `skills: SkillsPeer`,
 *   whose only honest source is a composed `skills`.
 *
 *   `SkillsDependencies` in turn names `sourceFetcher: SkillSourceFetcher`,
 *   `environmentKeys: EnvironmentKeyDirectory` and `sandbox: SkillSandbox`, none
 *   of which has a directory -- and `skill-source-fetcher.ts`'s own header says
 *   so in writing: "NOTHING IN THIS REPOSITORY IMPLEMENTS THIS PORT YET." It
 *   also names `files: FilesContract`, and `FilesDependencies.objectStore` is
 *   `objectstore-minio`, still on `UNIMPLEMENTED_ADAPTERS`.
 *
 * SO THE CHAIN IS FOUR CONTEXTS AND SIX UNBOUND PORTS DEEP, ending at two
 * EXTERNAL SUPPLIERS -- an object store and a code sandbox -- and closing it is
 * not an adapter tranche. That is why this tranche composes `identity-access`
 * through the SINK rather than through the context: the sink reads three slots
 * of the seventeen and none of them is `agents`.
 *
 * READ BACK BY `installation.test.ts` against `ADAPTER_BINDINGS` and against
 * `UNIMPLEMENTED_ADAPTERS`, so the day `objectstore-minio` or either agents port
 * lands, this sentence has to move.
 */
export const GOVERNANCE_UNCOMPOSABLE_CHAIN: readonly string[] = Object.freeze([
  "AgentVersionLock",
  "MacroRecorder",
  "SkillSourceFetcher",
  "EnvironmentKeyDirectory",
  "SkillSandbox",
  "ObjectStore",
]);

/**
 * The governance ports that keep the sink out of reach, named once.
 *
 * READ BACK BY `installation.test.ts` against `ADAPTER_BINDINGS`: every one of
 * them must appear on NO row of the binding table. That is what turns "governance
 * cannot be composed" from an author's belief into a checked property -- the day
 * an adapter directory implements one of these, the count of what is left drops
 * and this list has to move with it.
 *
 * WIN-267 G1 AND G2 ARE THAT DAY, FIVE TIMES, AND THE LIST IS NOW EMPTY. An
 * empty list is the weakest possible readback on its own, so it is not the only
 * one: `GOVERNANCE_BOUND_READ_SEAMS` and `GOVERNANCE_ROOT_SATISFIED_PORTS` below
 * name where each of the five went, and `installation.test.ts` checks that the
 * three lists PARTITION governance's ten driven ports -- so a port cannot leave
 * this list without arriving somewhere, which is what an emptied list would
 * otherwise hide.
 *
 * THE DEPARTURES ARE DIFFERENT IN KIND.
 *
 *   THE THREE READ SEAMS LEFT BY GAINING BINDINGS (G2), all three on
 *   `postgres-tenancy`, which `table-ownership.mjs` already maps as the
 *   canonical store of every one of the eighteen owners.
 *
 *   `EvalRunQueue` LEFT BY GAINING A BINDING (G1). It is
 *   `postgres-tenancy:EvalRunQueue`, the sixteenth row on that directory and the
 *   sixth `governance` owns, because ADR M0.3 §1 row 14's "eval runs enqueue as
 *   durable jobs" is a ROW in the one PostgreSQL database and §15 says a row in
 *   that database is written from the one directory holding its client. This
 *   list moved with it, in the direction the paragraph above demands, and
 *   `composition-root.mjs` checks the binding itself.
 *
 *   `Judge` LEFT WITHOUT ONE (G1), and that is why it is named in
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
export const GOVERNANCE_UNBOUND_PORTS: readonly string[] = Object.freeze([]);

/**
 * The governance ports that LEFT that list in WIN-267 G2, named once.
 *
 * READ BACK BY `installation.test.ts` IN THE OTHER DIRECTION, which is the half
 * that makes the shrinking of `GOVERNANCE_UNBOUND_PORTS` above falsifiable:
 * every one of these must appear on a row of `ADAPTER_BINDINGS`, that row's
 * directory must not be on `UNIMPLEMENTED_ADAPTERS`, and a fully declared
 * install must have CONSTRUCTED it. A list that merely stopped naming three
 * ports would be indistinguishable from one that forgot them -- which is the
 * mistake WIN-267 A3 caught on the identity-access half of the same sentence.
 */
export const GOVERNANCE_BOUND_READ_SEAMS: readonly string[] = Object.freeze([
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
  // WIN-267 — `governance` LEFT THIS LIST, and it is the first context ever to.
  // `APPLICATION_ENTRY_PROJECTS` gained it because this file now imports
  // `createGovernanceSafetyEventSink` from `./application/index.js`, which is
  // that list's own rule ("the contexts whose `application/index.js` a V1
  // project actually imports") rather than a relaxation of it. Seven remain.
  "channels",
  "conversations",
  "eventing",
  "files",
  "jobs",
  "observability",
  "privacy",
]);

/**
 * WHY `governance` IS NOT COMPOSED, in the operator's own words.
 *
 * A CONSTANT AND A `/readyz` ROW rather than a comment, because it is now the
 * ONLY context whose blocker is a peer rather than a port, and an operator
 * reading "governance is absent" cannot otherwise tell a missing variable from
 * a supply chain four contexts long. `installation.test.ts` reads it back
 * against `ADAPTER_BINDINGS` and `UNIMPLEMENTED_ADAPTERS`, so the day any link
 * in `GOVERNANCE_UNCOMPOSABLE_CHAIN` lands, this sentence has to move.
 */
export const GOVERNANCE_UNCOMPOSABLE =
  "all TEN of its driven ports are satisfied -- WIN-267 bound the three read" +
  " seams and the eval-run queue to postgres-tenancy and satisfied Judge in this" +
  " deployable -- and its kernel SafetyEventSink is built here and handed to" +
  " identity-access. What it still cannot get is its AgentsContract slot, which" +
  " needs a COMPOSED agents peer: agentsContract does assemble that contract," +
  " from the package's own . entry point, but AgentsDependencies names" +
  " AgentVersionLock and MacroRecorder on no binding row, and a skills peer" +
  " needing SkillSourceFetcher, EnvironmentKeyDirectory and SkillSandbox on no" +
  " binding row either, and a files peer whose ObjectStore is objectstore-minio," +
  " still on UNIMPLEMENTED_ADAPTERS";

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
  const ratelimit = adapters["redis-ratelimit"];
  const digest = adapters["node-crypto-digest"];
  const tokenmint = adapters["tokenmint-totp"];

  if (postgres === undefined) {
    unassembled.push(
      Object.freeze({
        context: "tenancy",
        reason: "its repository, locks, session revoker, revocation counter, invitation token issuer and operator directory are all postgres-tenancy, which is not constructed",
      }),
    );
  }
  // WIN-267. `governance` IS REPORTED UNASSEMBLED UNCONDITIONALLY, because it is
  // unassembled in EVERY install: no configuration closes it and no directory
  // an operator can wire closes it either. Reporting it only when a store is
  // absent would let a fully declared install read as though the context were
  // merely unconfigured.
  unassembled.push(Object.freeze({ context: "governance", reason: GOVERNANCE_UNCOMPOSABLE }));

  // WIN-267. THE KERNEL `SafetyEventSink`, MINTED ONCE PER ASSEMBLY, and the
  // last slot standing between this root and a composed `identity-access`.
  //
  // WHY IT IS BUILT HERE AND NOT IN `app.module.ts` WITH THE CONTEXTS. A
  // `SafetyEventSink` is a KERNEL PORT, not a context. Its three inputs are
  // exactly the kinds this file already handles: `safety` is a NAMED PROPERTY of
  // a constructed adapter, `policy` is a published domain default of the same
  // shape as `DEFAULT_PROVIDERS_POLICY` two paragraphs of this file already
  // take, and `logger` is a kernel port the process holds. Nothing here holds a
  // context -- `createGovernanceSafetyEventSink` returns a `SafetyEventSink`,
  // and `GovernanceSafetySinkDependencies` is the THREE-slot slice that function
  // now declares, not the seventeen-slot bundle a context is built from.
  //
  // WHAT IT IS NOT, STATED SO NOBODY READS IT AS MORE THAN IT IS. This does NOT
  // compose `governance`. The context is still unassembled and
  // `GOVERNANCE_UNCOMPOSABLE_CHAIN` says why, at length. The rows this sink writes are
  // the same `SafetyEvent` rows `pageSafetyEvents` will read the day that
  // context does compose -- one table, one canonical store, one admission path
  // through `appendSafetyEvent` -- so nothing here has to be undone.
  //
  // THE DAY `governance` COMPOSES, THIS MUST BECOME `governance.safetyEventSink()`
  // AND NOT A SECOND OBJECT. `governance-contract.ts` mints its sink once and
  // hands it back by identity because "a fresh `SafetyEventSink` per call would
  // be a new object on every enforcement decision". This construction obeys the
  // same rule within its own scope -- ONE object per assembly, handed to
  // whichever bundles need it -- and `installation.test.ts` pins that identity so
  // a refactor to a mint-per-bundle cannot pass.
  const safetyEventSink: SafetyEventSink | null =
    postgres === undefined
      ? null
      : createGovernanceSafetyEventSink({
          safety: postgres.safety,
          policy: DEFAULT_GOVERNANCE_POLICY,
          logger: dependencies.logger,
        });

  if (postgres === undefined || ratelimit === undefined || digest === undefined || tokenmint === undefined || keyring === undefined) {
    const missing: string[] = [];
    if (postgres === undefined) missing.push("postgres-tenancy (IdentityAccessRepository, and the SafetyLedger the kernel sink writes through)");
    if (ratelimit === undefined) missing.push("redis-ratelimit (RateLimiter)");
    if (digest === undefined) missing.push("node-crypto-digest (SecretHasher)");
    if (tokenmint === undefined) missing.push("tokenmint-totp (TokenMinter, TotpCodeVerifier)");
    if (keyring === undefined) missing.push("keyring-envelope (MfaSecretCipher)");
    unassembled.push(
      Object.freeze({
        context: "identity-access",
        reason: `${IDENTITY_ACCESS_UNASSEMBLED}${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not constructed`,
      }),
    );
  }

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

  // WIN-267. `identity-access`, composed at last, and EVERY ONE OF ITS TEN SLOTS
  // ASSIGNED BY NAME. The convention is load-bearing here in a way it is nowhere
  // else in this file: `minter` and `totp` are satisfied by the SAME
  // `tokenmint-totp` object, `repository` and `rateLimiter` are both stores, and
  // `clock` and `ids` are two kernel ports of similar shape -- a bundle
  // assembled by spreading one adapter over another would type-check with any of
  // those transposed, and the sign-in path would keep working while minting
  // tokens from the TOTP alphabet.
  if (
    postgres !== undefined &&
    ratelimit !== undefined &&
    digest !== undefined &&
    tokenmint !== undefined &&
    keyring !== undefined &&
    safetyEventSink !== null
  ) {
    ports.identityAccess = {
      repository: postgres,
      rateLimiter: ratelimit,
      hasher: digest,
      minter: tokenmint,
      totp: tokenmint,
      cipher: keyring.mfaSecrets,
      clock: dependencies.clock,
      ids: dependencies.ids,
      safety: safetyEventSink,
      logger: dependencies.logger,
    };
  }

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
    safetyEventSink,
  });
}
