// ONE scenario, written once, run against the in-memory double and against real
// PostgreSQL — and the two observation maps compared VERBATIM by
// `files-conformance.integration.test.ts`.
//
// WHY A DIFFERENTIAL AND NOT TWO SUITES. Two independently written suites measure
// two things and agree by coincidence; this measures ONE thing twice.
// `InMemoryFilesRepository`'s own header claims that two of its behaviours "are
// load-bearing rather than convenient" and that each "mirrors a constraint the
// real schema enforces" — the append-only unique, and scope filtering on every
// read. Every use-case suite in `packages/contexts/files` is written against that
// claim. This is where it is checked rather than admired.
//
// EVERY IDENTIFIER IS A REAL UUID ON BOTH SIDES. `SequenceIdGenerator` in the
// context's own fixtures mints `id-0001` and `testThreadScope` mints `org-1`,
// `proj-1`, `thread-1`, `end-user-1` and `agent-1`; all five satisfy the double
// and every one is refused by `@db.Uuid`. Feeding the double the shapes the
// database accepts is what makes a divergence a BEHAVIOUR difference rather than
// a shape one — the shape refusals have their own named cases in
// `files-constraints.integration.test.ts`.
//
// *** WHAT IS DELIBERATELY NOT IN THIS SCENARIO, AND WHY ***
// A differential can only ask questions both sides are entitled to answer. Three
// are asked in the constraints suite instead, because the two stores DISAGREE and
// the real one is right:
//
//   `updateAttachmentBinding` ON A ROW THAT DOES NOT EXIST. The double's is
//   `Map.set`, so it CREATES the row and answers `ok` — an upsert wearing an
//   update's name. The real store puts the four owner columns in the `WHERE` and
//   answers `FILES_ATTACHMENT_NOT_FOUND`.
//
//   `insertAttachment` TWICE AT ONE ID. The double's `Map.set` overwrites; the
//   primary key does not.
//
//   A WRITE UNDER A FORGED SCOPE. The double stores the claim and later finds the
//   row under it; the real store re-reads the environment's parents and refuses.
//
// They are reported as findings rather than smoothed over, and each has a named
// case against the real database.

import type {
  ArtifactId,
  ArtifactKey,
  ArtifactRevision,
  Attachment,
  AttachmentId,
  AttachmentScope,
  ContentHash,
  EnvironmentScope,
  FilesRepository,
  OrganizationScope,
  PrincipalId,
  StorageKey,
  ThreadScope,
  TransactionScope,
  TurnId,
} from "@platos/context-files/application/ports/index.js";
import { asIdentifier, boundTo, PENDING_BINDING } from "@platos/context-files/application/ports/index.js";

/** One tenant, as the scenario addresses it. */
export interface FilesConformanceChain {
  readonly organization: OrganizationScope;
  readonly environment: EnvironmentScope;
  readonly thread: ThreadScope;
  readonly attachment: AttachmentScope;
  readonly turnId: TurnId;
  readonly secondTurnId: TurnId;
}

/** Identifiers that must resolve to nothing on both sides. */
export interface FilesConformanceIds {
  readonly missingAttachmentId: string;
}

export interface FilesConformanceEnvironment {
  readonly repository: FilesRepository;
  readonly chain: FilesConformanceChain;
  readonly foreign: FilesConformanceChain;
  readonly ids: FilesConformanceIds;
  run<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value>;
}

export type FilesObservation = Record<string, unknown>;

/** The instant the scenario is anchored at. Nothing here reads a clock. */
const T0 = Date.parse("2026-06-01T00:00:00.000Z");
const MINUTE = 60_000;

/** The one artifact key every revision in the scenario shares. */
export const CONFORMANCE_KEY = asIdentifier<ArtifactKey>("report.summary");

/** The principal every artifact is authored by, and the erasure's subject half. */
export const CONFORMANCE_PRINCIPAL = asIdentifier<PrincipalId>("user_conformance_author");

