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
  artifactFixture,
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

  test("the right thread under a SIBLING environment of the same project does not", async () => {
    // FOUND BY THE MUTATION SWEEP. This case used to name `foreign.environment`,
    // which differs in all THREE ids — so the project and organization clauses
    // answered it and a store that had dropped its ENVIRONMENT clause passed.
    // The sibling environment shares this tenant's organization and project and
    // differs in nothing else, so the environment clause is the only thing left
    // that can produce the miss.
    const read = await harness.repository.findAttachment(
      {
        environment: { ...chain.environment, environmentId: envIdOf(chain.secondEnvironmentId) },
        threadId: chain.thread.threadId,
      },
      subject,
    );
    expect(read).toEqual({ ok: true, value: null });
  }, 120_000);

  test("and a wholly foreign environment does not either", async () => {
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

  test("the probe under a SIBLING environment of the same project finds nothing", async () => {
    // The same correction the attachment read needed, for the same reason: the
    // sibling environment differs from this tenant's in the environment id and
    // in nothing else.
    const read = await harness.repository.findAttachmentByContentHash(
      { ...chain.environment, environmentId: envIdOf(chain.secondEnvironmentId) },
      asIdentifier<ContentHash>("sha256:scope-subject"),
    );
    expect(read).toEqual({ ok: true, value: null });
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

describe("the uuid guard is ANCHORED, so a string that merely contains one is not one", () => {
  test("a thread id with a uuid inside it is refused rather than matched", async () => {
    const read = await harness.repository.findAttachment(
      { environment: chain.environment, threadId: asIdentifier(`prefix-${chain.threadId}`) },
      subject,
    );
    // Without `^` and `$` on the pattern this passes the shape guard, reaches the
    // statement as a `::uuid` cast, and fails in the driver with a parameter error
    // naming no column — which is the failure the guard exists to replace.
    expect(refusalCode(read)).toBe("files.write.identifier_not_uuid");
  }, 120_000);
});

describe("the artifact reads carry the same four clauses as the attachment reads", () => {
  test("the latest revision is not visible from a foreign PROJECT of the right environment", async () => {
    const key = "scope.artifact";
    expect(
      (await harness.run((transaction) =>
        harness.repository.insertArtifactRevision(
          artifactFixture(chain.thread, freshId(), { artifactKey: key }),
          transaction,
        ),
      )).ok,
    ).toBe(true);

    expect(
      await harness.repository.findLatestArtifactRevision(
        {
          environment: { ...chain.environment, projectId: projIdOf(foreign.projectId) },
          threadId: chain.thread.threadId,
        },
        asIdentifier(key),
      ),
    ).toEqual({ ok: true, value: null });

    expect(
      await harness.repository.findLatestArtifactRevision(
        {
          environment: { ...chain.environment, organizationId: orgIdOf(foreign.organizationId) },
          threadId: chain.thread.threadId,
        },
        asIdentifier(key),
      ),
    ).toEqual({ ok: true, value: null });

    // And the exact read carries them too.
    expect(
      await harness.repository.findArtifactRevision(
        {
          environment: { ...chain.environment, projectId: projIdOf(foreign.projectId) },
          threadId: chain.thread.threadId,
        },
        asIdentifier(key),
        1,
      ),
    ).toEqual({ ok: true, value: null });
  }, 120_000);
});

describe("the erasure predicate narrows on all three levels, each falsifiable alone", () => {
  test("an ENVIRONMENT selector naming a sibling environment counts none of the subject's rows", async () => {
    const wide = await harness.repository.countAttachmentsForSubject({
      scope: organizationScopeOf(chain.organizationId),
      endUserId: chain.endUserId,
      principalId: null,
    });
    expect(wide.ok && wide.value).toBeGreaterThan(0);

    // The organization and the project are BOTH this tenant's. Only the
    // environment differs, and it holds nothing — so the environment clause is
    // the only thing that can produce this zero.
    const narrow = await harness.repository.countAttachmentsForSubject({
      scope: { ...chain.environment, environmentId: envIdOf(chain.secondEnvironmentId) },
      endUserId: chain.endUserId,
      principalId: null,
    });
    expect(narrow).toEqual({ ok: true, value: 0 });
  }, 120_000);

  test("the subject clause holds: another subject's rows in the same organization are not the subject's", async () => {
    const other = freshId();
    expect(
      (await harness.run((transaction) =>
        harness.repository.insertAttachment(
          attachmentFixture(chain.secondAttachment, other),
          transaction,
        ),
      )).ok,
    ).toBe(true);

    const listed = await harness.repository.listAttachmentsForSubject({
      scope: organizationScopeOf(chain.organizationId),
      endUserId: chain.endUserId,
      principalId: null,
    });
    expect(listed.ok).toBe(true);
    expect(listed.ok && listed.value.some((row) => row.attachmentId === other)).toBe(false);
    expect(listed.ok && listed.value.some((row) => row.attachmentId === subject)).toBe(true);

    // AND THE COUNT AGREES WITH THE LISTING, which is the assertion the mutation
    // sweep showed was missing: the two statements carry the same clause and are
    // written separately, so the count could have lost its subject filter while
    // the listing kept one and every case still passed. The plan's row count and
    // the rows the receipt destroys have to be the same set.
    const counted = await harness.repository.countAttachmentsForSubject({
      scope: organizationScopeOf(chain.organizationId),
      endUserId: chain.endUserId,
      principalId: null,
    });
    expect(counted).toEqual({ ok: true, value: listed.ok ? listed.value.length : -1 });
  }, 120_000);

  test("the principal clause holds: another author's revisions are counted out and left alone", async () => {
    const mine = "user_scope_mine";
    const theirs = "user_scope_theirs";
    expect(
      (await harness.run((transaction) =>
        harness.repository.insertArtifactRevision(
          artifactFixture(chain.thread, freshId(), { artifactKey: "mine.key", createdBy: mine }),
          transaction,
        ),
      )).ok,
    ).toBe(true);
    expect(
      (await harness.run((transaction) =>
        harness.repository.insertArtifactRevision(
          artifactFixture(chain.thread, freshId(), { artifactKey: "theirs.key", createdBy: theirs }),
          transaction,
        ),
      )).ok,
    ).toBe(true);

    const counted = await harness.repository.countArtifactRevisionsForSubject({
      scope: organizationScopeOf(chain.organizationId),
      endUserId: null,
      principalId: mine,
    });
    expect(counted).toEqual({ ok: true, value: 1 });

    const removed = await harness.run((transaction) =>
      harness.repository.deleteArtifactRevisionsForSubject(
        {
          scope: organizationScopeOf(chain.organizationId),
          endUserId: null,
          principalId: mine,
        },
        transaction,
      ),
    );
    expect(removed).toEqual({ ok: true, value: 1 });

    // THE OTHER AUTHOR'S REVISION IS STILL THERE. An erasure that took it would
    // have destroyed a person's document while erasing somebody else.
    expect(
      await harness.repository.countArtifactRevisionsForSubject({
        scope: organizationScopeOf(chain.organizationId),
        endUserId: null,
        principalId: theirs,
      }),
    ).toEqual({ ok: true, value: 1 });
  }, 120_000);
});

describe("one thread may hold two artifacts and one environment two threads", () => {
  test("the latest read is keyed by the ARTIFACT KEY, not by the thread's highest revision", async () => {
    // FOUND BY THE MUTATION SWEEP. Every earlier case read a key that was the
    // only one in its thread, so a store that had dropped its key clause
    // answered correctly. Two keys in one thread at different revisions is the
    // only shape that separates them.
    expect(
      (await harness.run((transaction) =>
        harness.repository.insertArtifactRevision(
          artifactFixture(chain.thread, freshId(), { artifactKey: "key.alpha", revision: 1 }),
          transaction,
        ),
      )).ok,
    ).toBe(true);
    for (const revision of [1, 2, 3]) {
      expect(
        (await harness.run((transaction) =>
          harness.repository.insertArtifactRevision(
            artifactFixture(chain.thread, freshId(), { artifactKey: "key.beta", revision }),
            transaction,
          ),
        )).ok,
      ).toBe(true);
    }

    const alpha = await harness.repository.findLatestArtifactRevision(
      chain.thread,
      asIdentifier("key.alpha"),
    );
    expect(alpha.ok && alpha.value?.revision).toBe(1);
    expect(alpha.ok && alpha.value?.artifactKey).toBe("key.alpha");
  }, 120_000);

  test("both artifact reads are keyed by the THREAD, not by the environment", async () => {
    // FOUND BY THE MUTATION SWEEP for the same reason: the differential asks its
    // cross-thread question of a thread in ANOTHER environment, so the
    // environment clause answered it. Two threads of the SAME environment
    // holding the same key at different revisions is the shape that isolates the
    // thread clause.
    const key = "shared.between.threads";
    expect(
      (await harness.run((transaction) =>
        harness.repository.insertArtifactRevision(
          artifactFixture(chain.thread, freshId(), { artifactKey: key, revision: 1 }),
          transaction,
        ),
      )).ok,
    ).toBe(true);
    for (const revision of [1, 2]) {
      expect(
        (await harness.run((transaction) =>
          harness.repository.insertArtifactRevision(
            artifactFixture(chain.secondThread, freshId(), { artifactKey: key, revision }),
            transaction,
          ),
        )).ok,
      ).toBe(true);
    }

    const mine = await harness.repository.findLatestArtifactRevision(
      chain.thread,
      asIdentifier(key),
    );
    expect(mine.ok && mine.value?.revision).toBe(1);

    // And the EXACT read carries the clause too: revision 2 exists in this
    // environment, in the sibling thread, and is not this thread's.
    const exact = await harness.repository.findArtifactRevision(
      chain.thread,
      asIdentifier(key),
      2,
    );
    expect(exact).toEqual({ ok: true, value: null });
  }, 120_000);
});
