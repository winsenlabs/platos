// The published surface of the `conversations` context.
//
// ADR M0.3 §2: another context may import THIS entrypoint and nothing else —
// never `domain/`, never `application/`, never an adapter.
//
// EXCEPT THAT NO CONTEXT MAY IMPORT IT AT ALL. §1 row 16 makes `conversations`
// the deepest node in the DAG and states the rule in as many words: "every
// reverse/fan-out flow leaves as a domain event or a durable job, so NO context
// imports conversations." `audit:arch-boundaries` enforces both halves — the
// eleven edges out, and the zero edges in. So the readers of this module are the
// composition root and the transports it wires, and the way anything else learns
// what happened in a turn is `CONVERSATIONS_EVENT_NAMES`.
//
// THAT IS WHY THE EVENT LIST IS PART OF THE SURFACE AND NOT AN INTERNAL DETAIL.
// `cost-monitoring` learns what a turn cost from `conversations.turn.settled`;
// `governance` keys its ratings off a turn it never called this context to
// learn about; `observability` projects from the same stream. Each of those was
// an inbound call in the extraction source and each is a name on that list now.
//
// IT CARRIES NO IMPLEMENTATION. Everything below is a type or a value with no
// behaviour — the error codes, the event names, the four status and bucket
// vocabularies as frozen arrays, and the shipped policy as a frozen object. All
// of them come from `domain/`, which imports nothing but the kernel, so
// importing this module cannot drag a use case, a port or a peer contract across
// a boundary with it.
//
// THE FOUR ROWS ARE PUBLISHED AS THEMSELVES, NOT AS VIEWS. `Thread`, `Turn`,
// `Step` and `PostmanExecution` are flat, immutable records in which every field
// is a column this context owns. A mapping layer over them would be a place for
// a field to be silently dropped — the defect `agents` names on
// `AgentConfigurationView` — in exchange for nothing. Where a rollup IS a
// different shape from a row it has its own type: `TurnCost` and `Transcript`.
//
// WHAT THIS SURFACE DELIBERATELY WITHHOLDS.
//
//   * NO SPEND LEDGER WRITE. A turn's exact cost travels on
//     `conversations.turn.settled` as a canonical `Decimal(18, 6)` cent string.
//     `Budget` and the cost tables are `cost-monitoring`'s rows (§1 row 13) and
//     this context is neither their writer nor permitted to call the method that
//     writes them from inside a turn. The extraction source calls
//     `CostService.recordUsage`, `recordUserSpend` and a Prometheus fan-out from
//     inside the request; all three are the edge this replaces.
//
//   * NO TOOL AUDIT WRITE. `ToolCallAudit` is `tools`' row (§1 row 12).
//     `tools.executeTool` writes it as part of running the tool, and this
//     context never reaches across to write another context's table.
//
//   * NO META-TOOL DEFINITIONS. The source's `buildMetaTools` defines thirty-odd
//     tools inline whose handlers read `Memory`, dispatch `Job` and write
//     `ToolCallAudit`. `domain/tool-catalogue.ts` records where each one went;
//     the catalogue here is ASSEMBLED from the contexts that own them.
//
//   * NO END-USER AUTHENTICATION. `identity-access` is not on this context's
//     row-16 allow-list, so the end user on a runtime command is an assertion
//     made by the transport that authenticated the session. What this context
//     checks is that the asserted user OWNS the thread.
//     `application/authorization.ts` states the limit rather than hiding it.

// The identifier vocabulary a caller needs to build a command. Branded, so a
// `TurnId` cannot reach a `ThreadId` parameter across the boundary any more than
// it can inside it.
export type {
  ActorId,
  AgentId,
  AgentVersionId,
  ClusterId,
  EndUserId,
  IdempotencyKey,
  ModelPriceId,
  PostmanContextHandle,
  PostmanExecutionId,
  PostmanTemplateId,
  ProviderKeyId,
  StepId,
  ThreadId,
  ToolCallId,
  TurnId,
} from "../domain/index.js";
export { asConversationsIdentifier } from "../domain/index.js";

// The four owned rows, and the vocabularies they are written in.
export type {
  PostmanExecution,
  SessionContext,
  Step,
  StepRate,
  StepRateBook,
  StepRateName,
  StepUsage,
  Thread,
  ThreadCompactionState,
  Turn,
  TurnCost,
  VersionBucket,
  WorkStatus,
} from "../domain/index.js";

export {
  CONVERSATIONS_ERROR_CODES,
  CONVERSATIONS_EVENT_NAMES,
  RATE_SOURCES,
  STEP_RATE_NAMES,
  TERMINAL_WORK_STATUSES,
  THREAD_COMPACTION_STATES,
  VERSION_BUCKETS,
  WORK_STATUSES,
  PRIMARY_STEP_SEQUENCE,
} from "../domain/index.js";

export type { ConversationsErrorCode, ConversationsEventName } from "../domain/index.js";

// Policy, published so the composition root can move a ceiling or throw either
// kill switch without reaching into this package for the shape of one.
export type {
  AttachmentPolicy,
  CompactionPolicy,
  ConversationsPolicy,
  SubAgentPolicy,
  ThreadPolicy,
  TurnPolicy,
} from "../domain/index.js";
export { DEFAULT_CONVERSATIONS_POLICY } from "../domain/index.js";

// The rollups and reading models that are genuinely a different shape from a row.
export type {
  AttachmentCandidate,
  CompactionPlan,
  DelegationChain,
  ForkPlan,
  OfferedTool,
  ToolCatalogue,
  ToolSource,
  Transcript,
  TranscriptEntry,
  TranscriptRole,
} from "../domain/index.js";
export { META_TOOL_OWNERS, TOOL_SOURCES } from "../domain/index.js";

// Commands and queries, from the use cases that define them.
export type {
  CompactThreadCommand,
  CompactionQueued,
  CompleteCompactionCommand,
} from "../application/compact-thread.js";
export type {
  DescribePostmanQuery,
  LaunchPostmanCommand,
  LaunchedPostman,
  SettlePostmanCommand,
} from "../application/execute-postman.js";
export type { ForkThreadCommand } from "../application/fork-thread.js";
export type {
  DescribeThreadQuery,
  DescribeTurnQuery,
  InspectThreadQuery,
  OpenThreadCommand,
  PageThreadsQuery,
  PageTurnsQuery,
  TurnTrace,
} from "../application/manage-threads.js";
export type { RanTurn, RunTurnCommand } from "../application/run-turn.js";
export type {
  AgentsPeer,
  ConversationsDependencies,
  CostMonitoringPeer,
  FilesPeer,
  JobsPeer,
  MemoryPeer,
  ProvidersPeer,
  SkillsPeer,
  TenancyPeer,
  ToolsPeer,
} from "../application/dependencies.js";
export { conversationsDependencies } from "../application/dependencies.js";
export type { SecretsRuntimeGrant, TenancyOperatorGrant } from "../application/authorization.js";
export { CONVERSATIONS_ERASURE_TARGET_NAME } from "../application/conversations-erasure-target.js";

// The capability itself, and the binder the composition root calls.
export type { ConversationsAggregate, ConversationsContract } from "../application/conversations-contract.js";
export { createConversationsContract } from "../application/conversations-contract.js";
