// The `Artifact` aggregate — a versioned inline document.
//
// This is the other half of the context and it is nothing like an attachment.
// `content` lives inline in Postgres, not in a bucket, so there is no key, no
// grant, no blob and no two-system destruction problem. What it has instead is a
// version history: `@@unique([threadId, artifactKey, revision])`.
//
// One logical artifact is the set of rows sharing `(threadId, artifactKey)`.
// A revision is one row in that set. There is no "the artifact" row to update.
//
// ON `kind` AND `mimeType`. Both columns are free-form (`String` and `String?`)
// and stay open here. `kind` is validated for shape, not membership. The
// meta-tool layer in the current runtime narrows `kind` to a seven-value
// allow-list at ITS entry point; that is a transport-level policy over an open
// column, and moving it into the domain would narrow the column.

import type { JsonValue, PrincipalId } from "@platos/kernel";

import type { ArtifactId, ArtifactKey, TurnId } from "./identifiers.js";
import type { ThreadScope } from "./scope.js";

/** Open by construction: the column is `String`. */
export type ArtifactKind = string;

/** Revisions are 1-based, matching `revision Int @default(1)`. */
export const FIRST_ARTIFACT_REVISION = 1;

export interface ArtifactRevision {
  readonly artifactId: ArtifactId;
  readonly scope: ThreadScope;
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

/** The identity of one logical artifact — the pair the unique is keyed on. */
export interface ArtifactIdentity {
  readonly scope: ThreadScope;
  readonly artifactKey: ArtifactKey;
}

export function artifactIdentity(revision: ArtifactRevision): ArtifactIdentity {
  return { scope: revision.scope, artifactKey: revision.artifactKey };
}

export function isFirstRevision(revision: ArtifactRevision): boolean {
  return revision.revision === FIRST_ARTIFACT_REVISION;
}

/** UTF-8 byte length, which is what the column's size actually costs. */
export function contentByteLength(content: string): number {
  return new TextEncoder().encode(content).length;
}

/**
 * Order a revision set newest-first without mutating the input. Reads that want
 * "the latest" must go through this rather than trusting insertion order.
 */
export function byRevisionDescending(revisions: readonly ArtifactRevision[]): readonly ArtifactRevision[] {
  return [...revisions].sort((left, right) => right.revision - left.revision);
}

export function latestRevision(revisions: readonly ArtifactRevision[]): ArtifactRevision | null {
  return byRevisionDescending(revisions)[0] ?? null;
}
