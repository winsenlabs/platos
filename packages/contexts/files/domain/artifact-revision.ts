// Append-only revisioning.
//
// `@@unique([threadId, artifactKey, revision])` is not an incidental index. It
// makes "revise this artifact" structurally unable to mean "update that row":
// the only way to record a change is to INSERT a new row at `revision + 1`, and
// the database itself refuses a second write at a revision that exists.
//
// Three rules follow, and all three are enforced here rather than being left to
// the constraint, so a use case fails with a domain error before it reaches the
// database and so the rule is provable in memory:
//
//   1. The first revision is 1; every later one is exactly `latest + 1`.
//   2. `kind` is fixed by revision 1 and carried forward. A revision that
//      changes the kind is a different artifact wearing the same key.
//   3. Writing at an occupied revision is a CONFLICT — never an overwrite, never
//      a silent bump to the next free slot. A silent bump would let two
//      concurrent writers each believe they produced revision N.

import { err, ok, type JsonValue, type PrincipalId, type Result } from "@platos/kernel";

import type { ArtifactKind, ArtifactRevision } from "./artifact.js";
import { contentByteLength, FIRST_ARTIFACT_REVISION } from "./artifact.js";
import {
  artifactContentInvalid,
  artifactContentTooLarge,
  artifactKeyInvalid,
  artifactKindImmutable,
  artifactRevisionConflict,
  artifactRevisionNotFound,
} from "./errors.js";
import type { ArtifactKey, TurnId } from "./identifiers.js";
import type { FilesArtifactPolicy } from "./policy.js";
import type { ThreadScope } from "./scope.js";

/** Shape only: printable, no whitespace, no path separators. Not a value list. */
const ARTIFACT_TOKEN_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const ARTIFACT_KIND_MAX_LENGTH = 64;

export interface ArtifactRevisionDraft {
  readonly scope: ThreadScope;
  readonly artifactKey: ArtifactKey;
  readonly kind: ArtifactKind;
  readonly title?: string | null;
  readonly mimeType?: string | null;
  readonly content: string;
  readonly metadata?: Readonly<Record<string, JsonValue>> | null;
  readonly producedByTurnId?: TurnId | null;
  readonly createdBy: PrincipalId;
}

/** A draft that has passed every rule, with its revision number decided. */
export interface PlannedArtifactRevision {
  readonly draft: ArtifactRevisionDraft;
  readonly revision: number;
  readonly kind: ArtifactKind;
  readonly contentBytes: number;
}

export function admitArtifactKey(key: string, policy: FilesArtifactPolicy): Result<ArtifactKey> {
  if (key.length === 0 || key.length > policy.maxKeyLength || !ARTIFACT_TOKEN_SHAPE.test(key)) {
    return err(artifactKeyInvalid(`artifactKey must be 1-${policy.maxKeyLength} characters of [A-Za-z0-9._:-]`));
  }
  return ok(key as ArtifactKey);
}

export function admitArtifactKind(kind: string): Result<ArtifactKind> {
  const trimmed = kind.trim();
  if (trimmed.length === 0 || trimmed.length > ARTIFACT_KIND_MAX_LENGTH || !ARTIFACT_TOKEN_SHAPE.test(trimmed)) {
    return err(artifactKeyInvalid(`kind must be 1-${ARTIFACT_KIND_MAX_LENGTH} characters of [A-Za-z0-9._:-]`));
  }
  return ok(trimmed);
}

export function admitArtifactContent(content: string, policy: FilesArtifactPolicy): Result<number> {
  if (typeof content !== "string" || content.length === 0) {
    return err(artifactContentInvalid("artifact content must be a non-empty string"));
  }
  const bytes = contentByteLength(content);
  if (bytes > policy.maxContentBytes) return err(artifactContentTooLarge(bytes, policy.maxContentBytes));
  return ok(bytes);
}

/** Rule 1, on its own so the arithmetic has exactly one home. */
export function nextRevisionNumber(latest: ArtifactRevision | null): number {
  return latest === null ? FIRST_ARTIFACT_REVISION : latest.revision + 1;
}

/**
 * Rules 1 + 2, plus content admission. `latest` is the newest row currently
 * holding `(threadId, artifactKey)`, or null for a brand-new artifact.
 */
export function planArtifactRevision(
  latest: ArtifactRevision | null,
  draft: ArtifactRevisionDraft,
  policy: FilesArtifactPolicy,
): Result<PlannedArtifactRevision> {
  const key = admitArtifactKey(draft.artifactKey, policy);
  if (!key.ok) return err(key.error);
  const kind = admitArtifactKind(draft.kind);
  if (!kind.ok) return err(kind.error);
  const contentBytes = admitArtifactContent(draft.content, policy);
  if (!contentBytes.ok) return err(contentBytes.error);

  if (latest !== null && latest.kind !== kind.value) {
    return err(artifactKindImmutable(draft.artifactKey, latest.kind, kind.value));
  }

  return ok({
    draft,
    revision: nextRevisionNumber(latest),
    kind: kind.value,
    contentBytes: contentBytes.value,
  });
}

/**
 * Rule 3. `occupant` is whatever the repository found at the exact
 * `(threadId, artifactKey, revision)` triple this write is targeting.
 */
export function admitRevisionSlot(
  artifactKey: ArtifactKey,
  revision: number,
  occupant: ArtifactRevision | null,
): Result<number> {
  if (occupant !== null) return err(artifactRevisionConflict(artifactKey, revision));
  return ok(revision);
}

/**
 * Read one revision. A request for a revision that does not exist FAILS; it
 * never falls back to the latest. Returning newer content to a caller who asked
 * for revision 3 is how a cached render silently becomes wrong.
 */
export function selectRevision(
  artifactKey: ArtifactKey,
  requested: number | null,
  found: ArtifactRevision | null,
): Result<ArtifactRevision> {
  if (found === null) return err(artifactRevisionNotFound(artifactKey, requested));
  if (requested !== null && found.revision !== requested) {
    return err(artifactRevisionNotFound(artifactKey, requested));
  }
  return ok(found);
}
