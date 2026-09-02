// Use case: extraction — a finished conversation becomes durable memories.
//
// ADR M0.3 §1 row 8 states the boundary in the row itself: extraction is
// initiated on a `TurnFinalized` event and this context "never imports
// conversations". So the command below carries a TRANSCRIPT and a list of ids,
// assembled by the composition root's event handler, and there is no thread
// lookup, no message model and no turn-engine type anywhere in this file.
//
// THE PER-AGENT POLICY ARRIVES AS OPAQUE JSON FOR THE SAME REASON. It is stored
// on an agent version's `memoryConfig`, and `agents` is not on this context's
// allow-list. The handler reads it and passes the value through;
// `resolveExtractionPolicy` treats it as the operator input it is, clamping
// every field independently so one bad number does not discard four good ones.
//
// THE ORDER OF WORK IS CHOSEN SO THAT NOTHING IS PAID FOR TWICE.
//
//   1. THE POLICY GATE, which is free.
//   2. THE WATERMARK, which is one cache read and is what stops an unchanged
//      thread from being handed to a model at all. It is an OPTIMISATION: the
//      store's unique index is what actually makes extraction idempotent, so a
//      cache that lost every key costs money and changes no outcome.
//   3. THE MESSAGE FLOOR, also free.
//   4. THE JUDGE, which is the one call that costs anything.
//   5. PRICING, through `providers`. Attribution happens whether or not the
//      envelope parsed: the spend was incurred at step 4, and a failed parse
//      must not make it invisible.
//   6. ENTITIES BEFORE MEMORIES, because a memory's `metadata.entities` names
//      the nodes it belongs to and the nodes have to exist to be named.
//   7. RELATIONSHIPS LAST, and only between endpoints this run actually created
//      or found. A judge that hallucinated an endpoint produces no edge rather
//      than an edge to nothing.
//
// A CANDIDATE THE JUDGE PROPOSED IS STILL ADMITTED LIKE ANY OTHER MEMORY. Each
// one goes through `remember`, which re-applies the kind rules, the visibility
// rules and the provenance rules. The only privilege extraction has is the
// `extracted` provenance, and it is carried as a trusted-source OPTION rather
// than as a field a caller could set.

import { err, ok, type Result } from "@platos/kernel";

import {
  countMessages,
  EXTRACTOR_VERSION,
  overrideExtractionPolicy,
  parseJudgeEnvelope,
  renderTranscript,
  resolveExtractionPolicy,
  selectCandidates,
  stableSlug,
  transcriptWindow,
  type CandidateRefusal,
  type ExtractionPolicy,
  type MemoryEntityId,
  type ThreadId,
  type TranscriptTurn,
  type TurnId,
} from "../domain/index.js";
import { verifyRuntime } from "./authorization.js";
import type { MemoryDependencies } from "./dependencies.js";
import { priceJudgeAnswer } from "./judge-pricing.js";
import { rememberEntity, relateEntities } from "./knowledge-graph.js";
import { remember } from "./remember.js";
import { readWatermark, writeWatermark } from "./working-memory.js";

export interface ExtractFromConversationCommand {
  /** A `MemoryRuntimeAuthorization`. The subject travels inside it. */
  readonly authorization: unknown;
  readonly threadId: ThreadId;
  /** The turns the handler read, newest-first or oldest-first; order is fixed here. */
  readonly turns: readonly TranscriptTurn[];
  /** The agent version's stored `memoryConfig.__runtime.extractionPolicy`, verbatim. */
  readonly storedPolicy: unknown;
  readonly policyOverride?: Partial<ExtractionPolicy>;
  /** Bypass the watermark. The manual "extract now" control sets it. */
  readonly force?: boolean;
}

/** Why a sweep did nothing. Every one of these is an outcome, not a failure. */
export type ExtractionSkip =
  | "extraction-disabled"
  | "no-new-activity"
  | "insufficient-messages"
  | "judge-unavailable";

export interface ExtractionReport {
  readonly memoriesWritten: number;
  readonly entitiesWritten: number;
  readonly relationshipsWritten: number;
  readonly refused: readonly CandidateRefusal[];
  readonly skipped: ExtractionSkip | null;
  /** Canonical `Decimal(18, 6)` cents from `providers`, or null when unpriced. */
  readonly costCents: string | null;
  readonly model: string | null;
}

const NOTHING: Omit<ExtractionReport, "skipped"> = {
  memoriesWritten: 0,
  entitiesWritten: 0,
  relationshipsWritten: 0,
  refused: [],
  costCents: null,
  model: null,
};

