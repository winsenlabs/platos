// The five RULES that live only in the migrations, and the two referential
// actions that decide what happens to these rows when a turn goes away.
//
// NONE OF THE SEVEN IS IN `schema.prisma` IN A FORM A READER COULD ACT ON, and
// the in-memory double enforces none of them: an attachment there is a record
// with ids in it and no tree behind it, and an update there is `Map.set`.
//
//   MessageAttachment_ancestry         the end user must belong to the
//                                      environment's ORGANIZATION, the agent to
//                                      its PROJECT, and the thread must carry the
//                                      same environment, the same end user AND
//                                      the same agent
//   MessageAttachment_owner_immutable  those four columns may never move
//   MessageAttachment_binding_one_way  a turn binding may never change once set,
//                                      INCLUDING back to NULL
//   Artifact_ancestry                  the thread must be in the row's
//                                      environment and `producedByTurnId` must be
//                                      a turn of THAT thread
//   Artifact_metadata_json_root        cased in files-constraints.integration.test.ts
//
//   MessageAttachment.turnId  ON DELETE CASCADE   — the attachment row GOES
//   Artifact.producedByTurnId ON DELETE SET NULL  — the artifact row STAYS
//
// THE LAST PAIR IS A FINDING AND NOT A FEATURE, and the case at the end of this
// file is the evidence rather than the argument. `domain/destruction.ts` fixes
// blob-before-row because a row surviving its blob is recoverable and a blob
// surviving its row is not: nothing points at it and no sweep can find it.
// Deleting a `Turn` removes every attachment row bound to it in one cascade, and
// no code in this repository is on that path — so the bytes stay in the bucket
// with nothing pointing at them, which is precisely the state the ordering rule
// exists to prevent.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { AttachmentId } from "@platos/context-files/application/ports/index.js";
import { asIdentifier, boundTo } from "@platos/context-files/application/ports/index.js";

import {
  artifactFixture,
  attachmentFixture,
  callerCode,
  endUserIdOf,
  envIdOf,
  orgIdOf,
  projIdOf,
  refusalCode,
  refusalReason,
} from "./files-fixtures.js";
import { startFilesHarness, type FilesChain, type FilesHarness } from "./files-harness.js";

let harness: FilesHarness;
let chain: FilesChain;
let foreign: FilesChain;
let sequence = 0;

function freshId(): string {
  sequence += 1;
  return `dddddddd-0002-4000-8000-${String(sequence).padStart(12, "0")}`;
}

