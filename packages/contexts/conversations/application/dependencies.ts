// What every use case in this context is constructed with.
//
// One frozen bundle rather than twenty constructor parameters — the source's
// `AgentService` takes fifteen, twelve of them `@Optional()`, which is how "the
// feature is off" and "the wiring is broken" became the same state.
//
// TIME, IDENTITY AND RANDOMNESS ARE INPUTS. `clock` and `ids` are kernel ports;
// nothing in this package reaches for the wall clock, `Math.random` or
// `randomUUID`. That is what makes a postman handle's expiry, a turn's latency
// and a canary draw reproducible at any instant, and it is why every window here
// can be pinned to the millisecond instead of tolerated within a range. The
// canary DRAW in particular is a parameter of the command rather than something
// this context generates, exactly as `agents` requires.
//
// ---------------------------------------------------------------------------
// EVERY PEER IS A NARROW PORT THIS CONTEXT OWNS, AND HERE IS THE MEASURED REASON
// ---------------------------------------------------------------------------
//
// `agents` declares `SkillsPeer`; `memory` declares `ProvidersPeer`. Both exist
// because a handle typed as a neighbour's ENTIRE published surface makes every
// in-memory double in the package a hostage to all of it. That is not
// hypothetical here — it is this issue's own history. The prerequisite that put
// the inference surface on the `ModelRouter` grew `ProvidersContract` by
// `runModelGeneration` and `streamModelGeneration`, and broke `build:v1` inside
// `memory`, a context that calls neither and never had.
//
// This context depends on ELEVEN peers. A double implementing eleven whole
// contracts would be several thousand lines of refusals and would break every
// time any of the eleven grew a method. So each peer below is a port named here,
// carrying only the members this context actually calls, with the query and
// result types taken by INDEXED ACCESS off the published contract rather than
// restated — narrowing which methods this context depends on does not licence it
// to redeclare a neighbour's vocabulary. The real contracts satisfy these
// structurally, so the composition root passes the published surfaces through
// unchanged and writes no adapter to do it.
//
// The count is the argument: 11 peers, 17 methods.

import type { Clock, IdGenerator, Logger, OutboxWriter, UnitOfWork } from "@platos/kernel";
import type { AgentsContract } from "@platos/context-agents";
import type { CostMonitoringContract } from "@platos/context-cost-monitoring";
import type { FilesContract } from "@platos/context-files";
import type { JobsContract } from "@platos/context-jobs";
import type { MemoryContract } from "@platos/context-memory";
import type { ProvidersContract } from "@platos/context-providers";
import type { SkillsContract } from "@platos/context-skills";
import type { TenancyContract } from "@platos/context-tenancy";
import type { ToolsContract } from "@platos/context-tools";

import type { ConversationsPolicy } from "../domain/index.js";
import type {
  ConversationsErasureStore,
  PostmanRepository,
  ThreadRepository,
  TurnRepository,
} from "./ports/index.js";

/**
 * The whole of `agents` a turn needs: which version answers, and on what route.
 *
 * `selectVersion` is the canary draw — the axis every later judgement is drawn
 * along, and the reason `Turn.agentVersionId` and `Turn.versionBucket` are
 * columns. `resolveRoute` answers the model string and the provider key that
 * pays for it. `describeAgent` is how a turn learns its own configuration, and
 * `describeTemplate` is the saved request a postman execution was launched from.
 * `AgentsContract` is thirty-odd methods wider; every other one is somebody
 * else's business to call.
 */
export interface AgentsPeer {
  readonly name: "agents";
  readonly describeAgent: AgentsContract["describeAgent"];
  readonly selectVersion: AgentsContract["selectVersion"];
  readonly resolveRoute: AgentsContract["resolveRoute"];
  readonly describeTemplate: AgentsContract["describeTemplate"];
}

/**
 * The whole of `skills` a turn needs: the composed prompt block and its tools.
 *
 * ONE METHOD. `composeRuntime` already joins the base prompt to the skill blocks
 * and answers the tool list with the skipped ones named, which is precisely the
 * shape a turn needs and precisely what the source rebuilds by hand across
 * ninety lines in two divergent copies.
 */
export interface SkillsPeer {
  readonly name: "skills";
  readonly composeRuntime: SkillsContract["composeRuntime"];
}

/**
 * The whole of `tools` a turn needs: what may be offered, and running one.
 *
 * `executeTool` is the tool half of the turn loop and it carries the four-tier
 * gate with it. This context does not re-implement that gate, does not read the
 * tool registry, and never writes `ToolCallAudit` — all three are row 12's, and
 * an audit written from here would be a second writer of somebody else's table.
 */
