import { asIdentifier } from "@platos/kernel";
import type { ErasurePlan, ErasureSubject, PrincipalId, TransactionScope } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import type { ArtifactKey } from "../domain/index.js";
import {
  ARTIFACT_MODEL,
  ATTACHMENT_MODEL,
  createFilesErasureTarget,
  FILES_ERASURE_TARGET_NAME,
  FilesErasureRejected,
  isFilesErasurePlan,
} from "./files-erasure-target.js";
import { presignAttachmentUpload } from "./presign-attachment-upload.js";
import { buildFilesTestContext, testAttachmentScope, testThreadScope, type FilesTestContext } from "./testing/index.js";
import { writeArtifactRevision } from "./write-artifact-revision.js";

const SUBJECT_ID = "end-user-1";
const AUTHOR: PrincipalId = asIdentifier(SUBJECT_ID);
const TRANSACTION: TransactionScope = { transactionId: asIdentifier("txn-erasure") };

function subjectIn(environmentId: string, kind: ErasureSubject["subjectKind"] = "end-user"): ErasureSubject {
  return { subjectKind: kind, subjectId: SUBJECT_ID, scope: testThreadScope(environmentId).environment };
}

async function seedSubjectData(context: FilesTestContext, environmentId: string): Promise<void> {
  const created = await presignAttachmentUpload(context.dependencies, {
    scope: testAttachmentScope(environmentId),
    intake: { mimeType: "image/png", bytes: 3 },
  });
  if (!created.ok) throw new Error(created.error.code);
  context.objectStore.seed(created.value.attachment.storageKey, new Uint8Array([1, 2, 3]), "image/png");
  const written = await writeArtifactRevision(context.dependencies, {
    scope: testThreadScope(environmentId),
    artifactKey: asIdentifier<ArtifactKey>("a_report"),
    kind: "markdown",
    content: "# private",
    createdBy: AUTHOR,
  });
  if (!written.ok) throw new Error(written.error.code);
}

describe("createFilesErasureTarget", () => {
  let context: FilesTestContext;

  beforeEach(async () => {
    context = buildFilesTestContext();
    await seedSubjectData(context, "env-1");
  });

  it("names this context and covers exactly the two models it is sole writer of", async () => {
    const target = createFilesErasureTarget(context.dependencies);
    expect(target.targetName).toBe(FILES_ERASURE_TARGET_NAME);
    const plan = await target.plan(subjectIn("env-1"));
    expect(plan.items.map((item) => item.model)).toEqual([ATTACHMENT_MODEL, ARTIFACT_MODEL]);
  });

  it("plans `delete` for both models — an inline artifact is deleted, not anonymised", async () => {
    const plan = await createFilesErasureTarget(context.dependencies).plan(subjectIn("env-1"));
    expect(plan.items.every((item) => item.method === "delete")).toBe(true);
    expect(plan.items.map((item) => item.rowCount)).toEqual([1, 1]);
    expect(plan.items.every((item) => item.blockedBy === null)).toBe(true);
  });

  it("does not mutate while planning", async () => {
    await createFilesErasureTarget(context.dependencies).plan(subjectIn("env-1"));
    expect(context.repository.allAttachments()).toHaveLength(1);
    expect(context.repository.allArtifactRevisions()).toHaveLength(1);
    expect(context.objectStore.size).toBe(1);
  });

  it("plans nothing for another environment's rows", async () => {
    const plan = await createFilesErasureTarget(context.dependencies).plan(subjectIn("env-9"));
    expect(plan.items.map((item) => item.rowCount)).toEqual([0, 0]);
  });

  it("plans zero rows for an `entity` subject, which this context does not key on", async () => {
    const plan = await createFilesErasureTarget(context.dependencies).plan(subjectIn("env-1", "entity"));
    expect(plan.items.map((item) => item.rowCount)).toEqual([0, 0]);
  });

  it("plans only artifacts for an operator `user` subject", async () => {
    const plan = await createFilesErasureTarget(context.dependencies).plan(subjectIn("env-1", "user"));
    expect(plan.items.map((item) => item.rowCount)).toEqual([0, 1]);
  });

  it("destroys blobs and rows, and returns a receipt of what actually went", async () => {
    const target = createFilesErasureTarget(context.dependencies);
    const plan = await target.plan(subjectIn("env-1"));
    const receipt = await target.erase(plan, TRANSACTION);

    expect(receipt.targetName).toBe(FILES_ERASURE_TARGET_NAME);
    expect(receipt.items.map((item) => item.rowCount)).toEqual([1, 1]);
    expect(context.repository.allAttachments()).toHaveLength(0);
    expect(context.repository.allArtifactRevisions()).toHaveLength(0);
    expect(context.objectStore.size).toBe(0);
  });

  it("REJECTS rather than issuing a receipt when a blob will not be destroyed", async () => {
    const target = createFilesErasureTarget(context.dependencies);
    const plan = await target.plan(subjectIn("env-1"));
    context.objectStore.deleteFails = true;

    await expect(target.erase(plan, TRANSACTION)).rejects.toBeInstanceOf(FilesErasureRejected);
    expect(context.repository.allAttachments()).toHaveLength(1);
  });

  it("REJECTS a plan it did not mint, because such a plan carries no subject", async () => {
    const target = createFilesErasureTarget(context.dependencies);
    const foreign: ErasurePlan = { targetName: "files", items: [] };
    expect(isFilesErasurePlan(foreign)).toBe(false);
    await expect(target.erase(foreign, TRANSACTION)).rejects.toBeInstanceOf(FilesErasureRejected);
  });

  it("marks the plan it does mint as its own", async () => {
    const plan = await createFilesErasureTarget(context.dependencies).plan(subjectIn("env-1"));
    expect(isFilesErasurePlan(plan)).toBe(true);
  });
});
