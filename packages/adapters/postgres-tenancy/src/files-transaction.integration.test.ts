// The transaction boundary, proved by FAILURE INJECTION against a real database,
// and the three scope refusals.
//
// WHY INJECTION AND NOT A ROLLBACK COUNT. A store that counted rollbacks would
// pass a suite that asserted rollbacks. Every case below forces a write of a
// multi-statement operation to fail and then LOOKS FOR THE OTHER ROW — over a
// SECOND client, on a connection this adapter's pool never touched, because
// durability is not "the row is there when the writer looks again" but "the row
// is there when somebody else looks".
//
// *** THE `Result` HALF IS THE TRAP `cost-monitoring` SHIPPED, AND THIS CONTEXT
// HAS BOTH SIDES OF IT ***
// `refuseFiles` turns a refusal into an error `Result`, and an error `Result`
// RESOLVES — so the callback returns normally and the unit of work issues COMMIT.
// Whether that COMMIT is a commit or a rollback is a fact about PostgreSQL and
// not about this package, and the only honest way to know is to look from
// outside. The two cases at the top of this file look, and they answer
// DIFFERENTLY on purpose:
//
//   A GUARD refusal, and the append-only CONFLICT, are values. Nothing was sent
//   or nothing failed, the transaction is intact, and an earlier write in the
//   same unit of work COMMITS. That is the contract — `insertArtifactRevision`'s
//   port comment requires the conflict to be an outcome a caller can act on —
//   and it is why the conflict is spelled `ON CONFLICT ... DO NOTHING` rather
//   than left to the index to raise.
//
//   A DATABASE refusal is not. `MessageAttachment_ancestry` raises inside the
//   transaction, PostgreSQL aborts it, and the earlier write does NOT survive.
//
// A store that answered the same way to both would be wrong twice: it would make
// a recoverable conflict destroy a caller's other work, or make a real integrity
// failure look survivable.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { AttachmentId, TransactionScope } from "@platos/context-files/application/ports/index.js";
import { asIdentifier } from "@platos/context-files/application/ports/index.js";
import { runResult } from "@platos/context-files/application/ports/index.js";

import type { TenancyDatabaseClient } from "./client.js";
import {
  artifactFixture,
  attachmentFixture,
  callerCode,
  erasureSelectorOf,
  refusalCode,
} from "./files-fixtures.js";
import { startFilesHarness, type FilesChain, type FilesHarness } from "./files-harness.js";
import {
  TRANSACTION_NOT_OPEN,
  TRANSACTION_SCOPE_FOREIGN,
  TRANSACTION_SCOPE_UNKNOWN,
} from "./transaction.js";

let harness: FilesHarness;
let chain: FilesChain;
let foreign: FilesChain;
/** A SECOND client over the same database. Nothing this adapter's pool touched. */
let observer: TenancyDatabaseClient;
let sequence = 0;

function freshId(): string {
  sequence += 1;
  return `dddddddd-0003-4000-8000-${String(sequence).padStart(12, "0")}`;
}

beforeAll(async () => {
  harness = await startFilesHarness();
  chain = await harness.freshChain();
  foreign = await harness.freshChain();
  const { PrismaClient } = await import("@platos/tenancy-database");
  observer = new PrismaClient({
    datasources: { db: { url: harness.base.databaseUrl } },
  }) as TenancyDatabaseClient;
}, 300_000);

afterAll(async () => {
  await observer?.$disconnect();
  await harness?.stop();
});

function codeOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return `<uncoded:${String(error)}>`;
}

