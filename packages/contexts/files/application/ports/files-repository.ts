// The `FilesRepository` port — the canonical store, seen only as an interface.
//
// ADR M0.3 §1 makes this context the SOLE WRITER of `MessageAttachment` and
// `Artifact`. This port is where that ownership is expressed: every mutation of
// either table in the V1 system passes through one of the methods below, and
// there is deliberately no generic `save(row)` or `query(where)` escape hatch
// through which another context could reach the tables sideways.
//
// EVERY READ IS SCOPED. There is no `findAttachment(id)`. There is
// `findAttachment(scope, id)`, and an implementation MUST return `null` — not a
// row from another environment — when the id exists elsewhere. Making the scope
// a parameter rather than an ambient means a scope-less lookup does not compile.
//
// EVERY MUTATION TAKES A `TransactionScope`. The kernel's handle is opaque by
// construction (ADR M0.3 §3: no context passes a vendor transaction handle
// across a port), which is what lets a caller make a row write and an outbox
// append atomic without either side naming the other's technology.
//
// Like `ObjectStore`, every method returns `Result`. A rejected promise is a
// defect, not an outcome.

import type { EnvironmentScope, OrganizationScope, Result, TenantScope, TransactionScope } from "@platos/kernel";

import type {
  ArtifactKey,
  ArtifactRevision,
  Attachment,
  AttachmentId,
  ContentHash,
  ThreadScope,
} from "../../domain/index.js";

/**
 * What identifies the subject of an erasure inside this context's rows.
 *
 * `scope` is a full `TenantScope`, not an `EnvironmentScope`: an erasure may be
 * addressed at an organization, and both models are environment-keyed underneath
 * one, so an implementation resolves the selector by containment (the kernel's
 * `contains`) rather than by equality.
 */
export interface FilesErasureSelector {
  readonly scope: TenantScope;
  /** Matches `MessageAttachment.endUserId`; null when the subject is not one. */
  readonly endUserId: string | null;
  /** Matches `Artifact.createdBy`. */
  readonly principalId: string | null;
}

export interface FilesRepository {
  // --- MessageAttachment: the rows this context writes -----------------------

  insertAttachment(attachment: Attachment, transaction: TransactionScope): Promise<Result<Attachment>>;

  findAttachment(scope: ThreadScope, attachmentId: AttachmentId): Promise<Result<Attachment | null>>;

  /**
   * Resolve many ids inside one owner boundary. An id the boundary does not
   * cover is simply absent from the result; the caller compares counts and
   * fails closed, which is what keeps a partial answer from looking complete.
   */
  findAttachmentsInScope(
    scope: ThreadScope,
    attachmentIds: readonly AttachmentId[],
  ): Promise<Result<readonly Attachment[]>>;

  /** The dedupe probe. Scoped to an environment; never wider. */
  findAttachmentByContentHash(
    environment: EnvironmentScope,
    contentHash: ContentHash,
  ): Promise<Result<Attachment | null>>;

  /** Quota input: total stored bytes across one organization. */
  sumAttachmentBytes(scope: OrganizationScope): Promise<Result<number>>;

  /** Rows whose retention window has elapsed, oldest first. */
  listElapsedAttachments(asOf: Date, limit: number): Promise<Result<readonly Attachment[]>>;

  /** Persist a binding and its extended expiry. */
  updateAttachmentBinding(attachment: Attachment, transaction: TransactionScope): Promise<Result<Attachment>>;

  /**
   * Delete one row. Callers MUST have destroyed the blob first
   * (`domain/destruction.ts`); an implementation cannot verify that, which is
   * why the ordering lives in a domain rule the use cases share.
   */
  deleteAttachment(
    scope: ThreadScope,
    attachmentId: AttachmentId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>>;

  // --- Artifact: the rows this context writes -------------------------------

  /** The newest row holding `(threadId, artifactKey)`, or null. */
  findLatestArtifactRevision(scope: ThreadScope, artifactKey: ArtifactKey): Promise<Result<ArtifactRevision | null>>;

  /** The row at an EXACT `(threadId, artifactKey, revision)`, or null. */
  findArtifactRevision(
    scope: ThreadScope,
    artifactKey: ArtifactKey,
    revision: number,
  ): Promise<Result<ArtifactRevision | null>>;

  /**
   * Append one revision. The `@@unique([threadId, artifactKey, revision])`
   * constraint is the last line of defence: an implementation MUST surface a
   * violation as `FILES_ARTIFACT_REVISION_CONFLICT` and MUST NOT convert the
   * insert into an update or retry at the next free revision.
   */
  insertArtifactRevision(
    revision: ArtifactRevision,
    transaction: TransactionScope,
  ): Promise<Result<ArtifactRevision>>;

  // --- Erasure: this context's half of the kernel `ErasureTarget` -----------

  countAttachmentsForSubject(selector: FilesErasureSelector): Promise<Result<number>>;

  countArtifactRevisionsForSubject(selector: FilesErasureSelector): Promise<Result<number>>;

  /** Needed in full because each row's blob must be destroyed individually. */
  listAttachmentsForSubject(selector: FilesErasureSelector): Promise<Result<readonly Attachment[]>>;

  deleteArtifactRevisionsForSubject(
    selector: FilesErasureSelector,
    transaction: TransactionScope,
  ): Promise<Result<number>>;
}
