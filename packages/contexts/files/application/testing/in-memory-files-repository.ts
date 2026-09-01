// An in-memory `FilesRepository`.
//
// Two behaviours here are load-bearing rather than convenient, and both mirror a
// constraint the real schema enforces:
//
//   * `@@unique([threadId, artifactKey, revision])` is upheld — a second insert
//     at an occupied triple returns `FILES_ARTIFACT_REVISION_CONFLICT`, exactly
//     as the adapter is required to. Without it the append-only rule would be
//     proved only against the pre-check, and a race would be untestable.
//
//   * Every read is filtered by scope. An id that exists in another environment
//     is reported ABSENT, never returned. A double that ignored scope would make
//     the cross-tenant tests vacuous.

import { contains, err, ok, type OrganizationScope, type Result, type TransactionScope } from "@platos/kernel";

import {
  artifactRevisionConflict,
  sameEnvironment,
  sameThreadScope,
  threadPath,
  type ArtifactKey,
  type ArtifactRevision,
  type Attachment,
  type AttachmentId,
  type ContentHash,
  type ThreadScope,
} from "../../domain/index.js";
import type { FilesErasureSelector, FilesRepository } from "../ports/index.js";

/** The real adapter resolves the subject's scope by containment; so does this. */
function withinSubjectScope(selector: FilesErasureSelector, row: ThreadScope): boolean {
  return contains(selector.scope, row.environment);
}

export class InMemoryFilesRepository implements FilesRepository {
  private readonly attachments = new Map<string, Attachment>();
  private readonly artifacts: ArtifactRevision[] = [];

  /**
   * Fires ONCE, immediately after the next `findLatestArtifactRevision` returns.
   *
   * This is the seam a concurrency test needs and cannot otherwise reach: the
   * append-only rule reads the latest revision, then checks the slot it plans to
   * write, and the interesting failure is another writer landing between those
   * two reads. Without a hook here that interleaving is unreproducible, and the
   * slot check would only ever be proved against an occupant it had itself seen.
   */
  hookAfterLatestLookup: (() => void) | null = null;

  /** Arrange rows without going through a use case. */
  seedAttachment(attachment: Attachment): void {
    this.attachments.set(attachment.attachmentId, attachment);
  }

  seedArtifactRevision(revision: ArtifactRevision): void {
    this.artifacts.push(revision);
  }

  allAttachments(): readonly Attachment[] {
    return [...this.attachments.values()];
  }

  allArtifactRevisions(): readonly ArtifactRevision[] {
    return [...this.artifacts];
  }

  private visible(scope: ThreadScope): readonly Attachment[] {
    return [...this.attachments.values()].filter((attachment) => sameThreadScope(attachment.scope, scope));
  }

  async insertAttachment(attachment: Attachment, _transaction: TransactionScope): Promise<Result<Attachment>> {
    this.attachments.set(attachment.attachmentId, attachment);
    return ok(attachment);
  }

  async findAttachment(scope: ThreadScope, attachmentId: AttachmentId): Promise<Result<Attachment | null>> {
    const found = this.attachments.get(attachmentId);
    if (found === undefined || !sameThreadScope(found.scope, scope)) return ok(null);
    return ok(found);
  }

  async findAttachmentsInScope(
    scope: ThreadScope,
    attachmentIds: readonly AttachmentId[],
  ): Promise<Result<readonly Attachment[]>> {
    const wanted = new Set<string>(attachmentIds);
    return ok(this.visible(scope).filter((attachment) => wanted.has(attachment.attachmentId)));
  }

  async findAttachmentByContentHash(
    environment: Parameters<FilesRepository["findAttachmentByContentHash"]>[0],
    contentHash: ContentHash,
  ): Promise<Result<Attachment | null>> {
    const probe: ThreadScope = { environment, threadId: "" as ThreadScope["threadId"] };
    const match = [...this.attachments.values()].find(
      (attachment) => attachment.contentHash === contentHash && sameEnvironment(attachment.scope, probe),
    );
    return ok(match ?? null);
  }

