// Everything a turn asks its peers for, between admission and the model call.
//
// SEVEN PEER CALLS, EACH THROUGH A NARROW PORT, AND NOT ONE STORE READ AMONG
// THEM. That is the shape ADR M0.3 §1 row 16 asks for — "orchestrates a turn
// purely through downstream ports" — and it is the difference between this file
// and the 1,891-line method it replaces, which reads `Thread`, `AgentBinding`,
// `AgentVersion` and `User` directly, the last of those with no tenancy filter
// at all.
//
// THE ORDER IS THE COST ORDER: the cheap refusals first, and nothing that costs
// money until every one of them has passed.
//
//   1. THE VERSION. `agents.selectVersion` draws the canary. The DRAW is a
//      parameter of the command, not something generated here — `agents`
//      requires that, and it is what makes a canary split reproducible in a
//      test instead of flaky in one.
//   2. THE ROUTE. `agents.resolveRoute` answers the model string and the
//      provider key. This context chooses neither and stores both.
//   3. THE BUDGET. `cost-monitoring.guardSpend` is the last refusal before
//      spending, and it is the only peer method that takes a SCOPE rather than
//      a grant, because a turn has no operator grant to offer.
//   4. THE ATTACHMENTS. Four ceilings, before a byte is looked at.
//   5. THE TRANSCRIPT. Read from this context's own rows — the one store read,
//      and it is of a row this context owns.
//   6. THE SURFACE. `skills.composeRuntime` plus `tools.findTools`.
//   7. THE MEMORY. `memory.retrieveContext`, and it is the ONE call here whose
//      failure is not fatal.
//
// MEMORY IS THE ONLY SOFT FAILURE, AND IT IS SOFT ON PURPOSE. Retrieval is an
// enrichment: a turn without it answers a little worse, and a turn refused
// because a vector store was slow answers not at all. The source races it
// against a five-second timeout and swallows every rejection; the same decision
// is made here, in one visible branch, and the drop is LOGGED so "it was skipped"
// and "it was empty" are distinguishable in a way they are not in the source.
// Everything else fails the turn, because a turn without its route, its budget
// clearance or its tools is not a degraded turn but a wrong one.

import { err, ok, zero, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  admitAttachments,
  buildTranscript,
  budgetExhausted,
  type AttachmentCandidate,
  type ProviderKeyId,
  type Thread,
  type Transcript,
  type Turn,
  type VersionBucket,
} from "../domain/index.js";
import type { ConversationsDependencies } from "./dependencies.js";
import { renderMemoryBlock } from "./turn-prompt.js";
import { composeTurnSurface, type ComposedTurnSurface } from "./turn-tools.js";

export interface PreparationRequest {
  readonly authorization: unknown;
  readonly scope: EnvironmentScope;
  readonly thread: Thread;
  readonly userText: string;
  /** A draw in `[0, 1)`, supplied by the composition root. Never drawn here. */
  readonly canaryDraw: number;
  readonly attachments: readonly AttachmentCandidate[];
  readonly environmentSkillIds: readonly string[];
  readonly basePrompt: string;
  readonly toolQuery: string;
}

export interface PreparedTurn {
  readonly agentVersionId: string;
  readonly versionBucket: VersionBucket;
  readonly model: string;
  readonly providerKeyId: ProviderKeyId | null;
  readonly transcript: Transcript;
  readonly attachments: readonly AttachmentCandidate[];
  readonly surface: ComposedTurnSurface;
  readonly memoryBlock: string | null;
}

