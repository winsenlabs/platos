// THE COMPOSITION ROOT.
//
// One function, `composeApplication`, turns validated configuration plus whatever
// adapters an install supplied into the `AppModule` every transport is handed.
// It is the only place in V1 where a port meets its implementation.
//
// IT HOLDS NO FRAMEWORK ON PURPOSE. `@nestjs/*` lives in `src/http/` and
// `src/main.ts`; this file is plain TypeScript. Composition is the decision that
// must stay legible when the HTTP framework is replaced, and a decision
// expressed as container metadata is legible only to the container. It also
// means the composition root is exercisable in a unit test with no server, which
// is how `app.module.test.ts` proves the mis-wire detection without binding a
// port.
//
// WHY THE CONTEXTS ARE `Partial`. Seventeen contexts are declared; FIVE are real
// (WIN-256: identity-access, tenancy, secrets, files, providers) and twelve are
// still declaration-only placeholders. Of the five, TWO are composed here today
// — identity-access and tenancy — see the note below on what an install must
// still supply. Modelling that as `Partial<ContextContracts>` states the truth
// in the type instead of shipping seventeen `null!` casts that would compile and
// then explode.
//
// ---------------------------------------------------------------------------
// THE WIN-297 FINDING, CLOSED BY WIN-257 (M2.2).
//
// WIN-297 reported that a context's construction function was unreachable from
// here: every context manifest published `.` (contracts, types) and
// `./application/ports/index.js` (driven ports, types) and nothing else, so
// `createIdentityAccessService(...)` and `createTenancyService(...)` existed,
// were tested, and could not be imported by the one place entitled to call them.
// It declined to fix it on the grounds that an entry point nothing imports is
// dead surface, and named WIN-257 as the issue that could prove the export.
//
// `APPLICATION_ENTRY_PROJECTS` in `scripts/arch/gen-v1-skeleton.mjs` now
// publishes `./application/index.js` for the contexts this file ACTUALLY
// composes — two entries today, `identity-access` and `tenancy` — and
// `selfCheck` refuses an entry that is not an adopted context. So the surface is
// not dead: the imports below are the consumers that justify it.
//
// WHAT IS STILL OPEN, RESTATED AFTER WIN-258 M2.3. Both contexts are still
// composed from a supplied PORT BUNDLE rather than from an adapter — but the
// REASON has changed, and the three clauses that used to stand here are now
// false and are corrected rather than carried.
//
// WHAT IS NO LONGER TRUE. `postgres-tenancy` is not a generated placeholder: it
// holds a real `TenancyRepository` (tranche 1) and it also satisfies
// `IdentityAccessRepository` (tranche 2), `ToolsRepository`, `agents`' two
// canonical-store ports and `cost-monitoring`'s `BudgetRepository` (tranche 5).
// Each of those is a DECLARED binding — rows on the same directory — so there
// are TWENTY-TWO bindings across twelve directories and an identity store is
// among them. Tenancy's five other ports are not missing either: locks, a
// session revoker, an access-key revocation counter, an invitation token issuer
// and an operator directory are named properties of `PostgresTenancyAdapter`
// (tranche 3), and the kernel outbox has both its binding row and its write
// (tranche 4).
//
// AND THE FIVE NOW HAVE BINDING SLOTS TOO (WIN-258 M2.3). The clause that used
// to stand here said they did not, and that was the last true half of the three:
// they were satisfied by the adapter and unnamed by `ADAPTER_BINDINGS`, so
// `reportAdapterSupply` could not judge them. The decision it was left for is
// taken — ADR M0.3 §4 gains the five slots, on the SAME directory, because
// Amendment 15 already allows many bindings per directory and the binding table
// is the surface that proves every port has a satisfying adapter. Leaving five
// out did not make a smaller claim; it silently narrowed that completeness
// property to the ports that happened to be listed. They are proven through the
// PROPERTY that carries each — `PostgresTenancyAdapter["locks"]` and its four
// siblings — because asking whether the whole adapter extends `TenancyLocks`
// would resolve to `never` and fail a binding that holds.
//
// AND THAT LAST CLAUSE IS NOW FALSE TOO (WIN-267 T3), so it is corrected rather
// than carried. It used to read: "this root CONSTRUCTS no adapter. Nothing here
// calls `createPostgresTenancyAdapter`, so the wiring is proven by TYPE and by
// nothing at runtime." `constructAdapters` in `composition/adapter-bindings.ts`
// now opens the pool, builds the outbox over it, opens the Redis connection,
// parses the root key ring and builds the model router — from the validated
// configuration `main.ts` already had and was throwing away. Five of the
// thirteen directories are built; the other eight are still WIN-251's generated
// interfaces and cannot be, and every one of them reaches readiness with a cause
// saying which of those two it is.
//
// WHAT REMAINS OPEN, restated to the one sentence that is still true: TWO
// contexts are composed and only ONE of them can be composed from an adapter.
// `tenancy`'s six driven ports and its unit of work are all properties of one
// `PostgresTenancyAdapter`, so a database URL is the whole of what it needs;
// `identity-access` still takes a supplied bundle because four of its eight
// slots — a rate limiter, a secret hasher, a token minter, a TOTP verifier and a
// MFA cipher — are satisfied by no adapter directory in this tree.
// `composition/context-ports.ts` states that per context and is the file that
// assembles what CAN be assembled.
// ---------------------------------------------------------------------------

