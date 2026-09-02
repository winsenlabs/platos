// Use case: revise a memory that already exists.
//
// A PATCH, NOT A REPLACEMENT. An absent field leaves the stored value; a field
// that is present replaces it. That distinction is why every field on the
// command is optional rather than nullable — `metadata: null` means "clear the
// metadata", and `metadata` absent means "leave it", and a nullable field cannot
// say both.
//
// THE EMBEDDING DECISION IS THE SUBTLE PART, and it has four cases rather than
// two. Recomputing a vector is a model call, so it happens only when the stored
// one is wrong:
//
//   the row is becoming a profile   CLEAR it. A profile is read by key, never by
//                                   similarity (`application/embedding.ts`).
//   the content changed             SET a new one. The stored vector describes
//                                   text that no longer exists.
//   the row WAS a profile           SET one. It has had no vector while it was a
//                                   profile, and it now needs one.
//   otherwise                       KEEP. Re-embedding unchanged text spends a
//                                   model call to store the same numbers.
//
// The third case is the one an implementation forgets. Without it, a profile row
// revised into a fact is stored with a null vector and is silently unrecallable
// forever — present in every listing, absent from every search.
//
// PROVENANCE AND OWNERSHIP ARE NOT PATCHABLE. There is no way to change which
// thread a memory came from, which agent formed it, or what its source was. Those
// are facts about how the row came to exist, and an editable provenance is a
// provenance that proves nothing.

import { err, ok, type Result } from "@platos/kernel";

import {
  admitContent,
  memoryNotFound,
  normalizeVisibility,
  requireMemoryKind,
  type AgentId,
  type EndUserId,
  type Memory,
  type MemoryId,
  type MemoryVisibility,
} from "../domain/index.js";
import { authorizeMutation } from "./authorization.js";
import type { MemoryDependencies } from "./dependencies.js";
import { embedQuery } from "./embedding.js";
import { CLEAR_EMBEDDING, KEEP_EMBEDDING, type EmbeddingDirective } from "./ports/index.js";

export interface ReviseCommand {
  readonly authorization: unknown;
  /** Required under an operator grant; a runtime grant names its own subject. */
  readonly endUserId: EndUserId | null;
  readonly actingAgentId: AgentId | null;
  readonly memoryId: MemoryId;
  readonly kind?: string;
  readonly content?: string;
  readonly metadata?: unknown;
  readonly visibility?: MemoryVisibility;
  readonly agentVisible?: boolean;
}

export async function revise(
  dependencies: MemoryDependencies,
  command: ReviseCommand,
): Promise<Result<Memory>> {
  const scope = await authorizeMutation(dependencies, { ...command, requestedAgentIds: [] });
  if (!scope.ok) return err(scope.error);

  const found = await dependencies.repository.findMemory(
    scope.value.subject,
    scope.value.agentIds,
    command.memoryId,
  );
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(memoryNotFound(command.memoryId));
  const existing = found.value;

  const kind = requireMemoryKind(command.kind ?? existing.kind);
  if (!kind.ok) return err(kind.error);
  const admitted = admitContent({
    kind: kind.value,
    content: command.content ?? existing.content,
    metadata: command.metadata === undefined ? existing.metadata : command.metadata,
  });
  if (!admitted.ok) return err(admitted.error);

  const visibility = resolveVisibility(command, existing.visibility);
  if (!visibility.ok) return err(visibility.error);

  const contentChanged = command.content !== undefined && admitted.value.content !== existing.content;
  const embedding = await decideEmbedding(dependencies, {
    becomingProfile: kind.value === "profile",
    wasProfile: existing.kind === "profile",
    contentChanged,
    content: admitted.value.content,
  });
  if (!embedding.ok) return err(embedding.error);

  const now = dependencies.clock.now();
  const revised: Memory = {
    ...existing,
    kind: kind.value,
    profileKey: admitted.value.profileKey,
    content: admitted.value.content,
    metadata: admitted.value.metadata,
    visibility: visibility.value,
    // The hash follows the CONTENT, and only when the content moved. Recomputing
    // it on an unchanged body would be a no-op; leaving it stale after a real
    // edit would let the next extraction sweep collide with text that is gone.
    contentHash: contentChanged
      ? dependencies.digest.digest(admitted.value.content)
      : existing.contentHash,
    lifecycle: { ...existing.lifecycle, updatedAt: now },
  };

  return dependencies.unitOfWork.run(async (transaction) =>
    dependencies.repository.updateMemory({ memory: revised, embedding: embedding.value }, transaction),
  );
}

/**
 * The visibility a patch resolves to.
 *
 * An explicit `visibility` wins. Otherwise the legacy boolean speaks, but ONLY
 * when it was supplied — an absent boolean must leave a `private` row private
 * rather than normalising it to `agent_visible`, which is what passing
 * `undefined` through the default would do.
 */
export function resolveVisibility(
  command: Pick<ReviseCommand, "visibility" | "agentVisible">,
  current: MemoryVisibility,
): Result<MemoryVisibility> {
  if (command.visibility !== undefined) {
    return normalizeVisibility(command.visibility, command.agentVisible);
  }
  if (command.agentVisible !== undefined) return normalizeVisibility(undefined, command.agentVisible);
  return ok(current);
}

async function decideEmbedding(
  dependencies: MemoryDependencies,
  state: {
    readonly becomingProfile: boolean;
    readonly wasProfile: boolean;
    readonly contentChanged: boolean;
    readonly content: string;
  },
): Promise<Result<EmbeddingDirective>> {
  if (state.becomingProfile) return ok(CLEAR_EMBEDDING);
  if (!state.contentChanged && !state.wasProfile) return ok(KEEP_EMBEDDING);
  const vector = await embedQuery(dependencies, state.content);
  if (!vector.ok) return err(vector.error);
  return ok({ action: "set", vector: vector.value });
}
