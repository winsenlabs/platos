// Statement counts for the `files` store, MEASURED — the N+1 control.
//
// Every pin below is a number this suite observed rather than a number somebody
// expected, and every read is measured TWICE: once over a small fixture and once
// over one an order of magnitude larger. What matters is not the figure but that
// the figure DOES NOT MOVE with the number of rows. An N+1 does not announce
// itself in a suite — every value is correct and every test passes — it announces
// itself as a retention sweep that took four minutes because a tenant had
// uploaded forty files.
//
// *** THE ONE N+1 IN THIS CONTEXT IS THE CONTRACT, AND IT IS PINNED AS ONE ***
// `files-erasure-target.ts` lists a subject's attachments in one statement and
// then destroys each row individually, because `domain/destruction.ts` requires
// the BLOB to go first and no transaction spans a bucket and a database. So the
// erasure path is `1 + 2 per row` and cannot be anything else; the pair of
// measurements at the end shows which part grows, and the pin is written as the
// formula rather than as a number so a reader can see that the constant is the
// list and the slope is the rule.
//
// THE PROBE FILTER IS ANCHORED, AND THE ANCHOR IS THE POINT. The driver's
// connection probe is exactly `SELECT 1`, and a filter written as a SUBSTRING
// match would discard any statement containing it — which is how tranche 3
// measured an advisory lock at ZERO statements. The pattern below matches the
// WHOLE statement, and the case at the end asserts that not one measured
// statement of this store would have been swallowed by it.

import { afterAll, beforeAll, expect, test } from "vitest";

import type { AttachmentId, ContentHash } from "@platos/context-files/application/ports/index.js";
import { asIdentifier } from "@platos/context-files/application/ports/index.js";

import {
  artifactFixture,
  attachmentFixture,
  erasureSelectorOf,
  organizationScopeOf,
  FILES_AT,
} from "./files-fixtures.js";
import { startFilesHarness, type FilesChain, type FilesHarness } from "./files-harness.js";

let harness: FilesHarness;
/** One attachment, one artifact revision. */
let small: FilesChain;
/** Twenty-one of each. */
let large: FilesChain;

const HEAVY = 20;
const SUBJECT_KEY = "load.summary";

let smallAttachmentIds: string[] = [];
let largeAttachmentIds: string[] = [];