import type {
  Clock,
  CorrelationSource,
  EventBus,
  IdGenerator,
  Logger,
  RequestIdempotency,
  StreamJournal,
} from "@platos/kernel";

import type { IdentityAccessContract } from "@platos/context-identity-access";
import { createIdentityAccessService } from "@platos/context-identity-access/application/index.js";
import type { IdentityAccessPorts } from "@platos/context-identity-access/application/index.js";
import type { TenancyContract } from "@platos/context-tenancy";
import { createTenancyService } from "@platos/context-tenancy/application/index.js";
import type { TenancyDependencies } from "@platos/context-tenancy/application/index.js";
import type { SecretsContract, SecretsDependencies } from "@platos/context-secrets";
import { secretsContract } from "@platos/context-secrets";
import type { ProvidersContract, ProvidersDependencies } from "@platos/context-providers";
import { providersContract } from "@platos/context-providers";
import type { AgentsContract } from "@platos/context-agents";
import type { SkillsContract } from "@platos/context-skills";
import type { ToolsContract } from "@platos/context-tools";
import { toolsContract } from "@platos/context-tools";
import type { ToolsDependencies } from "@platos/context-tools";
import type { MemoryContract } from "@platos/context-memory";
import type { ChannelsContract } from "@platos/context-channels";
import type { FilesContract } from "@platos/context-files";
import type { ObservabilityContract } from "@platos/context-observability";
import type { CostMonitoringContract } from "@platos/context-cost-monitoring";
import type { GovernanceContract } from "@platos/context-governance";
import type { Judge } from "@platos/context-governance/application/ports/index.js";
import type { JobsContract } from "@platos/context-jobs";
import type { ConversationsContract } from "@platos/context-conversations";
import type { EventingContract } from "@platos/context-eventing";
import type { PrivacyContract } from "@platos/context-privacy";

import {
  ADAPTER_BINDINGS,
  type SuppliedAdapters,
  type UnwiredAdapter,
} from "./composition/adapter-bindings.js";
import { createProvidersJudge } from "./composition/governance-judge.js";
import { reportAdapterSupply, type AdapterSupplyReport } from "./composition/registry.js";
import type { CoreApiConfiguration } from "./config/schema.js";
import { correlationSource } from "./runtime/correlation.js";
import { createInFlightRegister, type InFlightRegister } from "./runtime/in-flight.js";

/** The seventeen published context surfaces, exactly as ADR M0.3 §4 names them. */
export interface ContextContracts {
  readonly identityAccess: IdentityAccessContract;
  readonly tenancy: TenancyContract;
  readonly secrets: SecretsContract;
  readonly providers: ProvidersContract;
  readonly agents: AgentsContract;
  readonly skills: SkillsContract;
  readonly tools: ToolsContract;
  readonly memory: MemoryContract;
  readonly channels: ChannelsContract;
  readonly files: FilesContract;
  readonly observability: ObservabilityContract;
  readonly costMonitoring: CostMonitoringContract;
  readonly governance: GovernanceContract;
  readonly jobs: JobsContract;
  readonly conversations: ConversationsContract;
  readonly eventing: EventingContract;
  readonly privacy: PrivacyContract;
}

/** What has actually been composed. See "WHY THE CONTEXTS ARE Partial" above. */
export type ComposedContexts = Partial<ContextContracts>;

