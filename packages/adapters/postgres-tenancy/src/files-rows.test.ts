// The mapping boundary, unit-tested — the one `files` suite that needs no
// container, and the one that can reach the branches a container cannot.
//
// A CONTAINER ONLY EVER READS ROWS THIS BINARY WROTE, or rows the constraints
// suite planted through the ORM's own CLI. Two of the four unreadable-row
// refusals are reachable that way and are cased there against a real database.
// The other two are not, and this file is where they go red:
//
//   `files.row.unresolved_scope_ancestry` — an attachment or an artifact whose
//     environment does not resolve to a project and an organization. With
//     `MessageAttachment_environmentId_fkey`, `Artifact_environmentId_fkey` and
//     `Environment_projectId_fkey` in force this is UNREACHABLE from a live
//     database, and `files-attachments.ts` says so in as many words. It is
//     reachable HERE because the reads use an outer join, which is what makes
//     `projectId: string | null` the honest shape of the row rather than an
//     assumption the mapper inherits.
//
//   `files.row.unreadable_total_bytes` — a summed `bytes` past 2^53. Reaching it
//     through a statement would need nine petabytes of attachments in one
//     organization; reaching it here needs a `bigint`.
//
// THE POINT OF THE FILE IS NOT COVERAGE. It is that a guard nothing can falsify
// is a guard nobody has checked, and two of these four would otherwise be exactly
// that.

import { describe, expect, test } from "vitest";

import {
  readArtifactRow,
  readAttachmentRow,
  readTotalBytes,
  type ArtifactRow,
  type AttachmentRow,
} from "./files-rows.js";

const ENVIRONMENT = "bbbbbbbb-0033-4000-8000-000000000001";
const PROJECT = "bbbbbbbb-0002-4000-8000-000000000001";
const ORGANIZATION = "bbbbbbbb-0001-4000-8000-000000000001";
const THREAD = "bbbbbbbb-0038-4000-8000-000000000001";
const TURN = "bbbbbbbb-003a-4000-8000-000000000001";
const AT = new Date("2026-06-01T09:00:00.000Z");

function attachmentRow(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: "bbbbbbbb-0041-4000-8000-000000000001",
    environmentId: ENVIRONMENT,
    projectId: PROJECT,
    organizationId: ORGANIZATION,
    endUserId: "bbbbbbbb-0036-4000-8000-000000000001",
    agentId: "bbbbbbbb-0034-4000-8000-000000000001",
    threadId: THREAD,
    turnId: null,
    kind: "document",
    mimeType: "application/pdf",
    bytes: 1024,
    width: null,
    height: null,
    durationSec: null,
    storageKey: "org/x/attachment/y/file.pdf",
    originalName: "file.pdf",
    contentHash: null,
    createdAt: AT,
    expiresAt: null,
    ...overrides,
  };
}

function artifactRow(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: "bbbbbbbb-0042-4000-8000-000000000001",
    environmentId: ENVIRONMENT,
    projectId: PROJECT,
    organizationId: ORGANIZATION,
    threadId: THREAD,
    producedByTurnId: null,
    artifactKey: "report.summary",
    revision: 1,
    kind: "markdown",
    title: null,
    mimeType: null,
    content: "# summary",
    metadata: null,
    createdBy: "user_author",
    createdAt: AT,
    ...overrides,
  };
}

function reasonOf(result: { readonly ok: boolean }): string {
  if (result.ok) return "<not-a-refusal>";
  const error = (result as { readonly error?: unknown }).error;
  const details = (error as { readonly details?: { readonly reason?: string } }).details;
  return details?.reason ?? "<no-reason>";
}

describe("the scope is resolved from the join and refused when the join gives nothing", () => {
  test("an attachment whose environment resolves to no project is REFUSED, not guessed", () => {
    const read = readAttachmentRow(attachmentRow({ projectId: null }));
    expect(read.ok).toBe(false);
    expect(reasonOf(read)).toContain("files.row.unresolved_scope_ancestry");
    expect(reasonOf(read)).toContain("MessageAttachment/");
  });

  test("an attachment whose project resolves to no organization is REFUSED", () => {
    const read = readAttachmentRow(attachmentRow({ organizationId: null }));
    expect(reasonOf(read)).toContain("files.row.unresolved_scope_ancestry");
  });

  test("an artifact is refused on the same branch and names ITS table", () => {
    const read = readArtifactRow(artifactRow({ projectId: null }));
    expect(reasonOf(read)).toContain("files.row.unresolved_scope_ancestry");
    expect(reasonOf(read)).toContain("Artifact/");
  });

  test("a resolved ancestry becomes the three-id EnvironmentScope the port answers with", () => {
    const read = readAttachmentRow(attachmentRow());
    expect(read.ok && read.value.scope.environment).toEqual({
      level: "environment",
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
    });
  });
});

