// Every CLAUSE of every scoped read, isolated — one case per clause, each one
// wrong in exactly one id.
//
// WHY A FILE OF ITS OWN. The conformance differential asks cross-tenant
// questions with EVERY id wrong at once, which is what a real caller looks like
// and is exactly why it cannot tell which clause did the work: a read that had
// dropped its `organizationId` filter would still answer `null` for a request
// whose thread and environment are also foreign. The cases below change ONE id
// at a time, so a missing clause has nowhere to hide behind a neighbour.
//
// AND THE SHAPE GUARDS ARE HERE TOO, for the same reason. `requireScopeShape`
// checks three ids and `requireTenantScopeShape` checks between one and three
// depending on the level; a single case with one bad id proves one of them and
// leaves the rest unfalsified.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { AttachmentId, ContentHash } from "@platos/context-files/application/ports/index.js";
import { asIdentifier } from "@platos/context-files/application/ports/index.js";

import {
  attachmentFixture,
  envIdOf,
  organizationScopeOf,
  orgIdOf,
  projIdOf,
  refusalCode,
  refusalReason,
  FILES_AT,
} from "./files-fixtures.js";
import { startFilesHarness, type FilesChain, type FilesHarness } from "./files-harness.js";

let harness: FilesHarness;
let chain: FilesChain;
let foreign: FilesChain;
/** One attachment of `chain`, the row every clause case is aimed at. */
let subject: AttachmentId;
let sequence = 0;

function freshId(): string {
  sequence += 1;
  return `dddddddd-0005-4000-8000-${String(sequence).padStart(12, "0")}`;
}