/**
 * What every transport is handed. Transports read from it; they never reach past
 * it to an adapter, which is what keeps rule (j) true as M4 adds surfaces.
 */
export interface AppModule {
  readonly configuration: CoreApiConfiguration;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly adapters: SuppliedAdapters;
  readonly bindings: AdapterSupplyReport;
  /**
   * WIN-267 T3. Why each directory that holds no object holds none.
   *
   * `bindings.unsatisfied` says WHICH ports are unserved; this says WHY, and the
   * two answers are for different readers. An operator seeing
   * `postgres-tenancy:TenancyRepository` unsatisfied cannot tell a missing
   * `PLATOS_STORE_POSTGRES_URL` from an adapter that was never written, and those
   * have completely different responses. Empty when a caller composed without
   * constructing — which is every unit test in this package, and is why it is a
   * list rather than a claim that all thirteen were considered.
   */
  readonly unwired: readonly UnwiredAdapter[];
  readonly contexts: ComposedContexts;
  readonly inFlight: InFlightRegister;
  /**
   * The kernel `RequestIdempotency` port, resolved from whatever adapter carries
   * it — null when no install supplied one.
   *
   * IT IS A PORT HERE AND NOT AN ADAPTER, and that is rule (j) in the one place
   * it would otherwise be broken. The `Idempotency-Key` gate in `src/http/` needs
   * this store on every side-effecting request; reaching for
   * `adapters["redis-cache"].requests` would put an adapter's NAME in a
   * transport, and the day the store moved behind a different directory the
   * transport would move with it. Resolving it here is the composition root
   * doing its one job — and it is the only port lifted out of `adapters` because
   * it is the only one the EDGE consumes rather than a context.
   */
  readonly requestIdempotency: RequestIdempotency | null;
  /**
   * The kernel `StreamJournal` — the ordered, resumable frame log every stream
   * lane reads and writes. Null when no install supplied one.
   *
   * WIN-272 (M4.6). IT IS A PORT HERE, AND FOR EXACTLY THE REASON
   * `requestIdempotency` IS ONE: the EDGE consumes it rather than a context. A
   * stream transport reaching for `adapters["redis-streams"].journal` would put an
   * adapter's NAME in a transport, and rule (C8) refuses a transport that reads
   * `app.adapters` at all — so the day the journal moved behind a different
   * directory, every lane would move with it.
   *
   * AND IT IS WHY THE STREAM SURFACE CAN LAND BEFORE `conversations` CAN BE
   * COMPOSED. `UNIMPORTABLE_CONTEXT_FACTORIES` still names `conversations`, so no
   * route that needs the turn engine can be served here. A stream is fan-out of
   * frames somebody else produced, and the port it reads is kernel-hosted — which
   * is what makes this surface reachable now rather than after that list shortens.
   */
  readonly streamJournal: StreamJournal | null;
  /**
   * The kernel `EventBus` — the transient fan-out seam, published beside the
   * journal. Null when no install supplied one.
   *
   * IT IS PUBLISHED AND NOT YET CONSUMED HERE, AND THAT IS STATED RATHER THAN
   * LEFT TO BE DISCOVERED. `redis-streams` satisfies both kernel ports, and ADR
   * M0.3 §3 makes this one half of the reverse-edge inversion `channels` needs —
   * `CHANNELS_UNCOMPOSABLE` in `composition/context-ports.ts` names it. Handing it
   * out here is what lets that context be composed the day `durable-runtime` gains
   * a constructor, without the tranche that does it having to reopen this file.
   */
  readonly eventBus: EventBus | null;
  /**
   * The kernel `CorrelationSource` the process edge decided, published where an
   * install can hand it to an adapter.
   *
   * WIN-260 (M2.5) BUILT BOTH ENDS OF THIS SEAM AND JOINED NEITHER TO THE OTHER.
   * `runtime/correlation.ts` implements the port over `AsyncLocalStorage`;
   * `packages/adapters/postgres-tenancy` takes a `CorrelationSource | null` and
   * writes whatever it reports into PostgreSQL's session state for the
   * transaction, where a second connection reads it back off the committed row.
   * In between, every construction site in this repository passed that
   * parameter's DEFAULT — `null` — so the identifier the edge decided reached the
   * envelope, the log line, and nothing else. The port is a property of the
   * composed application for the same reason `requestIdempotency` is: a transport
   * or an install that reached into `src/runtime/` for it would be naming a
   * MODULE where it should name a PORT, and handing out ports is the composition
   * root's one job.
   *
   * It is not optional and has no null case. Correlation is ambient and the edge
   * always has an answer — `current()` returning null OUTSIDE a request is the
   * port's own way of saying "this work belongs to no request", which is why the
   * absence needs no second spelling here.
   */
  readonly correlation: CorrelationSource;
  /**
   * WIN-267 G1. `governance`'s `Judge` port, satisfied over the composed
   * `providers` contract — null until `providers` itself is composed.
   *
   * IT IS A PORT HERE FOR THE REASON `requestIdempotency` IS, AND FOR ONE MORE.
   * The shared reason is rule (j): whoever consumes it must name a PORT and not
   * a module. The extra one is that it CANNOT be an adapter, and
   * `composition/governance-judge.ts` measures why three separate ways — the
   * short version is that `ModelRouter` takes a credential its caller must
   * already hold and `Judge.ask` is handed none, so the only implementation
   * possible is one that asks the context that owns the keys.
   *
   * IT IS A SINGLE PORT AND NOT A BUNDLE, DELIBERATELY. `GovernanceDependencies`
   * names seventeen slots and this root can fill only some of them today;
   * `context-ports.ts`'s `GOVERNANCE_UNBOUND_PORTS` is the list of what is still
   * missing, and publishing a half-filled `governance` bundle would be the
   * façade-over-undefined-stores that `composeApplication` refuses everywhere
   * else. One satisfied port, published under its own name, is the honest shape
   * until the rest of that list is closed.
   */
  readonly governanceJudge: Judge | null;
}