export interface ToolsPeer {
  readonly name: "tools";
  readonly findTools: ToolsContract["findTools"];
  readonly executeTool: ToolsContract["executeTool"];
}

/**
 * The whole of `memory` a turn needs: the context to put in front of the model.
 *
 * ONE METHOD, and it is the READ. Writing a memory is a tool the model calls,
 * and it reaches `memory` through `tools` like every other tool — this context
 * neither writes `Memory` nor is permitted to.
 */
export interface MemoryPeer {
  readonly name: "memory";
  readonly retrieveContext: MemoryContract["retrieveContext"];
}

/**
 * The whole of `providers` a turn needs: the generation, and what it cost.
 *
 * THIS IS THE INFERENCE SEAM AND IT IS THE REASON THIS CONTEXT IS EXTRACTABLE.
 * `inference-sdk-only` bans `ai` and `@ai-sdk/*` outside
 * `packages/adapters/model-router-providers/`, so a turn cannot be run by
 * importing a framework; it is run by asking here. `priceModelUsage` is the
 * other half — one implementation of `tokens x rate`, on the side of the
 * boundary that owns the rate card.
 */
export interface ProvidersPeer {
  readonly name: "providers";
  readonly runModelGeneration: ProvidersContract["runModelGeneration"];
  readonly streamModelGeneration: ProvidersContract["streamModelGeneration"];
  readonly priceModelUsage: ProvidersContract["priceModelUsage"];
}

/**
 * The whole of `files` a turn needs: what an attachment is.
 *
 * `describeAttachment` answers a row's size, media type and which thread it
 * hangs off. `attachment.ts` decides whether it may enter this turn's prompt;
 * `files` decides everything else about it, and owns every byte.
 */
export interface FilesPeer {
  readonly name: "files";
  readonly describeAttachment: FilesContract["describeAttachment"];
}

/**
 * The whole of `cost-monitoring` a turn needs: may this spend proceed.
 *
 * ONE METHOD, AND IT IS THE ONLY ONE THAT TAKES A SCOPE RATHER THAN A GRANT —
 * because a turn has no operator grant to offer. The ledger WRITE is not here
 * and must not be: `conversations.turn.settled` carries the usage and the cost,
 * and `cost-monitoring` subscribes. That inversion is what keeps this context a
 * DAG sink; calling `recordTurn` from inside a turn is the edge it removes.
 */
export interface CostMonitoringPeer {
  readonly name: "cost-monitoring";
  readonly guardSpend: CostMonitoringContract["guardSpend"];
}

/**
 * The whole of `jobs` a turn needs: durable work, and a human decision.
 *
 * `execute` is where a turn's fan-out goes when it must outlive the request —
 * compaction, a delegated run, a scheduled dispatch. `requestApproval` is the
 * suspension seam: a tool that needs a person parks on an `AgentApproval` rather
 * than blocking a socket, which is what the source's Redis `BLPOP` on a
 * duplicated connection is doing.
 */
export interface JobsPeer {
  readonly name: "jobs";
  readonly execute: JobsContract["execute"];
  readonly requestApproval: JobsContract["requestApproval"];
}

/**
 * The whole of `tenancy` a turn needs: is this grant real, and does it reach.
 *
 * `verifyAuthorization` is an IDENTITY check against tenancy's own mint
 * register, not a shape check, so a literal is always refused. That property is
 * the entire value of the method and it is why this context never builds a grant
 * of its own.
 */
export interface TenancyPeer {
  readonly name: "tenancy";
  readonly verifyAuthorization: TenancyContract["verifyAuthorization"];
  readonly scopeContains: TenancyContract["scopeContains"];
}

export interface ConversationsDependencies {
  readonly threads: ThreadRepository;
  readonly turns: TurnRepository;
  readonly postman: PostmanRepository;
  readonly erasureStore: ConversationsErasureStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly unitOfWork: UnitOfWork;
  readonly outbox: OutboxWriter;
  readonly logger: Logger;
  readonly policy: ConversationsPolicy;
  readonly agents: AgentsPeer;
  readonly skills: SkillsPeer;
  readonly tools: ToolsPeer;
  readonly memory: MemoryPeer;
  readonly providers: ProvidersPeer;
  readonly files: FilesPeer;
  readonly costMonitoring: CostMonitoringPeer;
  readonly jobs: JobsPeer;
  readonly tenancy: TenancyPeer;
}

export function conversationsDependencies(
  dependencies: ConversationsDependencies,
): ConversationsDependencies {
  return Object.freeze({ ...dependencies });
}
