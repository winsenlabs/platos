// Use case: append one artifact revision.
//
// There is no `updateArtifact`. There cannot be: `@@unique([threadId,
// artifactKey, revision])` means the only way to record a change is a new row,
// and this use case is the only writer.
//
// The occupied-slot check is deliberately made TWICE — once here against a read,
// and once by the database constraint the repository surfaces. The read is not
// redundant: it turns the common case into a domain error with the artifact key
// and revision in it, rather than a constraint violation an adapter has to
// reverse-engineer. The constraint remains the authority under concurrency,
// which is why the repository is required never to convert it into an update or
// to retry at the next free revision. Two writers racing for revision 4 must
// produce one revision 4 and one conflict, never two rows and never a silent 5.

import { asIdentifier, err, ok, runResult, type JsonValue, type PrincipalId, type Result } from "@platos/kernel";

import {
  admitRevisionSlot,
  planArtifactRevision,
  type ArtifactId,
  type ArtifactKey,
  type ArtifactKind,
  type ArtifactRevision,
  type ThreadScope,
  type TurnId,
} from "../domain/index.js";
import type { FilesDependencies } from "./dependencies.js";

export interface WriteArtifactRevisionCommand {
  readonly scope: ThreadScope;
  readonly artifactKey: ArtifactKey;
  readonly kind: ArtifactKind;
  readonly content: string;
  readonly title?: string | null;
  readonly mimeType?: string | null;
  readonly metadata?: Readonly<Record<string, JsonValue>> | null;
  readonly producedByTurnId?: TurnId | null;
  readonly createdBy: PrincipalId;
}

export async function writeArtifactRevision(
  dependencies: FilesDependencies,
  command: WriteArtifactRevisionCommand,
): Promise<Result<ArtifactRevision>> {
  const { repository, policy, clock, ids, unitOfWork } = dependencies;

  const latest = await repository.findLatestArtifactRevision(command.scope, command.artifactKey);
  if (!latest.ok) return err(latest.error);

  const planned = planArtifactRevision(latest.value, command, policy.artifact);
  if (!planned.ok) return err(planned.error);

  const occupant = await repository.findArtifactRevision(command.scope, command.artifactKey, planned.value.revision);
  if (!occupant.ok) return err(occupant.error);
  const slot = admitRevisionSlot(command.artifactKey, planned.value.revision, occupant.value);
  if (!slot.ok) return err(slot.error);

  const revision: ArtifactRevision = {
    artifactId: asIdentifier<ArtifactId>(ids.uuid()),
    scope: command.scope,
    artifactKey: command.artifactKey,
    revision: slot.value,
    kind: planned.value.kind,
    title: command.title ?? null,
    mimeType: command.mimeType ?? null,
    content: command.content,
    metadata: command.metadata ?? null,
    producedByTurnId: command.producedByTurnId ?? null,
    createdBy: command.createdBy,
    createdAt: clock.now(),
  };

  return runResult(unitOfWork, (transaction) => repository.insertArtifactRevision(revision, transaction));
}
