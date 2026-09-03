// The published surface of the `files` context.
//
// ADR M0.3 §2: another context may import THIS entrypoint and nothing else —
// never `domain/`, never `application/`, never an adapter. The two contexts
// permitted to reach it by the §1 DAG are `skills` and `conversations`, and the
// composition root wires it.
//
// It is types only. Nothing here has a runtime representation, so importing this
// module costs a consumer no code and cannot drag an implementation across a
// context boundary. The implementation is `createFilesContract` in
// `application/`, and it is reached only through the composition root.
//
// The driven `ObjectStore` port is NOT re-exported here. It is adapter-facing,
// not context-facing, and it is published from `application/ports/index.js`
// where its one adapter imports it (ADR M0.3 §13).

import type { ErasureTarget, JsonValue, PrincipalId, Result } from "@platos/kernel";

import type {
  ArtifactKey,
  ArtifactKind,
  AttachmentId,
  AttachmentKind,
  AttachmentScope,
  ContentHash,
  ThreadScope,
  TurnId,
} from "../domain/index.js";

// The identifier and scope vocabulary a caller needs to build a command. Branded
// types, so a `threadId` cannot reach an `agentId` parameter across the boundary
// any more than it can inside it.
export type {
  AgentId,
  ArtifactId,
  ArtifactKey,
  ArtifactKind,
  AttachmentId,
  AttachmentKind,
  AttachmentOwner,
  AttachmentScope,
  ContentHash,
  EndUserId,
  StorageKey,
  ThreadId,
  ThreadScope,
  TurnId,
} from "../domain/index.js";

/** A blob pointer, as seen from outside. Never carries bytes or a URL. */
export interface AttachmentView {
  readonly attachmentId: AttachmentId;
  readonly kind: AttachmentKind;
  readonly mimeType: string;
  readonly bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSeconds: number | null;
  readonly originalName: string | null;
  readonly contentHash: ContentHash | null;
  /** Null while the attachment is still pending. */
  readonly turnId: TurnId | null;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
}

/**
 * A time-boxed permission to move bytes, addressed to the client that will use
 * it. `expiresAt` is on the value because a caller holding one past that instant
 * must be able to tell without asking the store.
 */
export interface TransferGrantView {
  readonly url: string;
  readonly method: "PUT" | "GET";
  readonly requiredHeaders: Readonly<Record<string, string>>;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface AttachmentUploadView {
  readonly attachment: AttachmentView;
  /**
   * Null when the bytes already existed in this environment and were duplicated
   * server-side: there is nothing for the client to send. Callers MUST branch on
   * this rather than assume a URL.
   */
  readonly grant: TransferGrantView | null;
  readonly deduplicated: boolean;
}

export interface AttachmentDownloadView {
  readonly attachment: AttachmentView;
  readonly grant: TransferGrantView;
}

export interface ArtifactRevisionView {
  readonly artifactKey: ArtifactKey;
  readonly revision: number;
  readonly kind: ArtifactKind;
  readonly title: string | null;
  readonly mimeType: string | null;
  readonly content: string;
  readonly metadata: Readonly<Record<string, JsonValue>> | null;
  readonly producedByTurnId: TurnId | null;
  readonly createdBy: PrincipalId;
  readonly createdAt: Date;
}

export interface RequestAttachmentUpload {
  readonly scope: AttachmentScope;
  readonly mimeType: string;
  readonly bytes: number;
  readonly originalName?: string | null;
  /** Free-form; classified from `mimeType` when omitted. Never an enum. */
  readonly kind?: AttachmentKind | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly durationSeconds?: number | null;
  /** Supplying it enables server-side dedupe inside this environment. */
  readonly contentHash?: ContentHash | null;
}

export interface RequestAttachmentBinding {
  readonly scope: ThreadScope;
  readonly attachmentIds: readonly AttachmentId[];
  readonly turnId: TurnId;
}

export interface RequestAttachmentDownload {
  readonly scope: ThreadScope;
  readonly attachmentId: AttachmentId;
}

export interface RequestArtifactRevision {
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

export interface RequestArtifactRead {
  readonly scope: ThreadScope;
  /** Omit or null for the latest. A named revision that is absent FAILS. */
  readonly revision?: number | null;
  readonly artifactKey: ArtifactKey;
}

export interface RequestAttachmentRetentionSweep {
  readonly limit: number;
}

/** One row's outcome in a retention pass. */
export interface AttachmentDestructionView {
  readonly attachmentId: AttachmentId;
  readonly blobDestroyed: boolean;
  readonly rowDestroyed: boolean;
  /** The stable error code when the row was retained; null when it was not. */
  readonly retainedBecause: string | null;
}

export interface AttachmentRetentionSweepView {
  readonly examined: number;
  readonly rowsDestroyed: number;
  readonly rowsRetained: number;
  readonly reports: readonly AttachmentDestructionView[];
}

/**
 * The `files` capability, as every other context sees it.
 *
 * Every method returns the kernel's `Result`: a failure a caller must handle is
 * visible in the type, and no vendor exception crosses this boundary.
 */
export interface FilesContract {
  readonly name: "files";

  /** Admit an upload, mint the row, and return a grant (or nothing to send). */
  requestUpload(request: RequestAttachmentUpload): Promise<Result<AttachmentUploadView>>;

  /** Bind pending attachments to the turn that used them. All-or-nothing. */
  bindToTurn(request: RequestAttachmentBinding): Promise<Result<readonly AttachmentView[]>>;

  /** Mint a short-lived read grant for one attachment. */
  requestDownload(request: RequestAttachmentDownload): Promise<Result<AttachmentDownloadView>>;

  describeAttachment(request: RequestAttachmentDownload): Promise<Result<AttachmentView>>;

  /** Append a revision. Never an update: the previous revision is immutable. */
  appendArtifactRevision(request: RequestArtifactRevision): Promise<Result<ArtifactRevisionView>>;

  /** Read one revision. A named revision that does not exist fails. */
  readArtifact(request: RequestArtifactRead): Promise<Result<ArtifactRevisionView>>;

  /** Destroy elapsed attachments: blob first, row second, failures reported. */
  sweepRetention(request: RequestAttachmentRetentionSweep): Promise<Result<AttachmentRetentionSweepView>>;

  /**
   * This context's `ErasureTarget` for the rows it is sole writer of. The
   * composition root collects one of these per context and injects the array
   * into `privacy` (ADR M0.3 §3).
   */
  erasureTarget(): ErasureTarget;
}