/** Deterministic ids, identical on both sides so a row can be named in a failure. */
function mint(kind: string, ordinal: number): string {
  return `eeeeeeee-${kind}-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

interface AttachmentDraft {
  readonly ordinal: number;
  readonly scope: AttachmentScope;
  readonly bytes: number;
  readonly contentHash: string | null;
  readonly minutes: number;
  readonly expiresMinutes: number | null;
}

function attachmentOf(draft: AttachmentDraft): Attachment {
  const attachmentId = asIdentifier<AttachmentId>(mint("0001", draft.ordinal));
  return {
    attachmentId,
    scope: draft.scope,
    binding: PENDING_BINDING,
    kind: "document",
    mimeType: "application/pdf",
    bytes: draft.bytes,
    media: { width: null, height: null, durationSeconds: null },
    storageKey: asIdentifier<StorageKey>(`conformance/${attachmentId}/file.pdf`),
    originalName: "file.pdf",
    contentHash: draft.contentHash === null ? null : asIdentifier<ContentHash>(draft.contentHash),
    createdAt: new Date(T0 + draft.minutes * MINUTE),
    expiresAt: draft.expiresMinutes === null ? null : new Date(T0 + draft.expiresMinutes * MINUTE),
  };
}

function revisionOf(
  ordinal: number,
  scope: ThreadScope,
  revision: number,
  producedByTurnId: TurnId | null,
): ArtifactRevision {
  return {
    artifactId: asIdentifier<ArtifactId>(mint("0002", ordinal)),
    scope,
    artifactKey: CONFORMANCE_KEY,
    revision,
    kind: "markdown",
    title: `revision ${String(revision)}`,
    mimeType: "text/markdown",
    content: `# revision ${String(revision)}`,
    metadata: revision === 1 ? null : { source: "conformance" },
    producedByTurnId,
    createdBy: CONFORMANCE_PRINCIPAL,
    createdAt: new Date(T0 + revision * MINUTE),
  };
}

/**
 * Run the scenario and return one flat map of step name to observation.
 *
 * FLAT AND NOT NESTED, so a divergence names the CALL. A nested structure
 * compared with `toEqual` reports the whole tree, and the tranche-2 experience
 * that shaped this shape was a two-hundred-line diff with one wrong field in it.
 */