export async function extractFromConversation(
  dependencies: MemoryDependencies,
  command: ExtractFromConversationCommand,
): Promise<Result<ExtractionReport>> {
  const granted = verifyRuntime(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);

  const policy = overrideExtractionPolicy(
    resolveExtractionPolicy(command.storedPolicy),
    command.policyOverride,
  );
  if (!policy.enabled) return ok({ ...NOTHING, skipped: "extraction-disabled" });

  const window = transcriptWindow(policy);
  const turns = newestFirst(command.turns).slice(0, window.turns);
  const head = turns[0]?.turnId ?? null;

  if (command.force !== true) {
    const stored = await readWatermark(dependencies, command.threadId);
    if (stored !== null && head !== null && stored === head) {
      return ok({ ...NOTHING, skipped: "no-new-activity" });
    }
  }
  if (countMessages(turns) < policy.minMessagesBeforeRun) {
    return ok({ ...NOTHING, skipped: "insufficient-messages" });
  }

  const answered = await dependencies.judge.extract(renderTranscript(turns), policy);
  if (!answered.ok) return ok({ ...NOTHING, skipped: "judge-unavailable" });
  const costCents = await priceJudgeAnswer(dependencies, answered.value);

  const envelope = parseJudgeEnvelope(answered.value.text);
  if (!envelope.ok) return err(envelope.error);

  const entityIds = await materialiseEntities(dependencies, granted.value, envelope.value.entities);
  if (!entityIds.ok) return err(entityIds.error);

  const written = await writeCandidates(dependencies, granted.value, {
    threadId: command.threadId,
    turnIds: turns.map((turn) => turn.turnId as TurnId),
    selection: selectCandidates(envelope.value.memories, policy),
  });
  if (!written.ok) return err(written.error);

  const edges = await writeRelationships(
    dependencies,
    granted.value,
    envelope.value.relationships,
    entityIds.value,
  );
  if (!edges.ok) return err(edges.error);

  if (head !== null) await writeWatermark(dependencies, command.threadId, head as TurnId);

  return ok({
    memoriesWritten: written.value.written,
    entitiesWritten: entityIds.value.size,
    relationshipsWritten: edges.value,
    refused: written.value.refused,
    skipped: null,
    costCents,
    model: answered.value.model,
  });
}

type RuntimeGrant = Extract<Awaited<ReturnType<typeof verifyRuntime>>, { ok: true }>["value"];

async function materialiseEntities(
  dependencies: MemoryDependencies,
  grant: RuntimeGrant,
  candidates: readonly { readonly entityKey: string; readonly label: string; readonly entityType: string; readonly aliases: readonly string[] }[],
): Promise<Result<ReadonlyMap<string, MemoryEntityId>>> {
  const resolved = new Map<string, MemoryEntityId>();
  for (const candidate of candidates) {
    const slug = stableSlug(candidate.entityKey);
    if (slug.length === 0 || resolved.has(slug)) continue;
    const upserted = await rememberEntity(dependencies, {
      authorization: grant,
      endUserId: grant.endUserId,
      actingAgentId: grant.actingAgentId,
      requestedAgentId: null,
      entityKey: slug,
      entityType: candidate.entityType,
      label: candidate.label,
      aliases: candidate.aliases,
    });
    if (!upserted.ok) return err(upserted.error);
    resolved.set(slug, upserted.value.entity.entityId);
  }
  return ok(resolved);
}

async function writeCandidates(
  dependencies: MemoryDependencies,
  grant: RuntimeGrant,
  input: {
    readonly threadId: ThreadId;
    readonly turnIds: readonly TurnId[];
    readonly selection: ReturnType<typeof selectCandidates>;
  },
): Promise<Result<{ written: number; refused: readonly CandidateRefusal[] }>> {
  let written = 0;
  const refused = input.selection.refused.map((entry) => entry.reason);

  for (const admitted of input.selection.admitted) {
    const slugs = admitted.candidate.entityKeys
      .map(stableSlug)
      .filter((slug) => slug.length > 0);
    const stored = await remember(
      dependencies,
      {
        authorization: grant,
        endUserId: grant.endUserId,
        actingAgentId: grant.actingAgentId,
        requestedAgentId: null,
        kind: admitted.kind,
        content: admitted.candidate.content,
        metadata: stampEntities(admitted.candidate.metadata, slugs),
        visibility: null,
        agentVisible: null,
        source: "extracted",
        sourceThreadId: input.threadId,
        sourceTurnIds: input.turnIds,
        extractorVersion: EXTRACTOR_VERSION,
        confidence: admitted.candidate.confidence,
      },
      { trustedSource: "extracted" },
    );
    if (!stored.ok) return err(stored.error);
    written += 1;
  }
  return ok({ written, refused });
}

async function writeRelationships(
  dependencies: MemoryDependencies,
  grant: RuntimeGrant,
  candidates: readonly { readonly from: string; readonly to: string; readonly relationshipType: string; readonly weight: number | null }[],
  entityIds: ReadonlyMap<string, MemoryEntityId>,
): Promise<Result<number>> {
  let written = 0;
  for (const candidate of candidates) {
    const fromId = entityIds.get(stableSlug(candidate.from));
    const toId = entityIds.get(stableSlug(candidate.to));
    if (fromId === undefined || toId === undefined) continue;
    const related = await relateEntities(dependencies, {
      authorization: grant,
      endUserId: grant.endUserId,
      actingAgentId: grant.actingAgentId,
      requestedAgentId: null,
      fromEntityId: fromId,
      toEntityId: toId,
      relationshipType: candidate.relationshipType,
      weight: candidate.weight,
    });
    if (!related.ok) return err(related.error);
    written += 1;
  }
  return ok(written);
}

/**
 * Record which nodes a memory belongs to.
 *
 * The slugs are stamped under `entities` on the memory's own metadata, which is
 * what makes the trace from a memory back to the graph a lookup rather than a
 * search — and it is the key fused retrieval reads. An empty list adds NO key,
 * so a memory with no entities looks the same as one written by hand.
 */
export function stampEntities(metadata: unknown, slugs: readonly string[]): unknown {
  const base = metadata === null || typeof metadata !== "object" || Array.isArray(metadata) ? {} : metadata;
  if (slugs.length === 0) return base;
  return { ...base, entities: [...new Set(slugs)] };
}

/** Newest turn first, by sequence. The window is taken from the head. */
function newestFirst(turns: readonly TranscriptTurn[]): readonly TranscriptTurn[] {
  return [...turns].sort((left, right) => right.sequence - left.sequence);
}