describe("an artifact revision and an attachment are one transaction or neither", () => {
  test("the attachment fails on ancestry and the revision does not survive it", async () => {
    const artifactId = freshId();
    const attachmentId = freshId();

    // THE FAILURE IS THE ADAPTER'S OWN SECOND STATEMENT, not a third one this
    // suite adds. The attachment names this tenant's environment and ANOTHER
    // tenant's thread, and `MessageAttachment_ancestry` refuses it. Nothing about
    // the failure is simulated.
    const outcome = await runResult(
      harness, async (transaction) => {
        const revision = await harness.repository.insertArtifactRevision(
          artifactFixture(chain.thread, artifactId, { artifactKey: "atomic.witness" }),
          transaction,
        );
        expect(revision.ok).toBe(true);
        return harness.repository.insertAttachment(
          attachmentFixture(chain.attachment, attachmentId, {
            scope: { ...chain.attachment, threadId: foreign.thread.threadId },
          }),
          transaction,
        );
      })
      .catch(() => null);
    expect(outcome === null || !outcome.ok).toBe(true);

    // OVER THE SECOND CLIENT. The revision is gone, and so is the attachment the
    // second half tried to write.
    expect(
      await observer.artifact.count({ where: { threadId: chain.threadId, artifactKey: "atomic.witness" } }),
    ).toBe(0);
    expect(await observer.messageAttachment.count({ where: { id: attachmentId } })).toBe(0);
  }, 120_000);

  test("a GUARD refusal is a value: the earlier write in the same unit of work COMMITS", async () => {
    const attachmentId = freshId();
    const outcome = await runResult(harness, async (transaction) => {
      const written = await harness.repository.insertAttachment(
        attachmentFixture(chain.attachment, attachmentId, { contentHash: "sha256:guard-witness" }),
        transaction,
      );
      expect(written.ok).toBe(true);
      // Refused BEFORE a statement is sent, so the transaction is untouched.
      return harness.repository.insertArtifactRevision(
        artifactFixture(chain.thread, freshId(), { artifactKey: "guarded", revision: 0 }),
        transaction,
      );
    });
    expect(refusalCode(outcome)).toBe("files.write.integer_out_of_range");

    // AND THE ATTACHMENT IS THERE, seen from outside. This is the shape that
    // shipped in `cost-monitoring` as a defect and is the CONTRACT here: the
    // caller was told no in a value it can act on, with its own transaction
    // intact, which is the whole reason the guards refuse before the statement.
    expect(await observer.messageAttachment.count({ where: { id: attachmentId } })).toBe(1);
  }, 120_000);

  test("the append-only CONFLICT is a value too, and the transaction stays usable", async () => {
    const key = "conflict.witness";
    const first = await runResult(harness, (transaction) =>
      harness.repository.insertArtifactRevision(
        artifactFixture(chain.thread, freshId(), { artifactKey: key }),
        transaction,
      ),
    );
    expect(first.ok).toBe(true);

    const attachmentId = freshId();
    const outcome = await runResult(harness, async (transaction) => {
      const conflicted = await harness.repository.insertArtifactRevision(
        artifactFixture(chain.thread, freshId(), { artifactKey: key, content: "rewritten" }),
        transaction,
      );
      expect(callerCode(conflicted)).toBe("FILES_ARTIFACT_REVISION_CONFLICT");
      // THE TRANSACTION IS STILL USABLE. `ON CONFLICT ... DO NOTHING` never
      // raised, so PostgreSQL never aborted; a plain INSERT would have made this
      // next statement fail with 25P02 and the caller would have reported the
      // WRONG failure.
      return harness.repository.insertAttachment(
        attachmentFixture(chain.attachment, attachmentId),
        transaction,
      );
    });
    expect(outcome.ok).toBe(true);
    expect(await observer.messageAttachment.count({ where: { id: attachmentId } })).toBe(1);

    // AND THE FIRST REVISION IS UNCHANGED — never overwritten, never bumped to
    // the next free slot.
    const stored = await observer.artifact.findFirst({
      where: { threadId: chain.threadId, artifactKey: key },
      select: { content: true, revision: true },
    });
    expect(stored).toEqual({ content: "# the summary", revision: 1 });
  }, 120_000);

  test("an erasure that fails midway destroys nothing", async () => {
    const attachmentId = freshId();
    const artifactKey = "erasure.witness";
    expect(
      (await runResult(harness, (transaction) =>
        harness.repository.insertArtifactRevision(
          artifactFixture(chain.thread, freshId(), { artifactKey, createdBy: "user_doomed" }),
          transaction,
        ),
      )).ok,
    ).toBe(true);
    expect(
      (await runResult(harness, (transaction) =>
        harness.repository.insertAttachment(
          attachmentFixture(chain.attachment, attachmentId),
          transaction,
        ),
      )).ok,
    ).toBe(true);

    // The erasure deletes the revisions and then meets a failure. THE FAILURE IS
    // A REAL ONE: the second half writes an attachment against another tenant's
    // thread, which `MessageAttachment_ancestry` refuses.
    await runResult(
      harness, async (transaction) => {
        const removed = await harness.repository.deleteArtifactRevisionsForSubject(
          erasureSelectorOf(chain.organizationId, null, "user_doomed"),
          transaction,
        );
        expect(removed).toEqual({ ok: true, value: 1 });
        const refused = await harness.repository.insertAttachment(
          attachmentFixture(chain.attachment, freshId(), {
            scope: { ...chain.attachment, threadId: foreign.thread.threadId },
          }),
          transaction,
        );
        // The refusal is a value, so the callback returns and the unit of work
        // issues COMMIT — and PostgreSQL, which has already aborted, rolls back.
        return refused;
      })
      .catch(() => null);

    // THE REVISION SURVIVED, seen from outside. An erasure that reported rows
    // destroyed and left them standing would be the worst failure this context
    // can have, and this is the case that would go red first.
    expect(await observer.artifact.count({ where: { threadId: chain.threadId, artifactKey } })).toBe(1);
  }, 120_000);
});

