// What the canonical schema refuses that `schema.prisma` and the in-memory double
// do not, proved against a REAL PostgreSQL.
//
// EVERY CASE HERE IS A PAIR WHEREVER A PAIR IS POSSIBLE: the port refuses the
// value, AND the database is shown to refuse or to accept the same value when it
// is planted through the ORM's own CLI. A guard asserted only against itself is a
// guard measured against the author's belief; a guard shown standing where the
// column stands is a guard measured against the column.
//
// THE MOST IMPORTANT PAIRS ARE THE ONES WHERE THE DATABASE ACCEPTS. `bytes` and
// `revision` carry NO CHECK, so a negative byte count and a zero revision are
// rows PostgreSQL stores without complaint. The write guard is this binary's
// refusal and not the column's — which is exactly why the READ has to refuse them
// too, and why both halves are cased below. A store that only guarded the write
// would hand a quota decision a number nobody could have written this year and
// could certainly have written last year.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { AttachmentId, ContentHash } from "@platos/context-files/application/ports/index.js";
import { asIdentifier } from "@platos/context-files/application/ports/index.js";
import { runResult } from "@platos/kernel";

import {
  artifactFixture,
  attachmentFixture,
  callerCode,
  erasureSelectorOf,
  organizationScopeOf,
  refusalCode,
  refusalReason,
  FILES_AT,
} from "./files-fixtures.js";
import { startFilesHarness, type FilesChain, type FilesHarness } from "./files-harness.js";

let harness: FilesHarness;
let chain: FilesChain;
let foreign: FilesChain;
let sequence = 0;

/** A fresh row id per case, so no two cases can collide on a primary key. */
function freshId(): string {
  sequence += 1;
  return `dddddddd-0001-4000-8000-${String(sequence).padStart(12, "0")}`;
}

