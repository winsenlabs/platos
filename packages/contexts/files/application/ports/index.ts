// Driven ports this context needs, and the one adapter-facing port it OWNS.
//
// `ObjectStore` is published from here rather than from the kernel: ADR M0.3 §13
// assigns it to `files`, and `packages/adapters/objectstore-minio` has exactly
// one import edge, to this entrypoint. `FilesRepository` is the canonical-store
// port behind which this context's sole-writer ownership of `MessageAttachment`
// and `Artifact` is realised.
//
// Implemented under `packages/adapters/*`, wired in `apps/core-api`, never
// imported by `domain/` (ADR M0.3 §2).
export * from "./object-store.js";
export * from "./files-repository.js";

// WIN-258 T5 — the values and types these two ports' own SIGNATURES already
// name.
//
// WITHOUT THIS BLOCK THE CANONICAL-STORE PORT IS UNIMPLEMENTABLE OUTSIDE THIS
// PACKAGE. `files-repository.ts` above declares fifteen methods in terms of
// `Attachment`, `AttachmentId`, `ArtifactRevision`, `ArtifactKey`, `ContentHash`
// and `ThreadScope`, imported from `../../domain/*.js` as TYPES and re-exported
// nowhere; `contracts/index.ts` publishes the flattened VIEWS instead, on
// purpose, because a peer context has no business holding a stored attachment
// row. So every method was declared in names an ADAPTER package — the only kind
// of package ADR M0.3 §2 permits to implement a driven port — had no way to
// spell. The same omission has now been found six times on this issue:
// `EndUserStore`, `SessionRevocationOrder`, `cost-monitoring`'s whole aggregate
// set, `secrets`' two, `skills`' eleven, and this. It is repaired the same way
// each time — the port entry point publishes exactly what the port's own
// signatures use, and nothing more.
//
// THE VALUE EXPORTS ARE HERE FOR A STRONGER REASON THAN THE TYPES.
// `artifactRevisionConflict` is the error `insertArtifactRevision`'s own comment
// REQUIRES an implementation to answer with — "an implementation MUST surface a
// violation as `FILES_ARTIFACT_REVISION_CONFLICT`" — and a store unable to name
// it would have minted a second error with the same code, which is how one
// vocabulary becomes two. `attachmentNotFound` is the same obligation on the
// other aggregate: `updateAttachmentBinding` is handed a whole `Attachment` and
// has to be able to say that no row with THAT owner and THAT id exists, which
// is a different sentence from "the store is unavailable". `repositoryUnavailable`
// is the ONE refusal `domain/errors.ts` says a store may answer with for
// everything else. `boundTo` and
// `PENDING_BINDING` are the two states of `AttachmentBinding`, which is a UNION
// rather than a nullable column precisely so a store cannot rebuild it by
// guessing; `attachmentTurnId` is the one place that union becomes the column.
// `threadScope`, `attachmentScope` and `threadPath` are the one place a scope
// becomes a key, and a store that re-derived the path would be a second
// statement of the rule that decides whether a blob belongs to a tenant.
//
// The kernel values these signatures name are republished for the reason
// `identity-access`'s, `cost-monitoring`'s, `secrets`' and `skills`' port entry
// points republish theirs: `Result`, `TransactionScope` and the scope types are
// in nearly every method above, and an adapter that reached for `@platos/kernel`
// directly would be a second import edge into the kernel from a package whose
// only declared dependency is the context whose port it satisfies.
export type { EnvironmentScope, JsonValue, NotResult, OrganizationScope, PrincipalId, ProjectScope, Result, TenantScope, TransactionScope } from "@platos/kernel";
// WIN-260 (M2.5): `runResult` joins them, and `NotResult` beside it.
// `UnitOfWork.run` REFUSES a callback whose answer is a `Result` — such a
// callback RESOLVES, and a resolved callback COMMITS, which is the defect
// `cost-monitoring` shipped — so `runResult` is the only way to end a unit of
// work with a failure, and every canonical store's suite needs it. It is
// republished HERE rather than imported from `@platos/kernel` in the adapter,
// for the reason stated above: that would be the second import edge into the
// kernel this paragraph exists to refuse.
export { asIdentifier, contains, err, ok, resolvePath, runResult } from "@platos/kernel";

export type {
  AgentId,
  ArtifactId,
  ArtifactKey,
  ArtifactKind,
  ArtifactRevision,
  Attachment,
  AttachmentBinding,
  AttachmentId,
  AttachmentKind,
  AttachmentMedia,
  AttachmentOwner,
  AttachmentScope,
  ContentHash,
  EndUserId,
  StorageKey,
  ThreadId,
  ThreadScope,
  TurnId,
} from "../../domain/index.js";
export {
  artifactRevisionConflict,
  attachmentNotFound,
  attachmentScope,
  attachmentTurnId,
  boundTo,
  FIRST_ARTIFACT_REVISION,
  NO_MEDIA_DIMENSIONS,
  PENDING_BINDING,
  repositoryUnavailable,
  sameEnvironment,
  sameThreadScope,
  threadPath,
  threadScope,
  toThreadScope,
} from "../../domain/index.js";