/**
 * The driven ports an install supplies for a context this root can compose.
 *
 * It is separate from `SuppliedAdapters` because these are not adapters: an
 * adapter fills ONE declared binding and is validated against the twenty-two-slot
 * table, whereas a context takes a whole bundle — a repository, a hasher, a
 * minter — several of which have no declared adapter yet. Merging the two would
 * mean either inventing binding slots that ADR M0.3 §4 does not declare, or
 * letting `reportAdapterSupply` see keys it cannot judge.
 */
export interface SuppliedContextPorts {
  readonly identityAccess?: IdentityAccessPorts;
  /**
   * Tenancy's bundle is `TenancyDependencies` rather than a bare repository
   * because five of its six driven ports are not repositories: the row lock, the
   * session revoker, the access-key revocation counter, the invitation token
   * issuer and the operator directory. An install that supplied only a store
   * would produce a context that cannot serialise an owner demotion, which is
   * the one thing `changeMembershipRole` exists to guarantee.
   */
  readonly tenancy?: TenancyDependencies;
  /**
   * WIN-267. `secrets`' whole bundle, which needs no peer at all: two stores on
   * the ORM adapter, three cryptography ports on the key ring, and the kernel's
   * clock, ids and unit of work.
   */
  readonly secrets?: SecretsDependencies;
  /**
   * WIN-267. `providers`' bundle MINUS its two peers, and the subtraction is the
   * whole reason this type exists.
   *
   * `ProvidersDependencies` names `tenancy: TenancyContract` and
   * `secrets: SecretsPeer` — two CONTEXTS, not two adapters. Building contexts
   * is this file's job and `composition/context-ports.ts` deliberately holds no
   * context, so it hands over the eight slots that come from adapters, kernel
   * ports and published domain defaults, and `composeApplication` fills the last
   * two from the contracts it has just built. Every one of the ten is still
   * assigned BY NAME below; the split is about which file knows the value, not
   * about relaxing the convention.
   */
  readonly providers?: ProvidersAdapterPorts;
  /**
   * WIN-268 (M4.2) stage 2. `tools`' bundle MINUS its four peers.
   *
   * TWO OF ITS SEVEN SLOTS ARE SATISFIED BY NO ADAPTER DIRECTORY AND NEVER WILL BE.
   * `ToolDispatch` is an MCP client and ADR M0.3 §5.1 rule (h) homes
   * `@modelcontextprotocol/*` in `packages/contexts/tools/(adapters|transport)/`
   * alone, so it cannot be a `packages/adapters/` directory and cannot be a row of
   * `ADAPTER_BINDINGS`; `ContentDigest` is a synchronous host hash with no row.
   * `TOOLS_ROOT_SATISFIED_PORTS` in `composition/context-ports.ts` names both and
   * `installation.test.ts` reads the list back in both directions.
   */
  readonly tools?: ToolsAdapterPorts;
}