export async function runFilesConformance(
  environment: FilesConformanceEnvironment,
): Promise<FilesObservation> {
  const { repository, chain, foreign, ids } = environment;
  const observed: FilesObservation = {};
  const record = (step: string, value: unknown): void => {
    observed[step] = value;
  };

  const missing = asIdentifier<AttachmentId>(ids.missingAttachmentId);

  // --- MessageAttachment: the pointer half -----------------------------------
  const first = attachmentOf({
    ordinal: 1,
    scope: chain.attachment,
    bytes: 11,
    contentHash: "sha256:aaaa",
    minutes: 1,
    expiresMinutes: 10,
  });
  const second = attachmentOf({
    ordinal: 2,
    scope: chain.attachment,
    bytes: 22,
    contentHash: null,
    minutes: 2,
    expiresMinutes: null,
  });
  const foreignAttachment = attachmentOf({
    ordinal: 3,
    scope: foreign.attachment,
    bytes: 5,
    // THE SAME HASH IN A SECOND TENANT. Dedupe is permitted across threads and
    // never across environments, and a probe that ignored the environment would
    // hand one tenant a pointer at another tenant's blob.
    contentHash: "sha256:aaaa",
    minutes: 3,
    expiresMinutes: 10,
  });

  record("insertAttachment.first", await environment.run((t) => repository.insertAttachment(first, t)));
  record("insertAttachment.second", await environment.run((t) => repository.insertAttachment(second, t)));
  record(
    "insertAttachment.foreign",
    await environment.run((t) => repository.insertAttachment(foreignAttachment, t)),
  );

  record("findAttachment.first", await repository.findAttachment(chain.thread, first.attachmentId));
  record("findAttachment.missing", await repository.findAttachment(chain.thread, missing));
  record(
    "findAttachment.crossTenant",
    await repository.findAttachment(foreign.thread, first.attachmentId),
  );
  record(
    "findAttachmentsInScope.both",
    await repository.findAttachmentsInScope(chain.thread, [
      first.attachmentId,
      second.attachmentId,
      missing,
    ]),
  );
  record("findAttachmentsInScope.empty", await repository.findAttachmentsInScope(chain.thread, []));
  record(
    "findAttachmentsInScope.crossTenant",
    await repository.findAttachmentsInScope(foreign.thread, [first.attachmentId]),
  );

  record(
    "findAttachmentByContentHash.here",
    await repository.findAttachmentByContentHash(
      chain.environment,
      asIdentifier<ContentHash>("sha256:aaaa"),
    ),
  );
  record(
    "findAttachmentByContentHash.foreignEnvironment",
    await repository.findAttachmentByContentHash(
      foreign.environment,
      asIdentifier<ContentHash>("sha256:aaaa"),
    ),
  );
  record(
    "findAttachmentByContentHash.absent",
    await repository.findAttachmentByContentHash(
      chain.environment,
      asIdentifier<ContentHash>("sha256:zzzz"),
    ),
  );

  record("sumAttachmentBytes.here", await repository.sumAttachmentBytes(chain.organization));
  record("sumAttachmentBytes.foreign", await repository.sumAttachmentBytes(foreign.organization));

  record("listElapsedAttachments.before", await repository.listElapsedAttachments(new Date(T0), 10));
  record(
    "listElapsedAttachments.after",
    await repository.listElapsedAttachments(new Date(T0 + 20 * MINUTE), 10),
  );
  record(
    "listElapsedAttachments.limited",
    await repository.listElapsedAttachments(new Date(T0 + 20 * MINUTE), 1),
  );
  record(
    "listElapsedAttachments.zeroLimit",
    await repository.listElapsedAttachments(new Date(T0 + 20 * MINUTE), 0),
  );

  const bound: Attachment = {
    ...first,
    binding: boundTo(chain.turnId),
    expiresAt: new Date(T0 + 1000 * MINUTE),
  };
  record(
    "updateAttachmentBinding.bind",
    await environment.run((t) => repository.updateAttachmentBinding(bound, t)),
  );
  record("findAttachment.afterBind", await repository.findAttachment(chain.thread, first.attachmentId));
  record(
    "updateAttachmentBinding.idempotent",
    await environment.run((t) => repository.updateAttachmentBinding(bound, t)),
  );
  record(
    "listElapsedAttachments.afterBind",
    await repository.listElapsedAttachments(new Date(T0 + 20 * MINUTE), 10),
  );

  record(
    "deleteAttachment.crossTenant",
    await environment.run((t) => repository.deleteAttachment(foreign.thread, second.attachmentId, t)),
  );
  record(
    "deleteAttachment.second",
    await environment.run((t) => repository.deleteAttachment(chain.thread, second.attachmentId, t)),
  );
  record(
    "deleteAttachment.again",
    await environment.run((t) => repository.deleteAttachment(chain.thread, second.attachmentId, t)),
  );
  record("sumAttachmentBytes.afterDelete", await repository.sumAttachmentBytes(chain.organization));

  // --- Artifact: the versioned inline document half --------------------------
  record(
    "findLatestArtifactRevision.beforeAny",
    await repository.findLatestArtifactRevision(chain.thread, CONFORMANCE_KEY),
  );

  const revisionOne = revisionOf(1, chain.thread, 1, null);
  const revisionTwo = revisionOf(2, chain.thread, 2, chain.turnId);
  const foreignRevision = revisionOf(3, foreign.thread, 1, null);

  record(
    "insertArtifactRevision.one",
    await environment.run((t) => repository.insertArtifactRevision(revisionOne, t)),
  );
  record(
    "findLatestArtifactRevision.afterOne",
    await repository.findLatestArtifactRevision(chain.thread, CONFORMANCE_KEY),
  );
  record(
    "findArtifactRevision.exact",
    await repository.findArtifactRevision(chain.thread, CONFORMANCE_KEY, 1),
  );
  record(
    "findArtifactRevision.absentRevision",
    await repository.findArtifactRevision(chain.thread, CONFORMANCE_KEY, 2),
  );
  record(
    "insertArtifactRevision.two",
    await environment.run((t) => repository.insertArtifactRevision(revisionTwo, t)),
  );
  record(
    "findLatestArtifactRevision.afterTwo",
    await repository.findLatestArtifactRevision(chain.thread, CONFORMANCE_KEY),
  );
  // THE APPEND-ONLY UNIQUE, ASKED OF BOTH. The double's header claims it upholds
  // `@@unique([threadId, artifactKey, revision])`; this is the step that checks
  // the claim against the index that actually holds it.
  record(
    "insertArtifactRevision.conflict",
    await environment.run((t) =>
      repository.insertArtifactRevision({ ...revisionTwo, content: "rewritten" }, t),
    ),
  );
  record(
    "findLatestArtifactRevision.afterConflict",
    await repository.findLatestArtifactRevision(chain.thread, CONFORMANCE_KEY),
  );
  record(
    "insertArtifactRevision.foreignThread",
    await environment.run((t) => repository.insertArtifactRevision(foreignRevision, t)),
  );
  record(
    "findLatestArtifactRevision.crossTenant",
    await repository.findLatestArtifactRevision(foreign.thread, CONFORMANCE_KEY),
  );
  // The foreign thread holds revision 1 of the SAME key and no revision 2, so
  // this is a miss that a store ignoring the thread clause would answer with the
  // tenant's own row.
  record(
    "findArtifactRevision.crossTenant",
    await repository.findArtifactRevision(foreign.thread, CONFORMANCE_KEY, 2),
  );

  // --- Erasure: containment, and the two columns it matches on ---------------
  const organizationSelector = {
    scope: chain.organization,
    endUserId: chain.attachment.owner.endUserId as string,
    principalId: CONFORMANCE_PRINCIPAL as string,
  };
  const environmentSelector = { ...organizationSelector, scope: chain.environment };
  const foreignSelector = { ...organizationSelector, scope: foreign.organization };

  record(
    "countAttachmentsForSubject.organization",
    await repository.countAttachmentsForSubject(organizationSelector),
  );
  record(
    "countAttachmentsForSubject.environment",
    await repository.countAttachmentsForSubject(environmentSelector),
  );
  record(
    "countAttachmentsForSubject.foreign",
    await repository.countAttachmentsForSubject(foreignSelector),
  );
  record(
    "countAttachmentsForSubject.noSubject",
    await repository.countAttachmentsForSubject({ ...organizationSelector, endUserId: null }),
  );
  record(
    "listAttachmentsForSubject.organization",
    await repository.listAttachmentsForSubject(organizationSelector),
  );
  record(
    "listAttachmentsForSubject.noSubject",
    await repository.listAttachmentsForSubject({ ...organizationSelector, endUserId: null }),
  );
  record(
    "countArtifactRevisionsForSubject.organization",
    await repository.countArtifactRevisionsForSubject(organizationSelector),
  );
  record(
    "countArtifactRevisionsForSubject.foreign",
    await repository.countArtifactRevisionsForSubject(foreignSelector),
  );
  record(
    "countArtifactRevisionsForSubject.noPrincipal",
    await repository.countArtifactRevisionsForSubject({ ...organizationSelector, principalId: null }),
  );
  record(
    "deleteArtifactRevisionsForSubject.noPrincipal",
    await environment.run((t) =>
      repository.deleteArtifactRevisionsForSubject(
        { ...organizationSelector, principalId: null },
        t,
      ),
    ),
  );
  record(
    "deleteArtifactRevisionsForSubject.organization",
    await environment.run((t) =>
      repository.deleteArtifactRevisionsForSubject(organizationSelector, t),
    ),
  );
  record(
    "countArtifactRevisionsForSubject.afterErasure",
    await repository.countArtifactRevisionsForSubject(organizationSelector),
  );
  record(
    "findLatestArtifactRevision.afterErasure",
    await repository.findLatestArtifactRevision(chain.thread, CONFORMANCE_KEY),
  );
  // THE CONTAINMENT PROOF. The erasure was addressed at ONE organization, and the
  // other tenant's revision — same key, same author, same content — is still there.
  record(
    "findLatestArtifactRevision.foreignSurvives",
    await repository.findLatestArtifactRevision(foreign.thread, CONFORMANCE_KEY),
  );
  record(
    "deleteArtifactRevisionsForSubject.again",
    await environment.run((t) =>
      repository.deleteArtifactRevisionsForSubject(organizationSelector, t),
    ),
  );

  return observed;
}