beforeAll(async () => {
  harness = await startFilesHarness();
  chain = await harness.freshChain();
  foreign = await harness.freshChain();
  subject = asIdentifier<AttachmentId>(freshId());
  const written = await harness.run((transaction) =>
    harness.repository.insertAttachment(
      attachmentFixture(chain.attachment, subject, { contentHash: "sha256:scope-subject" }),
      transaction,
    ),
  );
  expect(written.ok).toBe(true);
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("findAttachment: four clauses, four cases, one wrong id each", () => {
  test("the right scope finds it — the positive control every case below needs", async () => {
    const read = await harness.repository.findAttachment(chain.thread, subject);
    expect(read.ok && read.value?.attachmentId).toBe(subject);
  }, 120_000);

  test("a SIBLING thread of the same environment does not", async () => {
    const read = await harness.repository.findAttachment(chain.secondThread, subject);
    expect(read).toEqual({ ok: true, value: null });
  }, 120_000);

  test("the right thread under another ENVIRONMENT does not", async () => {
    const read = await harness.repository.findAttachment(
      { environment: foreign.environment, threadId: chain.thread.threadId },
      subject,
    );
    expect(read).toEqual({ ok: true, value: null });
  }, 120_000);

  test("the right environment under a foreign PROJECT does not", async () => {
    const read = await harness.repository.findAttachment(
      {
        environment: { ...chain.environment, projectId: projIdOf(foreign.projectId) },
        threadId: chain.thread.threadId,
      },
      subject,
    );
    expect(read).toEqual({ ok: true, value: null });
  }, 120_000);

  test("the right project under a foreign ORGANIZATION does not", async () => {
    const read = await harness.repository.findAttachment(
      {
        environment: { ...chain.environment, organizationId: orgIdOf(foreign.organizationId) },
        threadId: chain.thread.threadId,
      },
      subject,
    );
    expect(read).toEqual({ ok: true, value: null });
  }, 120_000);
});

describe("the batch read and the dedupe probe carry the same four clauses", () => {
  test("a sibling thread returns nothing for an id that exists in the environment", async () => {
    const read = await harness.repository.findAttachmentsInScope(chain.secondThread, [subject]);
    expect(read).toEqual({ ok: true, value: [] });
  }, 120_000);

  test("a foreign organization returns nothing for an id that exists in the environment", async () => {
    const read = await harness.repository.findAttachmentsInScope(
      {
        environment: { ...chain.environment, organizationId: orgIdOf(foreign.organizationId) },
        threadId: chain.thread.threadId,
      },
      [subject],
    );
    expect(read).toEqual({ ok: true, value: [] });
  }, 120_000);

  test("the probe under a foreign PROJECT of the right environment finds nothing", async () => {
    const read = await harness.repository.findAttachmentByContentHash(
      { ...chain.environment, projectId: projIdOf(foreign.projectId) },
      asIdentifier<ContentHash>("sha256:scope-subject"),
    );
    expect(read).toEqual({ ok: true, value: null });
  }, 120_000);

  test("the probe under a foreign ORGANIZATION of the right environment finds nothing", async () => {
    const read = await harness.repository.findAttachmentByContentHash(
      { ...chain.environment, organizationId: orgIdOf(foreign.organizationId) },
      asIdentifier<ContentHash>("sha256:scope-subject"),
    );
    expect(read).toEqual({ ok: true, value: null });
  }, 120_000);
});

describe("the delete carries the thread clause as well as the ancestry re-assertion", () => {
  test("a delete addressed at a SIBLING thread of the right environment removes nothing", async () => {
    const id = freshId();
    expect(
      (await harness.run((transaction) =>
        harness.repository.insertAttachment(attachmentFixture(chain.attachment, id), transaction),
      )).ok,
    ).toBe(true);

    // The environment, project and organization are all correct; only the thread
    // is a sibling. Nothing else in the tree can be what refuses this.
    const removed = await harness.run((transaction) =>
      harness.repository.deleteAttachment(
        chain.secondThread,
        asIdentifier<AttachmentId>(id),
        transaction,
      ),
    );
    expect(removed).toEqual({ ok: true, value: false });
    const survived = await harness.repository.findAttachment(
      chain.thread,
      asIdentifier<AttachmentId>(id),
    );
    expect(survived.ok && survived.value?.attachmentId).toBe(id);
  }, 120_000);
});

describe("requireScopeShape checks THREE ids and each is cased on its own", () => {
  test("a non-uuid organizationId is refused", async () => {
    const read = await harness.repository.findAttachment(
      { environment: { ...chain.environment, organizationId: orgIdOf("org-1") }, threadId: chain.thread.threadId },
      subject,
    );
    expect(refusalCode(read)).toBe("files.write.identifier_not_uuid");
    expect(refusalReason(read)).toContain("scope.organizationId");
  }, 120_000);

  test("a non-uuid projectId is refused, under its own field name", async () => {
    const read = await harness.repository.findAttachment(
      { environment: { ...chain.environment, projectId: projIdOf("proj-1") }, threadId: chain.thread.threadId },
      subject,
    );
    expect(refusalReason(read)).toContain("scope.projectId");
  }, 120_000);

  test("a non-uuid environmentId is refused, under its own field name", async () => {
    const read = await harness.repository.findAttachment(
      { environment: { ...chain.environment, environmentId: envIdOf("env-1") }, threadId: chain.thread.threadId },
      subject,
    );
    expect(refusalReason(read)).toContain("scope.environmentId");
  }, 120_000);

  test("a non-uuid threadId is refused, under its own field name", async () => {
    const read = await harness.repository.findAttachment(
      { environment: chain.environment, threadId: asIdentifier("thread-1") },
      subject,
    );
    expect(refusalReason(read)).toContain("scope.threadId");
  }, 120_000);
});

describe("requireTenantScopeShape checks exactly the ids the LEVEL carries", () => {
  test("an organization selector checks one id and refuses a bad one", async () => {
    const counted = await harness.repository.countAttachmentsForSubject({
      scope: organizationScopeOf("org-1"),
      endUserId: chain.endUserId,
      principalId: null,
    });
    expect(refusalReason(counted)).toContain("selector.scope.organizationId");
  }, 120_000);

  test("a PROJECT selector checks the project id too, which an organization one does not", async () => {
    const counted = await harness.repository.countAttachmentsForSubject({
      scope: {
        level: "project",
        organizationId: orgIdOf(chain.organizationId),
        projectId: projIdOf("proj-1"),
      },
      endUserId: chain.endUserId,
      principalId: null,
    });
    expect(refusalReason(counted)).toContain("selector.scope.projectId");
  }, 120_000);

  test("an ENVIRONMENT selector checks all three, and the third is only reachable here", async () => {
    const counted = await harness.repository.countAttachmentsForSubject({
      scope: { ...chain.environment, environmentId: envIdOf("env-1") },
      endUserId: chain.endUserId,
      principalId: null,
    });
    expect(refusalReason(counted)).toContain("selector.scope.environmentId");
  }, 120_000);

  test("a PROJECT-level selector narrows the count, and the project clause is what does it", async () => {
    const wide = await harness.repository.countAttachmentsForSubject({
      scope: organizationScopeOf(chain.organizationId),
      endUserId: chain.endUserId,
      principalId: null,
    });
    const narrow = await harness.repository.countAttachmentsForSubject({
      scope: {
        level: "project",
        organizationId: orgIdOf(chain.organizationId),
        projectId: projIdOf(foreign.projectId),
      },
      endUserId: chain.endUserId,
      principalId: null,
    });
    expect(wide.ok && wide.value).toBeGreaterThan(0);
    // The subject's rows are in THIS project, so a selector naming another one
    // finds none — which is the project clause and nothing else, because the
    // organization clause is satisfied and the environment clause is off.
    expect(narrow).toEqual({ ok: true, value: 0 });
  }, 120_000);
});

describe("the shapes the domain's own optional fields can carry", () => {
  test("a non-uuid turn binding is refused on the nullable half of the uuid guard", async () => {
    const written = await harness.run((transaction) =>
      harness.repository.insertAttachment(
        attachmentFixture(chain.attachment, freshId(), { turnId: "turn-1" }),
        transaction,
      ),
    );
    expect(refusalCode(written)).toBe("files.write.identifier_not_uuid");
    expect(refusalReason(written)).toContain("MessageAttachment.turnId");
  }, 120_000);

  test("an invalid expiry is refused on the nullable half of the instant guard", async () => {
    const written = await harness.run((transaction) =>
      harness.repository.insertAttachment(
        attachmentFixture(chain.attachment, freshId(), { expiresAt: new Date("not a date") }),
        transaction,
      ),
    );
    expect(refusalCode(written)).toBe("files.write.instant_not_representable");
    expect(refusalReason(written)).toContain("MessageAttachment.expiresAt");
  }, 120_000);

  test("a null expiry is retained indefinitely rather than refused", async () => {
    const id = freshId();
    const written = await harness.run((transaction) =>
      harness.repository.insertAttachment(
        attachmentFixture(chain.attachment, id, { expiresAt: null }),
        transaction,
      ),
    );
    expect(written.ok).toBe(true);
    const swept = await harness.repository.listElapsedAttachments(
      new Date(FILES_AT.getTime() + 10 ** 9),
      500,
    );
    expect(swept.ok && swept.value.some((row) => row.attachmentId === id)).toBe(false);
  }, 120_000);
});

describe("an organization holding no attachment sums to zero, not to null", () => {
  test("COALESCE is what makes an empty quota input a number", async () => {
    const empty = await harness.freshChain();
    const summed = await harness.repository.sumAttachmentBytes(
      organizationScopeOf(empty.organizationId),
    );
    // `sum()` over no rows is SQL NULL, and a quota input of `null` is not zero —
    // it is a crash one layer up, in a caller that subtracts it from a ceiling.
    expect(summed).toEqual({ ok: true, value: 0 });
  }, 120_000);
});