/** `ProvidersDependencies` without the two peers only this file can supply. */
export type ProvidersAdapterPorts = Omit<ProvidersDependencies, "tenancy" | "secrets">;

/**
 * `ToolsDependencies` without the FOUR peers only this file can supply.
 *
 * WIN-268 (M4.2) stage 2. The same subtraction `ProvidersAdapterPorts` makes and
 * the same reason for it, twice as wide: ADR M0.3 §1 row 7 permits `tools`
 * exactly `tenancy`, `identity-access`, `secrets` and `providers` plus the kernel,
 * and it genuinely calls all four. `composition/context-ports.ts` hands over the
 * seven slots it can name and `composeApplication` fills these four from the
 * contracts it has just built.
 */
export type ToolsAdapterPorts = Omit<
  ToolsDependencies,
  "tenancy" | "identityAccess" | "secrets" | "providers"
>;

export interface CompositionInput {
  readonly configuration: CoreApiConfiguration;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly adapters?: SuppliedAdapters;
  readonly ports?: SuppliedContextPorts;
  /** Carried through from `constructAdapters`; see `AppModule.unwired`. */
  readonly unwired?: readonly UnwiredAdapter[];
  readonly inFlight?: InFlightRegister;
  /**
   * Overridable so a suite can move the ambient identifier without an HTTP
   * request. Defaulted to the process edge's own, which is what every install
   * gets and what production must never have to remember to pass.
   */
  readonly correlation?: CorrelationSource;
}

/**
 * Raised when composition cannot proceed. Carries no configuration values: it is
 * rendered into a log line, and the redaction promise made in `config/load.ts`
 * would be worthless if the failure path leaked what the success path hides.
 */
export class CompositionFault extends Error {
  readonly faults: readonly string[];

  constructor(faults: readonly string[]) {
    super(`composition root refused to build: ${faults.length} fault(s)`);
    this.name = "CompositionFault";
    this.faults = Object.freeze([...faults]);
  }
}

