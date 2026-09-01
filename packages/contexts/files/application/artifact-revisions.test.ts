import { asIdentifier, type PrincipalId } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import type { ArtifactKey } from "../domain/index.js";
import { readArtifactRevision } from "./read-artifact-revision.js";
import { buildFilesTestContext, testThreadScope, type FilesTestContext } from "./testing/index.js";
import { writeArtifactRevision } from "./write-artifact-revision.js";

const KEY = asIdentifier<ArtifactKey>("a_report");
const AUTHOR: PrincipalId = asIdentifier("principal-1");

describe("writeArtifactRevision — append-only", () => {
  let context: FilesTestContext;

  beforeEach(() => {
    context = buildFilesTestContext();
  });

  async function append(content: string, kind = "markdown") {
    return writeArtifactRevision(context.dependencies, {
      scope: testThreadScope("env-1"),
      artifactKey: KEY,
      kind,
      content,
      createdBy: AUTHOR,
    });
  }

  it("writes revision 1 for a brand-new artifact key", async () => {
    const written = await append("# one");
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error("unreachable");
    expect(written.value.revision).toBe(1);
  });

  it("appends a NEW ROW per revision and never mutates the previous one", async () => {
    const first = await append("# one");
    const second = await append("# two");
    const third = await append("# three");
    if (!first.ok || !second.ok || !third.ok) throw new Error("unreachable");

    expect([first.value.revision, second.value.revision, third.value.revision]).toEqual([1, 2, 3]);
    const rows = context.repository.allArtifactRevisions();
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.content)).toEqual(["# one", "# two", "# three"]);
    expect(new Set(rows.map((row) => row.artifactId)).size).toBe(3);
  });

  it("REFUSES a revision that changes the kind fixed by revision 1", async () => {
    await append("# one", "markdown");
    const denied = await append("<p>two</p>", "html");
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("FILES_ARTIFACT_KIND_IMMUTABLE");
  });

  it("REFUSES a write at an occupied [threadId, artifactKey, revision] as a conflict", async () => {
    await append("# one");
    // The racing writer: revision 2 is claimed by someone else in the window
    // between this write reading the latest revision and checking the slot it
    // planned. A silent bump to revision 3 here would let both writers believe
    // they produced revision 2.
    const occupant = context.repository.allArtifactRevisions()[0];
    if (occupant === undefined) throw new Error("unreachable");
    context.repository.hookAfterLatestLookup = () => {
      context.repository.seedArtifactRevision({ ...occupant, artifactId: asIdentifier("art-x"), revision: 2 });
    };

    const denied = await append("# two");
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("FILES_ARTIFACT_REVISION_CONFLICT");
    expect(denied.error.category).toBe("conflict");
  });

  it("lets the repository's unique constraint refuse a duplicate insert directly", async () => {
    const first = await append("# one");
    if (!first.ok) throw new Error("unreachable");
    const rows = context.repository.allArtifactRevisions();
    const row = rows[0];
    if (row === undefined) throw new Error("unreachable");
    const duplicate = await context.repository.insertArtifactRevision(
      { ...row, artifactId: asIdentifier("art-dup") },
      { transactionId: asIdentifier("txn-x") },
    );
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) throw new Error("unreachable");
    expect(duplicate.error.code).toBe("FILES_ARTIFACT_REVISION_CONFLICT");
  });

  it("keeps one thread's revisions out of another thread's history", async () => {
    await append("# one");
    const elsewhere = await writeArtifactRevision(context.dependencies, {
      scope: testThreadScope("env-1", "thread-2"),
      artifactKey: KEY,
      kind: "markdown",
      content: "# other",
      createdBy: AUTHOR,
    });
    if (!elsewhere.ok) throw new Error("unreachable");
    expect(elsewhere.value.revision).toBe(1);
  });

  it("refuses oversized content before a row is written", async () => {
    const denied = await append("x".repeat(2 * 1024 * 1024));
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("FILES_ARTIFACT_CONTENT_TOO_LARGE");
    expect(context.repository.allArtifactRevisions()).toHaveLength(0);
  });
});

describe("readArtifactRevision — no silent latest fallback", () => {
  let context: FilesTestContext;

  beforeEach(async () => {
    context = buildFilesTestContext();
    for (const content of ["# one", "# two", "# three"]) {
      const written = await writeArtifactRevision(context.dependencies, {
        scope: testThreadScope("env-1"),
        artifactKey: KEY,
        kind: "markdown",
        content,
        createdBy: AUTHOR,
      });
      if (!written.ok) throw new Error(written.error.code);
    }
  });

  it("returns the latest when no revision is named", async () => {
    const read = await readArtifactRevision(context.dependencies, {
      scope: testThreadScope("env-1"),
      artifactKey: KEY,
    });
    if (!read.ok) throw new Error("unreachable");
    expect(read.value.revision).toBe(3);
    expect(read.value.content).toBe("# three");
  });

  it("returns exactly the revision that was named", async () => {
    const read = await readArtifactRevision(context.dependencies, {
      scope: testThreadScope("env-1"),
      artifactKey: KEY,
      revision: 2,
    });
    if (!read.ok) throw new Error("unreachable");
    expect(read.value.content).toBe("# two");
  });

  it("FAILS for a revision that does not exist rather than returning the latest", async () => {
    const denied = await readArtifactRevision(context.dependencies, {
      scope: testThreadScope("env-1"),
      artifactKey: KEY,
      revision: 9,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("FILES_ARTIFACT_REVISION_NOT_FOUND");
    expect(denied.error.category).toBe("not_found");
  });

  it("FAILS for an artifact read from another environment", async () => {
    const denied = await readArtifactRevision(context.dependencies, {
      scope: testThreadScope("env-2"),
      artifactKey: KEY,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("FILES_ARTIFACT_REVISION_NOT_FOUND");
  });
});