let sequence = 0;
function freshId(): string {
  sequence += 1;
  return `dddddddd-0004-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function queries(): readonly string[] {
  return harness
    .statements()
    .filter(
      (statement) =>
        !/^\s*(BEGIN|COMMIT|ROLLBACK|DEALLOCATE)\s*$/iu.test(statement) &&
        !/^\s*SELECT 1\s*$/iu.test(statement),
    );
}

/**
 * Let the client's `query` events arrive.
 *
 * The event is emitted ASYNCHRONOUSLY, after the call has resolved, and a count
 * taken in the same tick can miss the last statement — which is not merely a
 * measurement that reads low: the missed event lands in the NEXT measurement's
 * array, so one pin reads one short and the pin after it reads one long.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

async function measure(work: () => Promise<unknown>): Promise<number> {
  await settle();
  harness.resetStatements();
  await work();
  await settle();
  return queries().length;
}

/** Everything one chain holds, so the two fixtures differ only in size. */
async function seed(chain: FilesChain, rows: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    const id = freshId();
    ids.push(id);
    await harness.run((transaction) =>
      harness.repository.insertAttachment(
        attachmentFixture(chain.attachment, id, {
          bytes: 10 + index,
          contentHash: `sha256:load-${String(index)}`,
          createdAt: new Date(FILES_AT.getTime() + index * 1000),
          expiresAt: new Date(FILES_AT.getTime() + 60_000),
        }),
        transaction,
      ),
    );
    await harness.run((transaction) =>
      harness.repository.insertArtifactRevision(
        artifactFixture(chain.thread, freshId(), {
          artifactKey: SUBJECT_KEY,
          revision: index + 1,
          createdBy: "user_load_author",
        }),
        transaction,
      ),
    );
  }
  return ids;
}

beforeAll(async () => {
  harness = await startFilesHarness();
  small = await harness.freshChain();
  large = await harness.freshChain();
  smallAttachmentIds = await seed(small, 1);
  largeAttachmentIds = await seed(large, HEAVY + 1);
}, 600_000);

afterAll(async () => {
  await harness?.stop();
});

test("every scoped read is ONE statement, and stays one as the fixture grows", async () => {
  const smallFirst = smallAttachmentIds[0] ?? "";
  const largeFirst = largeAttachmentIds[0] ?? "";

  expect(
    await measure(() =>
      harness.repository.findAttachment(small.thread, asIdentifier<AttachmentId>(smallFirst)),
    ),
  ).toBe(1);
  expect(
    await measure(() =>
      harness.repository.findAttachment(large.thread, asIdentifier<AttachmentId>(largeFirst)),
    ),
  ).toBe(1);

  // THE BATCH READ IS ONE STATEMENT FOR ONE ID AND ONE FOR TWENTY-ONE. The list
  // travels as a single delimited `text` parameter re-split in SQL, so the id
  // COUNT cannot become a round-trip count.
  expect(
    await measure(() =>
      harness.repository.findAttachmentsInScope(
        small.thread,
        smallAttachmentIds.map((id) => asIdentifier<AttachmentId>(id)),
      ),
    ),
  ).toBe(1);
  expect(
    await measure(() =>
      harness.repository.findAttachmentsInScope(
        large.thread,
        largeAttachmentIds.map((id) => asIdentifier<AttachmentId>(id)),
      ),
    ),
  ).toBe(1);

  // AN EMPTY LIST IS ZERO STATEMENTS. `= ANY('{}')` is a correct query that
  // returns nothing, and sending it would make a no-op read cost a round trip.
  expect(await measure(() => harness.repository.findAttachmentsInScope(large.thread, []))).toBe(0);

  expect(
    await measure(() =>
      harness.repository.findAttachmentByContentHash(
        small.environment,
        asIdentifier<ContentHash>("sha256:load-0"),
      ),
    ),
  ).toBe(1);
  expect(
    await measure(() =>
      harness.repository.findAttachmentByContentHash(
        large.environment,
        asIdentifier<ContentHash>("sha256:load-0"),
      ),
    ),
  ).toBe(1);
}, 300_000);

test("the quota sum and the retention sweep are ONE statement each at either size", async () => {
  expect(
    await measure(() =>
      harness.repository.sumAttachmentBytes(organizationScopeOf(small.organizationId)),
    ),
  ).toBe(1);
  expect(
    await measure(() =>
      harness.repository.sumAttachmentBytes(organizationScopeOf(large.organizationId)),
    ),
  ).toBe(1);

  // THE SWEEP IS UNSCOPED, so both measurements see every elapsed row in the
  // installation — twenty-two of them — and both are one statement.
  const asOf = new Date(FILES_AT.getTime() + 120_000);
  expect(await measure(() => harness.repository.listElapsedAttachments(asOf, 1))).toBe(1);
  expect(await measure(() => harness.repository.listElapsedAttachments(asOf, 500))).toBe(1);
  // A zero limit answers without a statement, for the reason an empty id list does.
  expect(await measure(() => harness.repository.listElapsedAttachments(asOf, 0))).toBe(0);
}, 300_000);

test("the artifact reads are ONE statement over one revision and over twenty-one", async () => {
  expect(
    await measure(() =>
      harness.repository.findLatestArtifactRevision(small.thread, asIdentifier(SUBJECT_KEY)),
    ),
  ).toBe(1);
  expect(
    await measure(() =>
      harness.repository.findLatestArtifactRevision(large.thread, asIdentifier(SUBJECT_KEY)),
    ),
  ).toBe(1);
  expect(
    await measure(() =>
      harness.repository.findArtifactRevision(large.thread, asIdentifier(SUBJECT_KEY), HEAVY + 1),
    ),
  ).toBe(1);
}, 300_000);

test("every write is a fixed count: the ancestry re-assertion plus one statement", async () => {
  // TWO, NOT ONE, AND THE SECOND IS DELIBERATE. The first statement is the
  // ancestry re-assertion in `files-ancestry.ts`: no database rule checks the
  // caller's CLAIM about which project and organization an environment sits
  // under, and a row written under a forged claim would read back under the true
  // one and be unreachable. It is a constant, not a per-row cost.
  const inserted = freshId();
  expect(
    await measure(() =>
      harness.run((transaction) =>
        harness.repository.insertAttachment(
          attachmentFixture(small.attachment, inserted),
          transaction,
        ),
      ),
    ),
  ).toBe(2);

  // THE UPDATE IS ONE. It carries the four owner columns in its `WHERE`, so the
  // ancestry is proved by the row it matches rather than by a second statement.
  expect(
    await measure(() =>
      harness.run((transaction) =>
        harness.repository.updateAttachmentBinding(
          attachmentFixture(small.attachment, inserted, { turnId: small.turnId }),
          transaction,
        ),
      ),
    ),
  ).toBe(1);

  expect(
    await measure(() =>
      harness.run((transaction) =>
        harness.repository.insertArtifactRevision(
          artifactFixture(small.thread, freshId(), { artifactKey: "statements.witness" }),
          transaction,
        ),
      ),
    ),
  ).toBe(2);

  expect(
    await measure(() =>
      harness.run((transaction) =>
        harness.repository.deleteAttachment(
          small.thread,
          asIdentifier<AttachmentId>(inserted),
          transaction,
        ),
      ),
    ),
  ).toBe(2);
}, 300_000);

test("the erasure is ONE statement per question, and the row loop is the CONTRACT", async () => {
  const smallSelector = erasureSelectorOf(
    small.organizationId,
    small.attachment.owner.endUserId,
    "user_load_author",
  );
  const largeSelector = erasureSelectorOf(
    large.organizationId,
    large.attachment.owner.endUserId,
    "user_load_author",
  );

  expect(await measure(() => harness.repository.countAttachmentsForSubject(smallSelector))).toBe(1);
  expect(await measure(() => harness.repository.countAttachmentsForSubject(largeSelector))).toBe(1);
  expect(await measure(() => harness.repository.listAttachmentsForSubject(smallSelector))).toBe(1);
  expect(await measure(() => harness.repository.listAttachmentsForSubject(largeSelector))).toBe(1);
  expect(
    await measure(() => harness.repository.countArtifactRevisionsForSubject(smallSelector)),
  ).toBe(1);
  expect(
    await measure(() => harness.repository.countArtifactRevisionsForSubject(largeSelector)),
  ).toBe(1);

  // A SUBJECT-LESS SELECTOR COSTS NOTHING. This context holds no column for an
  // `entity` subject, and asking the database a question with a known answer
  // would be a round trip per erasure operation across the installation.
  expect(
    await measure(() =>
      harness.repository.countAttachmentsForSubject({ ...smallSelector, endUserId: null }),
    ),
  ).toBe(0);

  // THE DELETE IS ONE STATEMENT WHATEVER THE ROW COUNT — `DELETE ... USING` names
  // the two parent tables in the same statement, so the join that resolves
  // containment and the delete that acts on it cannot disagree.
  expect(
    await measure(() =>
      harness.run((transaction) =>
        harness.repository.deleteArtifactRevisionsForSubject(largeSelector, transaction),
      ),
    ),
  ).toBe(1);

  // AND THE ROW LOOP, MEASURED AT BOTH SIZES. `1 + 2n`: one list, then two per
  // row — the ancestry re-assertion and the delete. It is the shape
  // `files-erasure-target.ts` is required to have, not one this store chose.
  const walk = async (chain: FilesChain, selector: typeof smallSelector): Promise<number> =>
    measure(async () => {
      const listed = await harness.repository.listAttachmentsForSubject(selector);
      if (!listed.ok) throw new Error("the listing is the fixture");
      for (const attachment of listed.value) {
        await harness.run((transaction) =>
          harness.repository.deleteAttachment(chain.thread, attachment.attachmentId, transaction),
        );
      }
    });
  expect(await walk(small, smallSelector)).toBe(1 + 2 * 1);
  expect(await walk(large, largeSelector)).toBe(1 + 2 * (HEAVY + 1));
}, 300_000);

test("the probe filter is anchored: no measured statement would have been swallowed", async () => {
  await settle();
  harness.resetStatements();
  await harness.repository.findAttachment(
    small.thread,
    asIdentifier<AttachmentId>(smallAttachmentIds[0] ?? ""),
  );
  await harness.repository.sumAttachmentBytes(organizationScopeOf(small.organizationId));
  await settle();
  const measured = queries();
  expect(measured.length).toBe(2);
  // A SUBSTRING FILTER WOULD HAVE DISCARDED NEITHER, and this is the case that
  // says so rather than the comment above. Tranche 3 measured an advisory lock at
  // ZERO statements because its projection was exactly the probe; a store whose
  // statements are indistinguishable from the probe cannot be measured at all.
  for (const statement of measured) {
    expect(/^\s*SELECT 1\s*$/iu.test(statement)).toBe(false);
    expect(statement.length).toBeGreaterThan("SELECT 1".length);
  }
}, 300_000);
