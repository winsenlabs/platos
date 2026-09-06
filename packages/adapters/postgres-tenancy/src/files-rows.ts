// Stored row in, domain value out — and every column that can lie VALIDATED
// rather than cast.
//
// WHY VALIDATION AND NOT A CAST, COLUMN BY COLUMN. This context's two tables are
// unusually well constrained compared with `skills`' or `channels`' — there is a
// real CHECK behind `Artifact.metadata` and a real trigger behind every ancestry
// — so the honest list of what this file has to defend against is SHORT, and
// saying which columns are safe is as much a part of the record as saying which
// are not.
//
//   `bytes`, `width`, `height`, `durationSec` carry NO CHECK. `bytes` is summed
//     into `sumAttachmentBytes`, which is an organization's quota input, so one
//     negative row is headroom a tenant did not buy. The three measurements are
//     the same problem one dimension over. A row holding any of them is
//     REPRESENTABLE — the write guard in `files-guards.ts` is this binary's
//     refusal, not the column's — so a row an older binary wrote is exactly the
//     row a read has to survive, and refusing it is what stops a wrong number
//     reaching a quota decision.
//
//   `revision` carries no CHECK either, and it is worse than a measurement.
//     `nextRevisionNumber` in `domain/artifact-revision.ts` answers `latest + 1`,
//     so a stored `0` makes the next write target `1` — which is where the FIRST
//     revision already is, and the append-only unique would refuse a write that
//     is correct.
//
//   `metadata` IS checked, by `Artifact_metadata_json_root`
//     (`metadata IS NULL OR jsonb_typeof("metadata") = 'object'`), and that check
//     is exactly the shape `Readonly<Record<string, JsonValue>> | null` needs.
//     `'null'::jsonb` has `jsonb_typeof = 'null'` and is refused by it; SQL NULL
//     reads back as `null`. So this file does NOT re-validate it and says why,
//     rather than adding a guard nothing in the database can falsify.
//
//   `kind` and `mimeType` are free-form `TEXT` on both sides. `domain/attachment.ts`
//     is explicit that neither is an enum — "a caller-supplied `kind` is taken
//     verbatim" — so there is no closed set to validate against and a cast would
//     not be a cast, it would be the type.
//
// *** THE SCOPE IS NOT ON THE ROW AND HAS TO BE RESOLVED. *** Both tables store
// `environmentId` and nothing above it, while both aggregates carry a full
// `EnvironmentScope` — three ids. Every read here therefore arrives with the
// environment's two parents joined on, and a row whose environment does not
// join through a project to an organization is REFUSED rather than read with
// guessed parents. It is reachable: `Environment -> Project` is a real foreign
// key, so the only way to see it is a LEFT JOIN, which is what the reads use so
// that the refusal is a value rather than a missing row.

import type {
  ArtifactId,
  ArtifactKey,
  ArtifactRevision,
  Attachment,
  AttachmentId,
  ContentHash,
  EnvironmentScope,
  JsonValue,
  PrincipalId,
  Result,
  StorageKey,
  ThreadId,
  TurnId,
} from "@platos/context-files/application/ports/index.js";
import {
  asIdentifier,
  boundTo,
  err,
  ok,
  PENDING_BINDING,
  repositoryUnavailable,
} from "@platos/context-files/application/ports/index.js";

/** The row's environment does not join through a project to an organization. */
export const UNRESOLVED_SCOPE_ANCESTRY = "files.row.unresolved_scope_ancestry";

/** `bytes`, `width`, `height` or `durationSec` holds a number this binary will not read. */
export const UNREADABLE_ATTACHMENT_MEASURE = "files.row.unreadable_attachment_measure";

/** `Artifact.revision` holds a number the append-only rule cannot count from. */
export const UNREADABLE_ARTIFACT_REVISION = "files.row.unreadable_artifact_revision";

/** The summed `bytes` of an organization exceeds what a `number` can carry exactly. */
export const UNREADABLE_TOTAL_BYTES = "files.row.unreadable_total_bytes";

/**
 * The four codes above become the ONE code a caller may see.
 *
 * `files/domain/errors.ts` publishes exactly `FILES_REPOSITORY_UNAVAILABLE` for
 * a store failure, which is right for a caller — a read that cannot be trusted
 * has one thing to do whatever the cause — and useless for an operator. So the
 * distinct code LEADS `details.reason` and the row that carries it follows: a
 * caller matches on the code it was given, an operator greps for the one that
 * actually happened.
 *
 * There is deliberately no thrown `UnreadableRowError` here, unlike `skills`'
 * and `secrets`' halves of this package. Every read below returns a `Result`
 * already, so a throw would be a second mechanism for one outcome.
 */
function unreadable<Value>(code: string, detail: string): Result<Value> {
  return err(repositoryUnavailable(`${code}: ${detail}`));
}

/** The ancestry every scoped row is read with: its environment's two parents. */
export interface RowAncestry {
  readonly environmentId: string;
  readonly projectId: string | null;
  readonly organizationId: string | null;
}

export function readScope(ancestry: RowAncestry, where: string): Result<EnvironmentScope> {
  if (ancestry.projectId === null || ancestry.organizationId === null) {
    return unreadable<EnvironmentScope>(UNRESOLVED_SCOPE_ANCESTRY, where);
  }
  return ok({
    level: "environment",
    organizationId: asIdentifier(ancestry.organizationId),
    projectId: asIdentifier(ancestry.projectId),
    environmentId: asIdentifier(ancestry.environmentId),
  });
}

