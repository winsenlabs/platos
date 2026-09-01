// Use case: read one artifact revision.
//
// Two shapes, and the difference between them is the whole point:
//
//   revision omitted   "give me the current one" — the newest row for the key.
//   revision named     "give me revision 3" — and if revision 3 does not exist
//                      this FAILS with `FILES_ARTIFACT_REVISION_NOT_FOUND`. It
//                      does not fall back to the newest.
//
// The fallback is the tempting bug. A caller asking for revision 3 is usually
// re-rendering something it has already shown, citing, or diffing; handing it
// revision 7 instead produces an answer that is wrong in a way nothing detects.

import { err, type Result } from "@platos/kernel";

import { selectRevision, type ArtifactKey, type ArtifactRevision, type ThreadScope } from "../domain/index.js";
import type { FilesDependencies } from "./dependencies.js";

export interface ReadArtifactRevisionQuery {
  readonly scope: ThreadScope;
  readonly artifactKey: ArtifactKey;
  /** Null or omitted means "the latest"; a number means exactly that one. */
  readonly revision?: number | null;
}

export async function readArtifactRevision(
  dependencies: FilesDependencies,
  query: ReadArtifactRevisionQuery,
): Promise<Result<ArtifactRevision>> {
  const requested = query.revision ?? null;
  const found =
    requested === null
      ? await dependencies.repository.findLatestArtifactRevision(query.scope, query.artifactKey)
      : await dependencies.repository.findArtifactRevision(query.scope, query.artifactKey, requested);
  if (!found.ok) return err(found.error);
  return selectRevision(query.artifactKey, requested, found.value);
}