beforeAll(async () => {
  harness = await startFilesHarness();
  chain = await harness.freshChain();
  foreign = await harness.freshChain();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

/** Does the ORM's own CLI accept this statement? The database's opinion, unmediated. */
function plant(sql: string): string {
  try {
    harness.applyPeerRows(sql);
    return "<accepted>";
  } catch (error) {
    const shown = error instanceof Error ? `${error.message}` : String(error);
    return shown.replace(/\s+/gu, " ");
  }
}

describe("the four INTEGER columns are 32-bit and the domain's numbers are not", () => {
  test("bytes above the integer ceiling is refused before a statement, and by the column", async () => {
    const written = await runResult(harness, (transaction) =>
      harness.repository.insertAttachment(
        attachmentFixture(chain.attachment, freshId(), { bytes: 3_000_000_000 }),
        transaction,
      ),
    );
    expect(refusalCode(written)).toBe("files.write.integer_out_of_range");
    expect(callerCode(written)).toBe("FILES_REPOSITORY_UNAVAILABLE");

    // AND THE COLUMN AGREES. Without this half the guard would be a number this
    // package chose rather than the one PostgreSQL enforces.
    const planted = plant(
      `INSERT INTO "MessageAttachment" ("id","environmentId","endUserId","agentId","threadId",
         "kind","mimeType","bytes","storageKey","createdAt")
       VALUES ('${freshId()}','${chain.environmentId}','${chain.endUserId}','${chain.agentId}',
               '${chain.threadId}','document','application/pdf',3000000000,'k','2026-06-01T09:00:00Z');`,
    );
    expect(planted).toMatch(/integer out of range/iu);
  }, 120_000);

  test("a negative bytes is refused on WRITE, ACCEPTED by the column, and refused on READ", async () => {
    const negative = await runResult(harness, (transaction) =>
      harness.repository.insertAttachment(
        attachmentFixture(chain.attachment, freshId(), { bytes: -1 }),
        transaction,
      ),
    );
    expect(refusalCode(negative)).toBe("files.write.integer_out_of_range");

    // THE COLUMN CARRIES NO CHECK. This is the row an older binary could have
    // written, and it is representable today.
    const plantedId = freshId();
    expect(
      plant(
        `INSERT INTO "MessageAttachment" ("id","environmentId","endUserId","agentId","threadId",
           "kind","mimeType","bytes","storageKey","createdAt")
         VALUES ('${plantedId}','${chain.environmentId}','${chain.endUserId}','${chain.agentId}',
                 '${chain.threadId}','document','application/pdf',-7,'k','2026-06-01T09:00:00Z');`,
      ),
    ).toBe("<accepted>");

    const read = await harness.repository.findAttachment(
      chain.thread,
      asIdentifier<AttachmentId>(plantedId),
    );
    expect(refusalCode(read)).toBe("files.row.unreadable_attachment_measure");
    expect(refusalReason(read)).toContain("bytes=-7");

    // AND THE QUOTA READ REFUSES RATHER THAN SUBTRACTING IT. `sumAttachmentBytes`
    // maps no row, so it cannot reach `readAttachmentRow` at all — what it has
    // instead is the SUM, and `readTotalBytes` refuses a negative one. THE HONEST
    // LIMIT IS RECORDED RATHER THAN CLAIMED AWAY: this catches the total going
    // negative, not the row. One negative row among larger positive ones sums
    // above zero and is invisible here, which is exactly why the WRITE guard is
    // the one that has to hold, and why the READ guard on the row is what stops a
    // wrong number reaching a caller that maps it.
    const summed = await harness.repository.sumAttachmentBytes(
      organizationScopeOf(chain.organizationId),
    );
    expect(refusalCode(summed)).toBe("files.row.unreadable_total_bytes");

    harness.applyPeerRows(`DELETE FROM "MessageAttachment" WHERE "id" = '${plantedId}';`);
  }, 120_000);

  test("a fractional bytes is refused: the column is an integer and a number is not", async () => {
    const written = await runResult(harness, (transaction) =>
      harness.repository.insertAttachment(
        attachmentFixture(chain.attachment, freshId(), { bytes: 10.5 }),
        transaction,
      ),
    );
    expect(refusalCode(written)).toBe("files.write.integer_out_of_range");
  }, 120_000);

  test("a negative media dimension is refused on the same guard with its own field", async () => {
    const written = await runResult(harness, (transaction) =>
      harness.repository.insertAttachment(
        attachmentFixture(chain.attachment, freshId(), { width: -1 }),
        transaction,
      ),
    );
    expect(refusalCode(written)).toBe("files.write.integer_out_of_range");
    expect(refusalReason(written)).toContain("MessageAttachment.width");
  }, 120_000);

  test("revision 0 is refused on WRITE, ACCEPTED by the column, and refused on READ", async () => {
    const written = await runResult(harness, (transaction) =>
      harness.repository.insertArtifactRevision(
        artifactFixture(chain.thread, freshId(), { revision: 0, artifactKey: "zero.rev" }),
        transaction,
      ),
    );
    expect(refusalCode(written)).toBe("files.write.integer_out_of_range");

    const plantedId = freshId();
    expect(
      plant(
        `INSERT INTO "Artifact" ("id","environmentId","threadId","artifactKey","revision","kind",
           "content","createdBy","createdAt")
         VALUES ('${plantedId}','${chain.environmentId}','${chain.threadId}','zero.rev',0,'markdown',
                 'planted','user_fixture_author','2026-06-01T09:00:00Z');`,
      ),
    ).toBe("<accepted>");

    const read = await harness.repository.findArtifactRevision(
      chain.thread,
      asIdentifier("zero.rev"),
      1,
    );
    // The exact read asks for revision 1 and finds nothing, which is correct.
    expect(read).toEqual({ ok: true, value: null });

    // The LATEST read is the one that meets it, because `ORDER BY revision DESC`
    // returns the only row there is.
    const latest = await harness.repository.findLatestArtifactRevision(
      chain.thread,
      asIdentifier("zero.rev"),
    );
    expect(refusalCode(latest)).toBe("files.row.unreadable_artifact_revision");
    expect(refusalReason(latest)).toContain("revision=0");

    harness.applyPeerRows(`DELETE FROM "Artifact" WHERE "id" = '${plantedId}';`);
  }, 120_000);
});

describe("a text column cannot hold U+0000 and every free-form column is exposed to it", () => {
  test("an original name carrying NUL is refused before a statement", async () => {
    const written = await runResult(harness, (transaction) =>
      harness.repository.insertAttachment(
        attachmentFixture(chain.attachment, freshId(), { originalName: "in\u0000voice.pdf" }),
        transaction,
      ),
    );
    expect(refusalCode(written)).toBe("files.write.text_holds_nul");
  }, 120_000);

  test("artifact content carrying NUL is refused, and PostgreSQL refuses the same bytes", async () => {
    const written = await runResult(harness, (transaction) =>
      harness.repository.insertArtifactRevision(
        artifactFixture(chain.thread, freshId(), {
          content: "before\u0000after",
          artifactKey: "nul.content",
        }),
        transaction,
      ),
    );
    expect(refusalCode(written)).toBe("files.write.text_holds_nul");

    // THE COLUMN'S OWN OPINION, obtained without going through the port at all.
    expect(
      plant(
        `INSERT INTO "Artifact" ("id","environmentId","threadId","artifactKey","revision","kind",
           "content","createdBy","createdAt")
         VALUES ('${freshId()}','${chain.environmentId}','${chain.threadId}','nul.content',1,'markdown',
                 'before' || chr(0) || 'after','user_fixture_author','2026-06-01T09:00:00Z');`,
      ),
    ).toMatch(/(null character|0x00|unsupported|invalid)/iu);
  }, 120_000);
});

describe("Artifact_metadata_json_root is a CHECK and the double has no opinion at all", () => {
  test("a JSON array metadata is refused before a statement, and by the CHECK", async () => {
    const written = await runResult(harness, (transaction) =>
      harness.repository.insertArtifactRevision(
        artifactFixture(chain.thread, freshId(), {
          artifactKey: "array.meta",
          metadata: [] as unknown as Readonly<Record<string, never>>,
        }),
        transaction,
      ),
    );
    expect(refusalCode(written)).toBe("files.write.metadata_not_object");

    expect(
      plant(
        `INSERT INTO "Artifact" ("id","environmentId","threadId","artifactKey","revision","kind",
           "content","metadata","createdBy","createdAt")
         VALUES ('${freshId()}','${chain.environmentId}','${chain.threadId}','array.meta',1,'markdown',
                 'planted','[]'::jsonb,'user_fixture_author','2026-06-01T09:00:00Z');`,
      ),
    ).toContain("Artifact_metadata_json_root");
  }, 120_000);

  test("a null metadata is the SQL NULL and reads back as null, not as the JSON scalar", async () => {
    const key = "null.meta";
    const written = await runResult(harness, (transaction) =>
      harness.repository.insertArtifactRevision(
        artifactFixture(chain.thread, freshId(), { artifactKey: key, metadata: null }),
        transaction,
      ),
    );
    expect(written.ok).toBe(true);
    const read = await harness.repository.findArtifactRevision(chain.thread, asIdentifier(key), 1);
    expect(read.ok && read.value?.metadata).toBeNull();
  }, 120_000);
});

describe("Artifact.createdBy is a plain TEXT and it is what an erasure matches on", () => {
  test("an empty principal is refused on write and on the erasure read", async () => {
    const written = await runResult(harness, (transaction) =>
      harness.repository.insertArtifactRevision(
        artifactFixture(chain.thread, freshId(), { artifactKey: "empty.author", createdBy: "" }),
        transaction,
      ),
    );
    expect(refusalCode(written)).toBe("files.write.principal_empty");

    // THE COLUMN ACCEPTS IT, which is exactly why the guard is not decoration:
    // a row with an empty author is a row a later erasure of any other empty
    // author would destroy.
    const plantedId = freshId();
    expect(
      plant(
        `INSERT INTO "Artifact" ("id","environmentId","threadId","artifactKey","revision","kind",
           "content","createdBy","createdAt")
         VALUES ('${plantedId}','${chain.environmentId}','${chain.threadId}','empty.author',1,'markdown',
                 'planted','','2026-06-01T09:00:00Z');`,
      ),
    ).toBe("<accepted>");

    const counted = await harness.repository.countArtifactRevisionsForSubject(
      erasureSelectorOf(chain.organizationId, null, ""),
    );
    expect(refusalCode(counted)).toBe("files.write.principal_empty");

    harness.applyPeerRows(`DELETE FROM "Artifact" WHERE "id" = '${plantedId}';`);
  }, 120_000);
});

describe("every @db.Uuid column, and the identifiers the context's own doubles mint", () => {
  test("the shapes SequenceIdGenerator produces are refused by every write and read", async () => {
    const written = await runResult(harness, (transaction) =>
      harness.repository.insertAttachment(
        attachmentFixture(chain.attachment, "id-0001"),
        transaction,
      ),
    );
    expect(refusalCode(written)).toBe("files.write.identifier_not_uuid");
    expect(refusalReason(written)).toContain("id-0001");

    const read = await harness.repository.findAttachment(
      chain.thread,
      asIdentifier<AttachmentId>("id-0001"),
    );
    expect(refusalCode(read)).toBe("files.write.identifier_not_uuid");

    const erasure = await harness.repository.countAttachmentsForSubject(
      erasureSelectorOf(chain.organizationId, "end-user-1", null),
    );
    expect(refusalCode(erasure)).toBe("files.write.identifier_not_uuid");
  }, 120_000);

  test("an invalid Date is refused before the driver can report a parameter with no column", async () => {
    const written = await runResult(harness, (transaction) =>
      harness.repository.insertAttachment(
        attachmentFixture(chain.attachment, freshId(), { createdAt: new Date("not a date") }),
        transaction,
      ),
    );
    expect(refusalCode(written)).toBe("files.write.instant_not_representable");
  }, 120_000);
});

describe("the primary key, which the double's Map.set does not have", () => {
  test("a second insert at one id is refused rather than overwriting the first", async () => {
    const id = freshId();
    const first = await runResult(harness, (transaction) =>
      harness.repository.insertAttachment(
        attachmentFixture(chain.attachment, id, { bytes: 1 }),
        transaction,
      ),
    );
    expect(first.ok).toBe(true);

    const second = await runResult(harness, (transaction) =>
      harness.repository.insertAttachment(
        attachmentFixture(chain.attachment, id, { bytes: 2 }),
        transaction,
      ),
    );
    expect(callerCode(second)).toBe("FILES_REPOSITORY_UNAVAILABLE");
    expect(refusalReason(second)).toContain("insertAttachment");

    const read = await harness.repository.findAttachment(
      chain.thread,
      asIdentifier<AttachmentId>(id),
    );
    expect(read.ok && read.value?.bytes).toBe(1);
  }, 120_000);
});

describe("the dedupe probe carries no unique index and no index at all", () => {
  test("two rows may share one content hash, and the probe answers the oldest", async () => {
    const hash = asIdentifier<ContentHash>("sha256:shared-by-two");
    const older = freshId();
    const newer = freshId();
    await runResult(harness, (transaction) =>
      harness.repository.insertAttachment(
        attachmentFixture(chain.attachment, older, {
          contentHash: hash,
          createdAt: new Date(FILES_AT.getTime() + 1000),
        }),
        transaction,
      ),
    );
    await runResult(harness, (transaction) =>
      harness.repository.insertAttachment(
        attachmentFixture(chain.attachment, newer, {
          contentHash: hash,
          createdAt: new Date(FILES_AT.getTime() + 2000),
        }),
        transaction,
      ),
    );

    // THE PORT'S SIGNATURE IS `Attachment | null` AND THE COLUMN IS NOT UNIQUE,
    // so something has to decide which of the two answers. It is the oldest, by
    // `createdAt` then `id`, and it is the same answer twice — which an
    // unordered `LIMIT 1` would not have been.
    const once = await harness.repository.findAttachmentByContentHash(chain.environment, hash);
    const twice = await harness.repository.findAttachmentByContentHash(chain.environment, hash);
    expect(once.ok && once.value?.attachmentId).toBe(older);
    expect(twice).toEqual(once);
  }, 120_000);

  test("the probe never crosses an environment even when the bytes are identical", async () => {
    const hash = asIdentifier<ContentHash>("sha256:same-bytes-two-tenants");
    await runResult(harness, (transaction) =>
      harness.repository.insertAttachment(
        attachmentFixture(chain.attachment, freshId(), { contentHash: hash }),
        transaction,
      ),
    );
    const other = await harness.repository.findAttachmentByContentHash(foreign.environment, hash);
    expect(other).toEqual({ ok: true, value: null });
  }, 120_000);
});