  async sumAttachmentBytes(scope: OrganizationScope): Promise<Result<number>> {
    let total = 0;
    for (const attachment of this.attachments.values()) {
      if (contains(scope, attachment.scope.environment)) total += attachment.bytes;
    }
    return ok(total);
  }

  async listElapsedAttachments(asOf: Date, limit: number): Promise<Result<readonly Attachment[]>> {
    const elapsed = [...this.attachments.values()]
      .filter((attachment) => attachment.expiresAt !== null && attachment.expiresAt.getTime() <= asOf.getTime())
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    return ok(elapsed.slice(0, limit));
  }

  async updateAttachmentBinding(attachment: Attachment, _transaction: TransactionScope): Promise<Result<Attachment>> {
    this.attachments.set(attachment.attachmentId, attachment);
    return ok(attachment);
  }

  async deleteAttachment(
    scope: ThreadScope,
    attachmentId: AttachmentId,
    _transaction: TransactionScope,
  ): Promise<Result<boolean>> {
    const found = this.attachments.get(attachmentId);
    if (found === undefined || !sameThreadScope(found.scope, scope)) return ok(false);
    this.attachments.delete(attachmentId);
    return ok(true);
  }

  async findLatestArtifactRevision(
    scope: ThreadScope,
    artifactKey: ArtifactKey,
  ): Promise<Result<ArtifactRevision | null>> {
    const held = this.artifacts
      .filter((row) => row.artifactKey === artifactKey && sameThreadScope(row.scope, scope))
      .sort((left, right) => right.revision - left.revision);
    const latest = held[0] ?? null;
    const hook = this.hookAfterLatestLookup;
    if (hook !== null) {
      this.hookAfterLatestLookup = null;
      hook();
    }
    return ok(latest);
  }

  async findArtifactRevision(
    scope: ThreadScope,
    artifactKey: ArtifactKey,
    revision: number,
  ): Promise<Result<ArtifactRevision | null>> {
    const found = this.artifacts.find(
      (row) => row.artifactKey === artifactKey && row.revision === revision && sameThreadScope(row.scope, scope),
    );
    return ok(found ?? null);
  }

  async insertArtifactRevision(
    revision: ArtifactRevision,
    _transaction: TransactionScope,
  ): Promise<Result<ArtifactRevision>> {
    const occupied = this.artifacts.some(
      (row) =>
        row.artifactKey === revision.artifactKey &&
        row.revision === revision.revision &&
        threadPath(row.scope) === threadPath(revision.scope),
    );
    if (occupied) return err(artifactRevisionConflict(revision.artifactKey, revision.revision));
    this.artifacts.push(revision);
    return ok(revision);
  }

  async countAttachmentsForSubject(selector: FilesErasureSelector): Promise<Result<number>> {
    const found = await this.listAttachmentsForSubject(selector);
    return found.ok ? ok(found.value.length) : found;
  }

  async countArtifactRevisionsForSubject(selector: FilesErasureSelector): Promise<Result<number>> {
    return ok(this.artifactsForSubject(selector).length);
  }

  async listAttachmentsForSubject(selector: FilesErasureSelector): Promise<Result<readonly Attachment[]>> {
    if (selector.endUserId === null) return ok([]);
    const endUserId = selector.endUserId;
    return ok(
      [...this.attachments.values()].filter(
        (attachment) => attachment.scope.owner.endUserId === endUserId && withinSubjectScope(selector, attachment.scope),
      ),
    );
  }

  private artifactsForSubject(selector: FilesErasureSelector): readonly ArtifactRevision[] {
    if (selector.principalId === null) return [];
    const principalId = selector.principalId;
    return this.artifacts.filter(
      (row) => row.createdBy === principalId && withinSubjectScope(selector, row.scope),
    );
  }

  async deleteArtifactRevisionsForSubject(
    selector: FilesErasureSelector,
    _transaction: TransactionScope,
  ): Promise<Result<number>> {
    const doomed = new Set(this.artifactsForSubject(selector));
    if (doomed.size === 0) return ok(0);
    for (let index = this.artifacts.length - 1; index >= 0; index -= 1) {
      const row = this.artifacts[index];
      if (row !== undefined && doomed.has(row)) this.artifacts.splice(index, 1);
    }
    return ok(doomed.size);
  }
}
