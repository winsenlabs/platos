// Use case: write one memory.
//
// The single write path. Everything that ends up in the `Memory` table — an
// operator writing a fact by hand, the extraction judge committing a candidate,
// a profile being synthesized — arrives here, so there is one place the rules
// are applied and one place a new rule has to be added.
//
// THE ORDER OF THE CHECKS IS THE PRODUCT DECISION, and it is not the order they
// happen to be cheapest in:
//
//   1. CONTENT, BEFORE ANYTHING COSTS MONEY. Admission is pure and free; the
//      embedding is a model call. Validating after embedding would bill an
//      installation for rejecting a blank string.
//   2. PROVENANCE, BEFORE OWNERSHIP. Turn ids without a thread, or turn ids that
//      are not that thread's, are a caller mistake and are reported as one.
//   3. THE TRUSTED-SOURCE GATE, BEFORE THE WRITE. `manual` is the only
//      provenance an untrusted caller may claim. Anything else — `extracted`,
//      `imported`, `rag` — has to be asserted by the use case that genuinely did
//      it, which is why `trustedSource` is an option on the command and not a
//      field on it.
//   4. DEDUPE LAST, because it needs the hash, which needs the admitted content.
//
// THE TWO COLLISION PATHS ARE DIFFERENT AND BOTH ARE HERE. A `profile` row
// upserts on its key and REPLACES; anything else with a content hash merges and
// keeps the stored content. Both decisions are domain functions
// (`replaceProfileRevision`, `mergeRepeatedExtraction`); this file only chooses
// which question to ask.

import { asIdentifier, err, ok, type Result, type TransactionScope } from "@platos/kernel";

import {
  admitContent,
  admitProvenance,
  agentVisibleFor,
  contentIdentity,
  invalidConfidence,
  mergeRepeatedExtraction,
  normalizeVisibility,
  provenanceIncomplete,
  replaceProfileRevision,
  requireMemoryKind,
  requireMemorySource,
  untrustedSource,
  type AgentId,
  type ContentHash,
  type EndUserId,
  type Memory,
  type MemoryId,
  type MemoryKind,
  type MemoryMetadata,
  type MemorySource,
  type MemoryVisibility,
  type ProfileKey,
  type ThreadId,
  type TurnId,
} from "../domain/index.js";
import { authorizeWrite, type WriteScope } from "./authorization.js";
import type { MemoryDependencies } from "./dependencies.js";
import { embedForStorage } from "./embedding.js";
import { CLEAR_EMBEDDING, KEEP_EMBEDDING, type EmbeddingDirective } from "./ports/index.js";

export interface RememberCommand {
  /** A tenancy operator grant, or this context's runtime grant. */
  readonly authorization: unknown;
  /** Required under an operator grant; a runtime grant names its own subject. */
  readonly endUserId: EndUserId | null;
  readonly actingAgentId: AgentId | null;
  readonly requestedAgentId: AgentId | null;
  readonly kind: string | null;
  readonly content: string;
  readonly metadata: unknown;
  readonly visibility: MemoryVisibility | null;
  /** The legacy boolean. Only consulted when `visibility` is absent. */
  readonly agentVisible: boolean | null;
  readonly source: MemorySource | null;
  readonly sourceThreadId: ThreadId | null;
  readonly sourceTurnIds: readonly TurnId[];
  readonly extractorVersion: string | null;
  readonly confidence: number | null;
}

/**
 * What a caller is entitled to claim beyond `manual`.
 *
 * An option, not a command field, so a transport cannot set it: the value is
 * supplied by the use case inside this package that actually performed the work
 * whose provenance is being claimed.
 */
export interface RememberOptions {
  readonly trustedSource?: Exclude<MemorySource, "manual">;
}

export async function remember(
  dependencies: MemoryDependencies,
  command: RememberCommand,
  options: RememberOptions = {},
): Promise<Result<Memory>> {
  const admitted = admitRememberCommand(command, options);
  if (!admitted.ok) return err(admitted.error);

  const scope = await authorizeWrite(dependencies, {
    authorization: command.authorization,
    endUserId: command.endUserId,
    actingAgentId: command.actingAgentId,
    requestedAgentId: command.requestedAgentId,
    sourceThreadId: command.sourceThreadId,
  });
  if (!scope.ok) return err(scope.error);

  const provenanceChecked = await verifyTurnsBelongToThread(dependencies, command);
  if (!provenanceChecked.ok) return err(provenanceChecked.error);

  const embedding = await embedForStorage(dependencies, admitted.value.kind, admitted.value.content);
  if (!embedding.ok) return err(embedding.error);

  return dependencies.unitOfWork.run(async (transaction) =>
    commit(dependencies, scope.value, admitted.value, embedding.value, transaction),
  );
}

/** The command after every pure rule has been applied. */
export interface AdmittedRemember {
  readonly kind: MemoryKind;
  readonly content: string;
  readonly metadata: MemoryMetadata;
  readonly profileKey: ProfileKey | null;
  readonly visibility: MemoryVisibility;
  readonly source: MemorySource;
  readonly sourceThreadId: ThreadId | null;
  readonly sourceTurnIds: readonly TurnId[];
  readonly extractorVersion: string | null;
  readonly confidence: number | null;
}