describe("the binding union is rebuilt from the column and nowhere else", () => {
  test("a null turnId is the pending state, not a bound state with a null turn", () => {
    const read = readAttachmentRow(attachmentRow({ turnId: null }));
    expect(read.ok && read.value.binding).toEqual({ state: "pending" });
  });

  test("a present turnId is the bound state carrying it", () => {
    const read = readAttachmentRow(attachmentRow({ turnId: TURN }));
    expect(read.ok && read.value.binding).toEqual({ state: "bound", turnId: TURN });
  });
});

describe("the measurement columns carry no CHECK, so the read is what refuses them", () => {
  test("a negative bytes is refused and the refusal names the column and the value", () => {
    const read = readAttachmentRow(attachmentRow({ bytes: -7 }));
    expect(reasonOf(read)).toContain("files.row.unreadable_attachment_measure");
    expect(reasonOf(read)).toContain("bytes=-7");
  });

  test("a fractional bytes is refused: the column is an integer and a number is not", () => {
    const read = readAttachmentRow(attachmentRow({ bytes: 1.5 }));
    expect(reasonOf(read)).toContain("bytes=1.5");
  });

  test("each of the three optional measurements is refused under its own field name", () => {
    expect(reasonOf(readAttachmentRow(attachmentRow({ width: -1 })))).toContain("width=-1");
    expect(reasonOf(readAttachmentRow(attachmentRow({ height: -1 })))).toContain("height=-1");
    expect(reasonOf(readAttachmentRow(attachmentRow({ durationSec: -1 })))).toContain(
      "durationSec=-1",
    );
  });

  test("a null measurement is absent rather than zero, because the column is nullable", () => {
    const read = readAttachmentRow(attachmentRow({ width: null, height: null, durationSec: null }));
    expect(read.ok && read.value.media).toEqual({ width: null, height: null, durationSeconds: null });
  });

  test("zero is a legal measurement and is NOT refused", () => {
    const read = readAttachmentRow(attachmentRow({ bytes: 0, width: 0 }));
    expect(read.ok).toBe(true);
  });
});

describe("Artifact.revision is what the append-only rule counts from", () => {
  test("revision 0 is refused, because `latest + 1` would collide with the first", () => {
    const read = readArtifactRow(artifactRow({ revision: 0 }));
    expect(reasonOf(read)).toContain("files.row.unreadable_artifact_revision");
    expect(reasonOf(read)).toContain("revision=0");
  });

  test("a negative revision is refused on the same branch", () => {
    expect(reasonOf(readArtifactRow(artifactRow({ revision: -1 })))).toContain("revision=-1");
  });

  test("revision 1 is the first and is not refused", () => {
    expect(readArtifactRow(artifactRow({ revision: 1 })).ok).toBe(true);
  });
});

describe("metadata is NOT re-validated, and the reason is a CHECK rather than a hope", () => {
  test("a stored object is handed over as it stands, unknown keys and all", () => {
    const read = readArtifactRow(artifactRow({ metadata: { source: "x", unheardOf: 1 } }));
    expect(read.ok && read.value.metadata).toEqual({ source: "x", unheardOf: 1 });
  });

  test("SQL NULL reads back as null", () => {
    const read = readArtifactRow(artifactRow({ metadata: null }));
    expect(read.ok && read.value.metadata).toBeNull();
  });
});

describe("the organization byte total crosses a bigint boundary the port's type does not have", () => {
  test("a total inside the safe integer range converts exactly", () => {
    expect(readTotalBytes(4096n, "where")).toEqual({ ok: true, value: 4096 });
  });

  test("a total at the boundary is still exact", () => {
    expect(readTotalBytes(BigInt(Number.MAX_SAFE_INTEGER), "where")).toEqual({
      ok: true,
      value: Number.MAX_SAFE_INTEGER,
    });
  });

  test("a total past the boundary is REFUSED rather than silently rounded", () => {
    const read = readTotalBytes(BigInt(Number.MAX_SAFE_INTEGER) + 1n, "sumAttachmentBytes/x");
    expect(reasonOf(read)).toContain("files.row.unreadable_total_bytes");
  });

  test("a negative total is refused: no set of non-negative rows can sum below zero", () => {
    expect(reasonOf(readTotalBytes(-1n, "where"))).toContain("files.row.unreadable_total_bytes");
  });
});