/** `MessageAttachment`, joined to the two parents of its environment. */
export interface AttachmentRow extends RowAncestry {
  readonly id: string;
  readonly endUserId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly kind: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSec: number | null;
  readonly storageKey: string;
  readonly originalName: string | null;
  readonly contentHash: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
}

/** `Artifact`, joined the same way. */
export interface ArtifactRow extends RowAncestry {
  readonly id: string;
  readonly threadId: string;
  readonly producedByTurnId: string | null;
  readonly artifactKey: string;
  readonly revision: number;
  readonly kind: string;
  readonly title: string | null;
  readonly mimeType: string | null;
  readonly content: string;
  readonly metadata: unknown;
  readonly createdBy: string;
  readonly createdAt: Date;
}

/** A measurement column, read totally: whole numbers, floored at zero. */
function readMeasure(value: number, field: string, where: string): Result<number> {
  if (!Number.isInteger(value) || value < 0) {
    return unreadable<number>(UNREADABLE_ATTACHMENT_MEASURE, `${where}.${field}=${String(value)}`);
  }
  return ok(value);
}

function readOptionalMeasure(
  value: number | null,
  field: string,
  where: string,
): Result<number | null> {
  if (value === null) return ok(null);
  const read = readMeasure(value, field, where);
  return read.ok ? ok(read.value) : err(read.error);
}

export function readAttachmentRow(row: AttachmentRow): Result<Attachment> {
  const where = `MessageAttachment/${row.id}`;
  const scope = readScope(row, where);
  if (!scope.ok) return err(scope.error);
  const bytes = readMeasure(row.bytes, "bytes", where);
  if (!bytes.ok) return err(bytes.error);
  const width = readOptionalMeasure(row.width, "width", where);
  if (!width.ok) return err(width.error);
  const height = readOptionalMeasure(row.height, "height", where);
  if (!height.ok) return err(height.error);
  const durationSeconds = readOptionalMeasure(row.durationSec, "durationSec", where);
  if (!durationSeconds.ok) return err(durationSeconds.error);
  return ok({
    attachmentId: asIdentifier<AttachmentId>(row.id),
    scope: {
      environment: scope.value,
      threadId: asIdentifier<ThreadId>(row.threadId),
      owner: {
        endUserId: asIdentifier(row.endUserId),
        agentId: asIdentifier(row.agentId),
      },
    },
    // The union is rebuilt from the column here and NOWHERE else. `turnId` is
    // nullable and the two states have different rules, so `domain/attachment.ts`
    // models them as a union; a store that carried the null through would have
    // put the question back into every caller.
    binding: row.turnId === null ? PENDING_BINDING : boundTo(asIdentifier<TurnId>(row.turnId)),
    kind: row.kind,
    mimeType: row.mimeType,
    bytes: bytes.value,
    media: { width: width.value, height: height.value, durationSeconds: durationSeconds.value },
    storageKey: asIdentifier<StorageKey>(row.storageKey),
    originalName: row.originalName,
    contentHash: row.contentHash === null ? null : asIdentifier<ContentHash>(row.contentHash),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  });
}

export function readArtifactRow(row: ArtifactRow): Result<ArtifactRevision> {
  const where = `Artifact/${row.id}`;
  const scope = readScope(row, where);
  if (!scope.ok) return err(scope.error);
  if (!Number.isInteger(row.revision) || row.revision < 1) {
    return unreadable<ArtifactRevision>(
      UNREADABLE_ARTIFACT_REVISION,
      `${where}.revision=${String(row.revision)}`,
    );
  }
  return ok({
    artifactId: asIdentifier<ArtifactId>(row.id),
    scope: { environment: scope.value, threadId: asIdentifier<ThreadId>(row.threadId) },
    artifactKey: asIdentifier<ArtifactKey>(row.artifactKey),
    revision: row.revision,
    kind: row.kind,
    title: row.title,
    mimeType: row.mimeType,
    content: row.content,
    // NOT re-validated, and the header says why: `Artifact_metadata_json_root`
    // is a real CHECK on this column, and `jsonb_typeof(...) = 'object'` is
    // exactly the shape this field's type requires. A guard here would be one
    // nothing in the database could falsify.
    metadata: row.metadata as Readonly<Record<string, JsonValue>> | null,
    producedByTurnId:
      row.producedByTurnId === null ? null : asIdentifier<TurnId>(row.producedByTurnId),
    createdBy: asIdentifier<PrincipalId>(row.createdBy),
    createdAt: row.createdAt,
  });
}

/**
 * The organization-wide byte total, read from a `bigint`.
 *
 * `sum(integer)` on PostgreSQL is `bigint`, and the port answers a `number`.
 * Below 2^53 the conversion is exact and above it is silently not, so the
 * ceiling is checked rather than assumed: a quota decision taken on a rounded
 * total is a decision taken on a number nobody wrote.
 */
export function readTotalBytes(total: bigint, where: string): Result<number> {
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < 0n) {
    return unreadable<number>(UNREADABLE_TOTAL_BYTES, `${where}=${total.toString()}`);
  }
  return ok(Number(total));
}