export function admitRememberCommand(
  command: RememberCommand,
  options: RememberOptions,
): Result<AdmittedRemember> {
  const kind = requireMemoryKind(command.kind);
  if (!kind.ok) return err(kind.error);

  const content = admitContent({ kind: kind.value, content: command.content, metadata: command.metadata });
  if (!content.ok) return err(content.error);

  const visibility = normalizeVisibility(command.visibility, command.agentVisible ?? undefined);
  if (!visibility.ok) return err(visibility.error);

  const requested = requireMemorySource(command.source ?? "manual");
  if (!requested.ok) return err(requested.error);
  if (requested.value !== "manual" && options.trustedSource !== requested.value) {
    return err(untrustedSource(requested.value));
  }

  if (command.confidence !== null && !isUnitInterval(command.confidence)) {
    return err(invalidConfidence(command.confidence));
  }

  const provenance = admitProvenance({
    sourceThreadId: command.sourceThreadId,
    sourceTurnIds: command.sourceTurnIds,
    extractorVersion: command.extractorVersion,
  });
  if (!provenance.ok) return err(provenance.error);

  return ok({
    kind: kind.value,
    content: content.value.content,
    metadata: content.value.metadata,
    profileKey: content.value.profileKey,
    visibility: visibility.value,
    source: options.trustedSource ?? requested.value,
    sourceThreadId: provenance.value.sourceThreadId,
    sourceTurnIds: provenance.value.sourceTurnIds,
    extractorVersion: provenance.value.extractorVersion,
    confidence: command.confidence,
  });
}

async function verifyTurnsBelongToThread(
  dependencies: MemoryDependencies,
  command: RememberCommand,
): Promise<Result<void>> {
  const turnIds = [...new Set(command.sourceTurnIds)];
  if (turnIds.length === 0 || command.sourceThreadId === null) return ok(undefined);
  const counted = await dependencies.repository.countTurnsInThread(command.sourceThreadId, turnIds);
  if (!counted.ok) return err(counted.error);
  if (counted.value !== turnIds.length) {
    return err(
      provenanceIncomplete("memory source turns must belong to the source thread", {
        threadId: command.sourceThreadId,
        stated: String(turnIds.length),
        found: String(counted.value),
      }),
    );
  }
  return ok(undefined);
}

async function commit(
  dependencies: MemoryDependencies,
  scope: WriteScope,
  admitted: AdmittedRemember,
  embedding: EmbeddingDirective,
  transaction: TransactionScope,
): Promise<Result<Memory>> {
  const now = dependencies.clock.now();
  const hash = admitted.sourceThreadId === null ? null : dependencies.digest.digest(admitted.content);
  const draft = buildMemory(dependencies, scope, admitted, hash, now);

  if (admitted.profileKey !== null) {
    const existing = await dependencies.repository.findProfileRow(
      scope.subject,
      scope.binding,
      admitted.profileKey,
    );
    if (!existing.ok) return err(existing.error);
    if (existing.value !== null) {
      return dependencies.repository.updateMemory(
        { memory: replaceProfileRevision(existing.value, draft, now), embedding: CLEAR_EMBEDDING },
        transaction,
      );
    }
    return dependencies.repository.insertMemory({ memory: draft, embedding }, transaction);
  }

  if (hash !== null) {
    const collision = await dependencies.repository.findByContentIdentity(
      scope.subject,
      admitted.sourceThreadId,
      hash,
    );
    if (!collision.ok) return err(collision.error);
    if (collision.value !== null) {
      // The stored vector describes the stored content, and the collision means
      // the two bodies are equal, so recomputing it would store the same numbers.
      return dependencies.repository.updateMemory(
        { memory: mergeRepeatedExtraction(collision.value, draft, now), embedding: KEEP_EMBEDDING },
        transaction,
      );
    }
  }
  return dependencies.repository.insertMemory({ memory: draft, embedding }, transaction);
}

function buildMemory(
  dependencies: MemoryDependencies,
  scope: WriteScope,
  admitted: AdmittedRemember,
  contentHash: ContentHash | null,
  now: Date,
): Memory {
  const identity = contentIdentity(admitted.sourceThreadId !== null, contentHash);
  return {
    memoryId: asIdentifier<MemoryId>(dependencies.ids.uuid()),
    subject: scope.subject,
    ownership: { agentId: scope.binding.agentId, clusterId: scope.binding.clusterId },
    kind: admitted.kind,
    profileKey: admitted.profileKey,
    content: admitted.content,
    metadata: admitted.metadata,
    visibility: admitted.visibility,
    source: admitted.source,
    contentHash: identity.contentHash,
    provenance: {
      sourceThreadId: admitted.sourceThreadId,
      sourceTurnIds: admitted.sourceTurnIds,
      extractorVersion: admitted.extractorVersion,
      originalSource: null,
      originalSourceThreadId: null,
      originalSourceTurnIds: [],
    },
    confidence: { confidence: admitted.confidence, feedbackBaselineConfidence: null },
    lifecycle: {
      lastAccessedAt: null,
      quarantinedAt: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    },
  };
}

/** The derived boolean, exported so a view can render it without re-deriving. */
export function rememberedAgentVisible(memory: Memory): boolean {
  return agentVisibleFor(memory.visibility);
}

function isUnitInterval(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}