beforeAll(async () => {
  harness = await startFilesHarness();
  chain = await harness.freshChain();
  foreign = await harness.freshChain();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

function plant(sql: string): string {
  try {
    harness.applyPeerRows(sql);
    return "<accepted>";
  } catch (error) {
    const shown = error instanceof Error ? error.message : String(error);
    return shown.replace(/\s+/gu, " ");
  }
}

describe("MessageAttachment_ancestry: the row must name ONE consistent chain", () => {
  test("a thread belonging to another tenant is refused by the trigger, not by a guard", async () => {
    const written = await harness.run((transaction) =>
      harness.repository.insertAttachment(
        // The environment, end user and agent are this tenant's; only the thread
        // is not. Every id is a real uuid, so no shape guard can catch it and the
        // rule in the migrations is the only thing left to refuse it.
        attachmentFixture(chain.attachment, freshId(), {
          scope: { ...chain.attachment, threadId: foreign.thread.threadId },
        }),
        transaction,
      ),
    );
    expect(callerCode(written)).toBe("FILES_REPOSITORY_UNAVAILABLE");
    expect(refusalReason(written)).toContain("MessageAttachment crosses its canonical owner ancestry");
  }, 120_000);

  test("a thread of the SAME environment whose subject is a different end user is refused", async () => {
    const written = await harness.run((transaction) =>
      harness.repository.insertAttachment(
        // `secondThread` is in this environment, on this agent, and belongs to
        // the OTHER subject. The organization clause passes and the project
        // clause passes; the thread's `endUserId` is what refuses it.
        attachmentFixture(chain.attachment, freshId(), {
          scope: { ...chain.attachment, threadId: chain.secondThread.threadId },
        }),
        transaction,
      ),
    );
    expect(refusalReason(written)).toContain("MessageAttachment crosses its canonical owner ancestry");
  }, 120_000);

  test("a turn of another tenant's thread is refused even though the turn exists", async () => {
    const written = await harness.run((transaction) =>
      harness.repository.insertAttachment(
        attachmentFixture(chain.attachment, freshId(), { turnId: foreign.turnId }),
        transaction,
      ),
    );
    expect(refusalReason(written)).toContain("MessageAttachment crosses its canonical owner ancestry");
  }, 120_000);
});

describe("MessageAttachment_binding_one_way: a binding is a transcript fact", () => {
  test("re-binding to a DIFFERENT turn is refused by the database", async () => {
    const id = freshId();
    const created = attachmentFixture(chain.attachment, id);
    expect(
      (await harness.run((transaction) => harness.repository.insertAttachment(created, transaction))).ok,
    ).toBe(true);

    const bound = { ...created, binding: boundTo(asIdentifier(chain.turnId)) };
    expect(
      (await harness.run((transaction) =>
        harness.repository.updateAttachmentBinding(bound, transaction),
      )).ok,
    ).toBe(true);

    const moved = { ...created, binding: boundTo(asIdentifier(chain.secondTurnId)) };
    const refused = await harness.run((transaction) =>
      harness.repository.updateAttachmentBinding(moved, transaction),
    );
    expect(callerCode(refused)).toBe("FILES_REPOSITORY_UNAVAILABLE");
    expect(refusalReason(refused)).toContain("turn binding is one-way and immutable");

    // AND THE ROW DID NOT MOVE. The double would have answered `ok` and rewritten
    // the transcript.
    const read = await harness.repository.findAttachment(chain.thread, asIdentifier<AttachmentId>(id));
    expect(read.ok && read.value?.binding).toEqual(boundTo(asIdentifier(chain.turnId)));
  }, 120_000);

  test("UNBINDING is refused too, which no rule in the domain expresses", async () => {
    const id = freshId();
    const created = attachmentFixture(chain.attachment, id, { turnId: chain.turnId });
    expect(
      (await harness.run((transaction) => harness.repository.insertAttachment(created, transaction))).ok,
    ).toBe(true);

    const unbound = attachmentFixture(chain.attachment, id, { turnId: null });
    const refused = await harness.run((transaction) =>
      harness.repository.updateAttachmentBinding(unbound, transaction),
    );
    expect(refusalReason(refused)).toContain("turn binding is one-way and immutable");
  }, 120_000);
});

describe("MessageAttachment_owner_immutable: four columns that may never move", () => {
  test("a raw UPDATE of endUserId is refused, and ANCESTRY is what refuses it first", () => {
    const id = freshId();
    expect(
      plant(
        `INSERT INTO "MessageAttachment" ("id","environmentId","endUserId","agentId","threadId",
           "kind","mimeType","bytes","storageKey","createdAt")
         VALUES ('${id}','${chain.environmentId}','${chain.endUserId}','${chain.agentId}',
                 '${chain.threadId}','document','application/pdf',10,'k','2026-06-01T09:00:00Z');`,
      ),
    ).toBe("<accepted>");
    // FOUND BY THE FIRST INTEGRATION RUN, and it is a fact about the schema
    // rather than about this store. PostgreSQL fires BEFORE triggers in
    // ALPHABETICAL order by name, so `MessageAttachment_ancestry` runs before
    // `MessageAttachment_owner_immutable` — and the thread pins the environment,
    // the subject AND the agent, so every move of any of those three breaks the
    // chain and is refused by the ancestry rule before the immutability rule is
    // reached. The immutability rule is not what stops this move.
    expect(
      plant(
        `UPDATE "MessageAttachment" SET "endUserId" = '${chain.secondEndUserId}' WHERE "id" = '${id}';`,
      ),
    ).toMatch(/MessageAttachment crosses its canonical owner ancestry/u);
  }, 120_000);

  test("the ONE owner move the ancestry rule permits is the one that reaches the rule", () => {
    const id = freshId();
    expect(
      plant(
        `INSERT INTO "MessageAttachment" ("id","environmentId","endUserId","agentId","threadId",
           "kind","mimeType","bytes","storageKey","createdAt")
         VALUES ('${id}','${chain.environmentId}','${chain.endUserId}','${chain.agentId}',
                 '${chain.threadId}','document','application/pdf',10,'k','2026-06-01T09:00:00Z');`,
      ),
    ).toBe("<accepted>");
    // `thirdThread` is a SIBLING thread: same environment, same agent, same end
    // user. The ancestry rule has nothing to object to — every clause it checks
    // still holds — so this is the one owner change in the table that gets past
    // it, and `MessageAttachment_owner_immutable` is what refuses it, naming the
    // column. Without this case that rule would be unreachable and its entry in
    // the ledger would be a claim nothing could falsify.
    expect(
      plant(
        `UPDATE "MessageAttachment" SET "threadId" = '${chain.thirdThreadId}' WHERE "id" = '${id}';`,
      ),
    ).toMatch(/ownership\/authorization key threadId is immutable/u);
  }, 120_000);

  test("through the port a moved owner is NOT FOUND, because the owner is in the WHERE", async () => {
    const id = freshId();
    const created = attachmentFixture(chain.attachment, id);
    expect(
      (await harness.run((transaction) => harness.repository.insertAttachment(created, transaction))).ok,
    ).toBe(true);

    const moved = {
      ...created,
      scope: {
        ...chain.attachment,
        owner: { ...chain.attachment.owner, endUserId: endUserIdOf(chain.secondEndUserId) },
      },
      binding: boundTo(asIdentifier(chain.turnId)),
    };
    const refused = await harness.run((transaction) =>
      harness.repository.updateAttachmentBinding(moved, transaction),
    );
    // NOT `repository_unavailable`. The store never sends the move at all, so the
    // caller gets the truthful sentence — no attachment with THAT owner and THAT
    // id exists — rather than a 23514 naming a column and not a port.
    expect(callerCode(refused)).toBe("FILES_ATTACHMENT_NOT_FOUND");
  }, 120_000);

  test("an update of a row that does not exist is NOT FOUND, where the double upserts", async () => {
    const absent = attachmentFixture(chain.attachment, freshId(), { turnId: chain.turnId });
    const refused = await harness.run((transaction) =>
      harness.repository.updateAttachmentBinding(absent, transaction),
    );
    expect(callerCode(refused)).toBe("FILES_ATTACHMENT_NOT_FOUND");

    // AND NOTHING WAS CREATED. `InMemoryFilesRepository.updateAttachmentBinding`
    // is `Map.set`, so on that side this call would have MADE the row and
    // answered `ok`; the divergence is the reason this case is here and not in
    // the conformance scenario.
    const read = await harness.repository.findAttachment(chain.thread, absent.attachmentId);
    expect(read).toEqual({ ok: true, value: null });
  }, 120_000);
});

describe("Artifact_ancestry: the thread and the producing turn are both checked", () => {
  test("a thread in another environment is refused", async () => {
    const written = await harness.run((transaction) =>
      harness.repository.insertArtifactRevision(
        artifactFixture(chain.thread, freshId(), {
          scope: { environment: chain.environment, threadId: foreign.thread.threadId },
          artifactKey: "cross.env",
        }),
        transaction,
      ),
    );
    expect(refusalReason(written)).toContain("Artifact crosses its canonical owner ancestry");
  }, 120_000);

  test("a producing turn that is not a turn of this thread is refused", async () => {
    const written = await harness.run((transaction) =>
      harness.repository.insertArtifactRevision(
        artifactFixture(chain.thread, freshId(), {
          artifactKey: "cross.turn",
          producedByTurnId: foreign.turnId,
        }),
        transaction,
      ),
    );
    expect(refusalReason(written)).toContain("Artifact crosses its canonical owner ancestry");
  }, 120_000);
});

describe("the scope claim no database rule checks", () => {
  test("a forged organization is refused on an attachment write, before any row is touched", async () => {
    const forged = {
      ...chain.attachment,
      environment: { ...chain.environment, organizationId: orgIdOf(foreign.organizationId) },
    };
    const written = await harness.run((transaction) =>
      harness.repository.insertAttachment(
        attachmentFixture(forged, freshId(), { scope: forged }),
        transaction,
      ),
    );
    expect(refusalCode(written)).toBe("files.write.scope_ancestry_forged");
  }, 120_000);

  test("a forged project is refused on an artifact write on the same guard", async () => {
    const forged = { ...chain.environment, projectId: projIdOf(foreign.projectId) };
    const written = await harness.run((transaction) =>
      harness.repository.insertArtifactRevision(
        artifactFixture(chain.thread, freshId(), {
          scope: { environment: forged, threadId: chain.thread.threadId },
          artifactKey: "forged.project",
        }),
        transaction,
      ),
    );
    expect(refusalCode(written)).toBe("files.write.scope_ancestry_forged");
  }, 120_000);

  test("an environment that does not exist is a DIFFERENT code from a forged parent", async () => {
    const unknown = {
      ...chain.attachment,
      environment: {
        ...chain.environment,
        environmentId: envIdOf("aaaaaaaa-9999-4000-8000-999999999999"),
      },
    };
    const written = await harness.run((transaction) =>
      harness.repository.insertAttachment(
        attachmentFixture(unknown, freshId(), { scope: unknown }),
        transaction,
      ),
    );
    expect(refusalCode(written)).toBe("files.write.scope_environment_unknown");
  }, 120_000);

  test("a delete under a forged scope is refused before a row is removed", async () => {
    const id = freshId();
    expect(
      (await harness.run((transaction) =>
        harness.repository.insertAttachment(
          attachmentFixture(chain.attachment, id),
          transaction,
        ),
      )).ok,
    ).toBe(true);

    const forgedThread = {
      environment: { ...chain.environment, organizationId: orgIdOf(foreign.organizationId) },
      threadId: chain.thread.threadId,
    };
    const refused = await harness.run((transaction) =>
      harness.repository.deleteAttachment(forgedThread, asIdentifier<AttachmentId>(id), transaction),
    );
    expect(refusalCode(refused)).toBe("files.write.scope_ancestry_forged");
    const survived = await harness.repository.findAttachment(
      chain.thread,
      asIdentifier<AttachmentId>(id),
    );
    expect(survived.ok && survived.value?.attachmentId).toBe(id);
  }, 120_000);
});

describe("what happens to these two rows when the turn that produced them goes away", () => {
  test("a bound attachment CASCADES with its turn and its blob is left orphaned", async () => {
    // A turn of its own, so the cascade cannot take anything another case needs.
    const turnId = freshId();
    harness.applyPeerRows(
      `INSERT INTO "Turn" ("id","threadId","agentVersionId","versionBucket","sequence","status","createdAt")
       VALUES ('${turnId}','${chain.threadId}','${chain.agentVersionId}','CURRENT',9,'SUCCEEDED','2026-06-01T09:00:00Z');`,
    );
    const attachmentId = freshId();
    expect(
      (await harness.run((transaction) =>
        harness.repository.insertAttachment(
          attachmentFixture(chain.attachment, attachmentId, { turnId }),
          transaction,
        ),
      )).ok,
    ).toBe(true);
    const artifactId = freshId();
    expect(
      (await harness.run((transaction) =>
        harness.repository.insertArtifactRevision(
          artifactFixture(chain.thread, artifactId, {
            artifactKey: "cascade.witness",
            producedByTurnId: turnId,
          }),
          transaction,
        ),
      )).ok,
    ).toBe(true);

    harness.applyPeerRows(`DELETE FROM "Turn" WHERE "id" = '${turnId}';`);

    // THE ATTACHMENT ROW IS GONE. `MessageAttachment_turnId_fkey` is ON DELETE
    // CASCADE, so nothing points at its blob any more and no sweep can reach it:
    // `listElapsedAttachments` reads rows, and there is no row.
    const attachment = await harness.repository.findAttachment(
      chain.thread,
      asIdentifier<AttachmentId>(attachmentId),
    );
    expect(attachment).toEqual({ ok: true, value: null });

    // THE ARTIFACT ROW SURVIVES WITH A NULLED POINTER.
    // `Artifact_producedByTurnId_fkey` is ON DELETE SET NULL, which is the
    // opposite decision on the same event — and the right one, because an
    // artifact's content is IN the row.
    const artifact = await harness.repository.findArtifactRevision(
      chain.thread,
      asIdentifier("cascade.witness"),
      1,
    );
    expect(artifact.ok && artifact.value?.producedByTurnId).toBeNull();
  }, 120_000);
});
