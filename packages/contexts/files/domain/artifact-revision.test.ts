import { asIdentifier, environmentScope } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  artifactIdentity,
  byRevisionDescending,
  contentByteLength,
  FIRST_ARTIFACT_REVISION,
  isFirstRevision,
  latestRevision,
  type ArtifactRevision,
} from "./artifact.js";
import {
  admitArtifactContent,
  admitArtifactKey,
  admitArtifactKind,
  admitRevisionSlot,
  nextRevisionNumber,
  planArtifactRevision,
  selectRevision,
} from "./artifact-revision.js";
import type { ArtifactId, ArtifactKey, ThreadId } from "./identifiers.js";
import { DEFAULT_FILES_POLICY } from "./policy.js";
import { threadScope, type ThreadScope } from "./scope.js";

const POLICY = DEFAULT_FILES_POLICY.artifact;
const KEY = asIdentifier<ArtifactKey>("a_report");

function scopeIn(environmentId: string, threadId = "thread-1"): ThreadScope {
  return threadScope(
    environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier(environmentId)),
    asIdentifier<ThreadId>(threadId),
  );
}

function revisionAt(revision: number, overrides: Partial<ArtifactRevision> = {}): ArtifactRevision {
  return {
    artifactId: asIdentifier<ArtifactId>(`art-${revision}`),
    scope: scopeIn("env-1"),
    artifactKey: KEY,
    revision,
    kind: "markdown",
    title: null,
    mimeType: null,
    content: "# hello",
    metadata: null,
    producedByTurnId: null,
    createdBy: asIdentifier("principal-1"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("admission", () => {
  it("accepts a well-shaped key and rejects one that is empty, long or has a separator", () => {
    expect(admitArtifactKey("a_report", POLICY).ok).toBe(true);
    expect(admitArtifactKey("", POLICY).ok).toBe(false);
    expect(admitArtifactKey("a/report", POLICY).ok).toBe(false);
    expect(admitArtifactKey("x".repeat(POLICY.maxKeyLength + 1), POLICY).ok).toBe(false);
  });

  it("keeps `kind` an OPEN string — any well-shaped token is accepted", () => {
    for (const kind of ["markdown", "html", "acme.custom-kind", "spreadsheet"]) {
      expect(admitArtifactKind(kind).ok).toBe(true);
    }
    expect(admitArtifactKind("").ok).toBe(false);
    expect(admitArtifactKind("has space").ok).toBe(false);
  });

  it("measures content in UTF-8 bytes, not code units", () => {
    expect(contentByteLength("é")).toBe(2);
    const oversized = "x".repeat(POLICY.maxContentBytes + 1);
    const denied = admitArtifactContent(oversized, POLICY);
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("FILES_ARTIFACT_CONTENT_TOO_LARGE");
  });

  it("rejects empty content", () => {
    expect(admitArtifactContent("", POLICY).ok).toBe(false);
  });
});

describe("append-only revisioning", () => {
  it("starts at 1 and then increments by exactly one", () => {
    expect(nextRevisionNumber(null)).toBe(FIRST_ARTIFACT_REVISION);
    expect(nextRevisionNumber(revisionAt(1))).toBe(2);
    expect(nextRevisionNumber(revisionAt(7))).toBe(8);
    expect(isFirstRevision(revisionAt(1))).toBe(true);
  });

  it("plans the next revision without touching the previous one", () => {
    const previous = revisionAt(1);
    const planned = planArtifactRevision(previous, {
      scope: previous.scope,
      artifactKey: KEY,
      kind: "markdown",
      content: "# revised",
      createdBy: previous.createdBy,
    }, POLICY);
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error("unreachable");
    expect(planned.value.revision).toBe(2);
    expect(previous.content).toBe("# hello");
  });

  it("REFUSES a revision that changes the kind fixed by revision 1", () => {
    const planned = planArtifactRevision(revisionAt(1, { kind: "markdown" }), {
      scope: scopeIn("env-1"),
      artifactKey: KEY,
      kind: "html",
      content: "<p>hi</p>",
      createdBy: asIdentifier("principal-1"),
    }, POLICY);
    expect(planned.ok).toBe(false);
    if (planned.ok) throw new Error("unreachable");
    expect(planned.error.code).toBe("FILES_ARTIFACT_KIND_IMMUTABLE");
    expect(planned.error.category).toBe("conflict");
  });

  it("REFUSES to write an occupied [threadId, artifactKey, revision] slot", () => {
    const denied = admitRevisionSlot(KEY, 2, revisionAt(2));
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("FILES_ARTIFACT_REVISION_CONFLICT");
    expect(denied.error.category).toBe("conflict");
  });

  it("accepts a free slot", () => {
    expect(admitRevisionSlot(KEY, 2, null).ok).toBe(true);
  });
});

describe("selectRevision — no silent fallback to the latest", () => {
  it("returns the latest when none was named", () => {
    const selected = selectRevision(KEY, null, revisionAt(7));
    expect(selected.ok).toBe(true);
    if (!selected.ok) throw new Error("unreachable");
    expect(selected.value.revision).toBe(7);
  });

  it("FAILS when a named revision does not exist rather than returning the latest", () => {
    const selected = selectRevision(KEY, 3, null);
    expect(selected.ok).toBe(false);
    if (selected.ok) throw new Error("unreachable");
    expect(selected.error.code).toBe("FILES_ARTIFACT_REVISION_NOT_FOUND");
    expect(selected.error.category).toBe("not_found");
  });

  it("FAILS when the row handed back is not the revision that was named", () => {
    const selected = selectRevision(KEY, 3, revisionAt(7));
    expect(selected.ok).toBe(false);
  });

  it("FAILS when the artifact key has no revisions at all", () => {
    expect(selectRevision(KEY, null, null).ok).toBe(false);
  });
});

describe("artifactIdentity", () => {
  it("is the (thread, key) pair the unique is built on — not the row id", () => {
    const first = artifactIdentity(revisionAt(1));
    const seventh = artifactIdentity(revisionAt(7));
    expect(first.artifactKey).toBe(seventh.artifactKey);
    expect(first.scope.threadId).toBe(seventh.scope.threadId);
    expect(Object.keys(first).sort()).toEqual(["artifactKey", "scope"]);
  });
});

describe("revision ordering", () => {
  it("orders newest first without mutating the input", () => {
    const rows = [revisionAt(1), revisionAt(3), revisionAt(2)];
    const ordered = byRevisionDescending(rows);
    expect(ordered.map((row) => row.revision)).toEqual([3, 2, 1]);
    expect(rows.map((row) => row.revision)).toEqual([1, 3, 2]);
    expect(latestRevision(rows)?.revision).toBe(3);
    expect(latestRevision([])).toBeNull();
  });
});