export async function prepareTurn(
  dependencies: ConversationsDependencies,
  request: PreparationRequest,
): Promise<Result<PreparedTurn>> {
  const version = await dependencies.agents.selectVersion({
    authorization: request.authorization,
    agentId: request.thread.agentId,
    threadId: request.thread.threadId,
    draw: request.canaryDraw,
  });
  if (!version.ok) return err(version.error);

  const route = await dependencies.agents.resolveRoute({
    authorization: request.authorization,
    agentId: request.thread.agentId,
  });
  if (!route.ok) return err(route.error);

  const guard = await dependencies.costMonitoring.guardSpend({
    scope: request.scope,
    intent: { tier: "llm", skillSlug: null, agentId: request.thread.agentId },
    amount: zero(),
    context: { agentId: request.thread.agentId, userId: request.thread.endUserId },
  });
  if (!guard.ok) return err(guard.error);
  if (!guard.value.allowed) return err(budgetExhausted(guard.value.refusal.label));

  const attachments = admitAttachments(
    request.thread.threadId,
    request.attachments,
    dependencies.policy.attachment,
  );
  if (!attachments.ok) return err(attachments.error);

  const transcript = await readTranscript(dependencies, request.scope, request.thread);
  if (!transcript.ok) return err(transcript.error);

  const surface = await composeTurnSurface(dependencies, {
    authorization: request.authorization,
    scope: request.scope,
    agentId: request.thread.agentId,
    environmentSkillIds: request.environmentSkillIds,
    basePrompt: request.basePrompt,
    toolQuery: request.toolQuery,
  });
  if (!surface.ok) return err(surface.error);

  return ok({
    agentVersionId: String(version.value.versionId),
    versionBucket: version.value.bucket as VersionBucket,
    model: route.value.model,
    providerKeyId: route.value.providerKeyId === null ? null : (route.value.providerKeyId as ProviderKeyId),
    transcript: transcript.value,
    attachments: attachments.value.candidates,
    surface: surface.value,
    memoryBlock: await retrieveMemory(dependencies, request),
  });
}

/**
 * The history, read through this context's own rows.
 *
 * A fork's inherited prefix is resolved only when there is no compaction cursor,
 * because a compacted fork's summary already stands for its ancestry —
 * `transcript.ts` states the rule and this is where the second query it implies
 * is either made or skipped.
 */
async function readTranscript(
  dependencies: ConversationsDependencies,
  scope: EnvironmentScope,
  thread: Thread,
): Promise<Result<Transcript>> {
  const own = await dependencies.turns.readTranscriptTurns(
    scope,
    thread.threadId,
    0,
    dependencies.policy.thread.maxPageSize,
  );
  if (!own.ok) return err(own.error);

  const compactedUpToSequence =
    thread.compactedUpToTurnId === null
      ? 0
      : (own.value.find((turn) => turn.turnId === thread.compactedUpToTurnId)?.sequence ?? 0);

  const skipInherited = compactedUpToSequence > 0 || thread.forkedTurnIds.length === 0;
  const inherited = skipInherited
    ? ok<readonly Turn[]>([])
    : await dependencies.threads.findInheritedTurns(scope, thread.forkedTurnIds);
  if (!inherited.ok) return err(inherited.error);

  const counts = await dependencies.turns.countToolCalls(
    scope,
    own.value.map((turn) => turn.turnId),
  );
  if (!counts.ok) return err(counts.error);

  return ok(
    buildTranscript(
      {
        thread,
        inheritedTurns: inherited.value,
        ownTurns: own.value,
        compactedUpToSequence,
        maxEntries: dependencies.policy.thread.maxPageSize,
      },
      counts.value,
    ),
  );
}

/**
 * Retrieved memory, or nothing.
 *
 * THE ONE SOFT FAILURE IN THIS FILE. A refusal is logged and answered as `null`,
 * so the turn runs without the enrichment rather than not at all. The log line
 * is what makes "skipped" distinguishable from "empty", which the source's bare
 * `catch {}` does not.
 */
async function retrieveMemory(
  dependencies: ConversationsDependencies,
  request: PreparationRequest,
): Promise<string | null> {
  const retrieved = await dependencies.memory.retrieveContext({
    authorization: request.authorization,
    query: request.userText,
    requestedAgentIds: [request.thread.agentId],
    limit: null,
    minScore: null,
  });
  if (!retrieved.ok) {
    dependencies.logger.log("warn", "conversations.memory.skipped", {
      threadId: request.thread.threadId,
      code: retrieved.error.code,
    });
    return null;
  }
  return renderMemoryBlock(retrieved.value.memories.map((recalled) => recalled.memory.content));
}
