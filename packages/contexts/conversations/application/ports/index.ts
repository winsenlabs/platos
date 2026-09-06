// The driven ports this context owns, published for the adapters that implement
// them (ADR M0.3 §13).
//
// FOUR PORTS AND NOT ONE MORE. Every other collaborator a turn needs — the model,
// the tools, the memory, the budget, the files, the durable seam — belongs to a
// context this one is permitted to depend on, and is reached through that
// context's published CONTRACT rather than through a port declared here. A fifth
// port named `ModelPort` or `ToolExecutorPort` would be this context re-declaring
// a neighbour's surface, and would give the composition root a second thing to
// wire where the ADR gives it one.
//
// THAT IS WHY `inference-sdk-only` IS SATISFIABLE AT ALL. The turn engine's
// inference seam is `providers`' `ModelRouter`, published on `providers`'
// contract as `runModelGeneration` and `streamModelGeneration`. This context asks
// for a generation; it does not own the port that performs one, and it names no
// vendor type anywhere.
//
// `application/index.js` IS NOT A PUBLISHED ENTRYPOINT. `package.json` exports
// exactly two subpaths — the contracts barrel and this one — so anything an
// adapter needs must be reachable from here and anything a peer needs must be
// reachable from `contracts/`.

export type {
  ThreadPage,
  ThreadPageQuery,
  ThreadRepository,
} from "./thread-repository.js";

export type {
  TurnPage,
  TurnPageQuery,
  TurnRepository,
  TurnWithSteps,
} from "./turn-repository.js";

export type {
  PostmanPage,
  PostmanPageQuery,
  PostmanRepository,
} from "./postman-repository.js";

export type {
  ConversationsErasureStore,
  ErasureCensus,
} from "./erasure-store.js";

// The refusals an adapter is expected to translate its store's errors into.
// Published from here rather than from `contracts/` for the reason `providers`
// gives of its own: these are adapter-facing, and a peer context has no business
// constructing this context's infrastructure errors.
export { queueUnavailable, repositoryUnavailable } from "../../domain/index.js";

// ---------------------------------------------------------------------------
// WIN-258 T5 — THE VOCABULARY THE FOUR SIGNATURES ABOVE ARE WRITTEN IN
// ---------------------------------------------------------------------------
//
// Everything below is republished rather than newly declared, and it is here
// for the reason `governance`'s and `secrets`' port entry points republish
// theirs: `package.json` publishes exactly TWO subpaths, and the one an adapter
// is entitled to import is this one. Before this block the four ports were
// nameable from here and the twenty-odd types their methods take and answer
// were not — a `ThreadRepository` an adapter could declare it implements and
// could not write a single method of, because `Thread`, `ThreadId`,
// `EnvironmentScope` and `Result` were all reachable only through the CONTRACTS
// barrel, which is the PEER-facing door.
//
// That is the same defect WIN-258 T2 found as `EndUserStore` and T3 as
// `SessionRevocationOrder`, one level down: there the port itself was
// unnameable, here its vocabulary was. Reaching for `@platos/kernel` or for
// `../../domain/index.js` from the adapter instead would have been a second
// import edge out of a package whose only declared dependency is the context
// whose ports it satisfies, and importing the contracts barrel would have made
// the adapter a PEER of the context it implements.
//
// NOTHING NEW IS PUBLISHED. Every name below is already on `contracts/index.ts`
// or on `@platos/kernel`; this widens the door an adapter comes through, and
// `contracts/index.test.ts` still pins what a peer sees.
export type {
  DomainError,
  EnvironmentScope,
  JsonValue,
  Money,
  Result,
  TransactionScope,
} from "@platos/kernel";
export {
  asIdentifier,
  err,
  money,
  moneyFromCentsString,
  moneyToCentsString,
  ok,
  sum,
  zero,
} from "@platos/kernel";

export type {
  ActorId,
  AgentId,
  AgentVersionId,
  ClusterId,
  EndUserId,
  IdempotencyKey,
  ModelPriceId,
  PostmanContextHandle,
  PostmanExecution,
  PostmanExecutionId,
  PostmanTemplateId,
  RateSource,
  SessionContext,
  Step,
  StepId,
  StepRate,
  StepRateBook,
  StepRateName,
  StepUsage,
  Thread,
  ThreadCompactionState,
  ThreadId,
  Turn,
  TurnCost,
  TurnId,
  VersionBucket,
  WorkStatus,
} from "../../domain/index.js";

// The VALUES an adapter needs, and every one of them is load-bearing rather
// than convenience. `rollUpTurnCost` and `sumStepUsage` are the sharpest: the
// canonical `Turn` row stores `costCents` and NOTHING ELSE of a turn's money,
// while `Turn.cost` carries a step count, an unpriced count and a completeness
// flag and `Turn.usage` carries five token figures that have no columns at all.
// A store that invented those six numbers on the way out would be answering a
// question the database cannot answer; a store that recomputed them with
// arithmetic of its own would be the SECOND implementation of a rollup this
// context exists to have exactly one of. So the rollup crosses the port, and
// `conversations-rows.ts` calls it over the step rows it read.
export {
  asConversationsIdentifier,
  isWorkStatus,
  postmanNotFound,
  PRIMARY_STEP_SEQUENCE,
  RATE_SOURCES,
  rollUpTurnCost,
  STEP_RATE_NAMES,
  stepSequenceTaken,
  sumStepUsage,
  THREAD_COMPACTION_STATES,
  threadNotFound,
  turnNotFound,
  turnSequenceTaken,
  VERSION_BUCKETS,
  WORK_STATUSES,
} from "../../domain/index.js";