export function composeApplication(input: CompositionInput): AppModule {
  const adapters = input.adapters ?? {};
  const bindings = reportAdapterSupply(adapters);
  if (bindings.faults.length > 0) throw new CompositionFault(bindings.faults);

  // Contexts are composed here as their ports become available. A context is
  // built ONLY from ports this call was actually handed: an absent bundle leaves
  // the context absent rather than producing a façade over undefined stores,
  // which would turn every authentication into a run-time crash instead of a
  // readiness signal a caller can see before it serves anything.
  const identityAccess =
    input.ports?.identityAccess === undefined
      ? undefined
      : createIdentityAccessService(input.ports.identityAccess);
  const tenancy =
    input.ports?.tenancy === undefined ? undefined : createTenancyService(input.ports.tenancy);
  const secrets =
    input.ports?.secrets === undefined ? undefined : secretsContract(input.ports.secrets);
  // WIN-267. `providers` is the FIRST context in this tree composed from two
  // PEERS as well as from adapters, and the order above is therefore load-bearing
  // in a way none of the others is: both peers must already exist as objects. It
  // is absent — rather than built over a half-filled bundle — the moment either
  // one is, because a `ProvidersContract` whose `secrets` handle was undefined
  // would refuse every runtime credential read at the first call instead of at
  // readiness, which is the whole distinction this root is built around.
  //
  // EVERY SLOT IS ASSIGNED BY NAME. `repository` and `probeCache` are both
  // reads, `modelRouter` and `probeCache` are both cache-shaped, and `clock` and
  // `ids` are two kernel ports of similar shape; a bundle assembled by spreading
  // one object over another would type-check with any of those transposed.
  const providers =
    input.ports?.providers === undefined || tenancy === undefined || secrets === undefined
      ? undefined
      : providersContract({
          repository: input.ports.providers.repository,
          modelRouter: input.ports.providers.modelRouter,
          probeCache: input.ports.providers.probeCache,
          clock: input.ports.providers.clock,
          ids: input.ports.providers.ids,
          unitOfWork: input.ports.providers.unitOfWork,
          policy: input.ports.providers.policy,
          catalogue: input.ports.providers.catalogue,
          secrets,
          tenancy,
        });
  // WIN-268 (M4.2) stage 2. `tools` — THE FIRST CONTEXT COMPOSED OVER FOUR PEERS,
  // and the last link in the chain the ORM register has been pointing at for five
  // tranches: `scripts/arch/mcp-store-ownership.mjs` computes that composing this
  // one context frees 35 sites, the largest single owner on the MCP surface.
  //
  // IT COMES AFTER `providers` AND THE ORDER IS LOAD-BEARING, more so than
  // `providers`' was. All four of its peers must already be objects, and one of
  // them — `providers` — is itself built from two of the others, so this is the
  // second rank of a two-rank composition rather than the first. It is ABSENT the
  // moment any peer is, rather than built over a half-filled bundle, for the
  // reason every context above it is: a `ToolsContract` whose `secrets` handle was
  // undefined would refuse every credential read at the first dispatch instead of
  // at readiness.
  //
  // EVERY SLOT IS ASSIGNED BY NAME. `repository` and `dispatch` are both async
  // interfaces, `clock` and `ids` are two kernel ports of similar shape, and the
  // four peers are four objects with a `name` property apiece — a spread would
  // type-check with `identityAccess` and `tenancy` transposed, and the sign of it
  // would be an MCP caller authenticated against the tenant tree.
  const tools =
    input.ports?.tools === undefined ||
    tenancy === undefined ||
    identityAccess === undefined ||
    secrets === undefined ||
    providers === undefined
      ? undefined
      : toolsContract({
          repository: input.ports.tools.repository,
          dispatch: input.ports.tools.dispatch,
          digest: input.ports.tools.digest,
          clock: input.ports.tools.clock,
          ids: input.ports.tools.ids,
          unitOfWork: input.ports.tools.unitOfWork,
          policy: input.ports.tools.policy,
          tenancy,
          identityAccess,
          secrets,
          providers,
        });
  const contexts: ComposedContexts = Object.freeze({
    ...(identityAccess === undefined ? {} : { identityAccess }),
    ...(tenancy === undefined ? {} : { tenancy }),
    ...(secrets === undefined ? {} : { secrets }),
    ...(providers === undefined ? {} : { providers }),
    // AFTER `providers` in the literal as well as in the code, because
    // `mcp-store-ownership.mjs` reads THIS OBJECT by AST to decide which contexts
    // are composed, and `ContextContracts`' own declaration order is what
    // `process.test.ts` asserts `detail.composedContexts` against.
    ...(tools === undefined ? {} : { tools }),
  });

  return Object.freeze({
    configuration: input.configuration,
    clock: input.clock,
    ids: input.ids,
    logger: input.logger,
    adapters: Object.freeze({ ...adapters }),
    bindings,
    unwired: Object.freeze([...(input.unwired ?? [])]),
    contexts,
    inFlight: input.inFlight ?? createInFlightRegister(),
    // `?? null` rather than leaving it undefined: the gate has to be able to see
    // that the port is ABSENT and fail closed, and an undefined property reads
    // the same as one nobody wired.
    requestIdempotency: adapters["redis-cache"]?.requests ?? null,
    // The SAME `?? null` and the same reason: readiness has to be able to see the
    // port is ABSENT, and an undefined property reads the same as one nobody
    // wired. The adapter object IS the `EventBus` and CARRIES the journal, which
    // is the shape `ADAPTER_BINDINGS` declared before this tranche and after it.
    streamJournal: adapters["redis-streams"]?.journal ?? null,
    eventBus: adapters["redis-streams"] ?? null,
    correlation: input.correlation ?? correlationSource,
    // WIN-267 G1. Built from the contract rather than from a bundle, and
    // therefore built HERE: `context-ports.ts` holds no context by design, and
    // this port's only possible implementation is one that asks `providers`.
    // Null when `providers` is absent, for the reason every context above is
    // absent when its ports are — a judge over an undefined contract would fail
    // at the first score instead of at readiness.
    governanceJudge:
      providers === undefined
        ? null
        : createProvidersJudge({ providers, logger: input.logger }),
  });
}

/** How many bindings the architecture declares. Used by readiness and by tests. */
export const DECLARED_BINDING_COUNT = ADAPTER_BINDINGS.length;