describe("the three scope refusals stay three DISTINCT codes", () => {
  test("a write with no transaction open is not_open", async () => {
    const outside: TransactionScope = { transactionId: asIdentifier("pg-txn-1") };
    const thrown = await harness.repository
      .insertAttachment(attachmentFixture(chain.attachment, freshId()), outside)
      .then(() => null)
      .catch((error: unknown) => error);
    expect(codeOf(thrown)).toBe(TRANSACTION_NOT_OPEN);
  }, 120_000);

  test("a write with a FINISHED transaction's token is scope_unknown", async () => {
    let finished: TransactionScope | null = null;
    await harness.run(async (transaction) => {
      finished = transaction;
    });
    const stale = finished as TransactionScope | null;
    expect(stale).not.toBeNull();
    const thrown = await harness
      .run((live) =>
        harness.repository
          .insertAttachment(attachmentFixture(chain.attachment, freshId()), stale ?? live)
          .then(() => null)
          .catch((error: unknown) => error),
      )
      .catch((error: unknown) => error);
    expect(codeOf(thrown)).toBe(TRANSACTION_SCOPE_UNKNOWN);
  }, 120_000);

  test("a write with ANOTHER LIVE transaction's token is scope_foreign", async () => {
    // TWO LIVE TRANSACTIONS AT ONCE, so the token is open and is not this one.
    // Without the second being LIVE the refusal would be `scope_unknown`, and the
    // two mistakes would be indistinguishable in a log.
    //
    // The concurrent unit of work is opened from OUTSIDE any frame, deliberately.
    // `UnitOfWork.run` JOINS an open transaction rather than opening a second
    // one, so a nested call carries the SAME id and could never be foreign.
    let openConcurrent: (scope: TransactionScope) => void = () => undefined;
    let releaseConcurrent: () => void = () => undefined;
    const opened = new Promise<TransactionScope>((resolve) => {
      openConcurrent = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseConcurrent = resolve;
    });
    const held = harness.base.adapter.unitOfWork.run(async (concurrent) => {
      openConcurrent(concurrent);
      await release;
    });

    const other = await opened;
    const thrown = await harness.run((live) => {
      expect(live.transactionId).not.toBe(other.transactionId);
      return harness.repository
        .insertAttachment(attachmentFixture(chain.attachment, freshId()), other)
        .then(() => null)
        .catch((error: unknown) => error);
    });
    releaseConcurrent();
    await held;
    expect(codeOf(thrown)).toBe(TRANSACTION_SCOPE_FOREIGN);
  }, 120_000);

  test("a DELETE is held to the same three refusals as an insert", async () => {
    const outside: TransactionScope = { transactionId: asIdentifier("pg-txn-1") };
    const thrown = await harness.repository
      .deleteAttachment(
        chain.thread,
        asIdentifier<AttachmentId>("dddddddd-0003-4000-8000-000000000999"),
        outside,
      )
      .then(() => null)
      .catch((error: unknown) => error);
    expect(codeOf(thrown)).toBe(TRANSACTION_NOT_OPEN);
  }, 120_000);

  test("the three codes are distinct strings", () => {
    // The acceptance condition stated directly: two guards sharing one code
    // cannot be told apart, whatever else a suite proves about them.
    expect(
      new Set([TRANSACTION_NOT_OPEN, TRANSACTION_SCOPE_UNKNOWN, TRANSACTION_SCOPE_FOREIGN]).size,
    ).toBe(3);
  });
});
