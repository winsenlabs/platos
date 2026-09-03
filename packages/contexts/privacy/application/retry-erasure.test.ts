import { asIdentifier } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PRIVACY_POLICY,
  type ErasureOperationId,
  type IdempotencyKey,
  type LeaseToken,
} from "../domain/index.js";
import { PRIVACY_EVENT_NAMES } from "../contracts/events.js";
import { requestErasure } from "./request-erasure.js";
import { retryErasure } from "./retry-erasure.js";
import {
  InMemoryErasureTarget,
  TEST_ORGANIZATION,
  buildPrivacyTestContext,
  testAliases,
  testEnvironmentSubject,
  type PrivacyTestContext,
} from "./testing/index.js";

const EXTERNAL_ID = "walle-1";
const KEY = asIdentifier<IdempotencyKey>("key-1");
const SUBJECT = testEnvironmentSubject("eu-1");

function seed(target: InMemoryErasureTarget): void {
  target.seed({
    model: "TestRow",
    subjectKind: "end-user",
    subjectId: "eu-1",
    scopePath: "org/org-1/proj/proj-1/env/env-1",
  });
}

describe("retryErasure", () => {
  let context: PrivacyTestContext;
  let files: InMemoryErasureTarget;
  let tools: InMemoryErasureTarget;
  let operationId: ErasureOperationId;

  beforeEach(async () => {
    files = new InMemoryErasureTarget("files");
    tools = new InMemoryErasureTarget("tools");
    context = buildPrivacyTestContext({ targets: [files, tools] });
    context.directory.register(EXTERNAL_ID, {
      subjects: [SUBJECT],
      aliases: testAliases(EXTERNAL_ID, "eu-1"),
    });
    seed(files);
    seed(tools);

    // A first pass in which `tools` refuses, so the whole pass rolls back and
    // nothing settles.
    tools.eraseRejects = true;
    const first = await requestErasure(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      externalUserId: EXTERNAL_ID,
      idempotencyKey: KEY,
    });
    if (!first.ok) throw new Error("unreachable");
    operationId = first.value.operationId;
  });

  function retry(overrides: Partial<Parameters<typeof retryErasure>[1]> = {}) {
    return retryErasure(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      operationId,
      externalUserId: EXTERNAL_ID,
      ...overrides,
    });
  }

  it("finishes the operation once the refusing target recovers", async () => {
    tools.eraseRejects = false;
    const retried = await retry();
    if (!retried.ok) throw new Error("unreachable");
    expect(retried.value.status).toBe("completed");
    expect(files.remaining()).toHaveLength(0);
    expect(tools.remaining()).toHaveLength(0);
  });

  it("counts the pass, so an operator can see how many passes it took", async () => {
    tools.eraseRejects = false;
    const retried = await retry();
    if (!retried.ok) throw new Error("unreachable");
    expect(retried.value.retryCount).toBe(2);
  });

  it("re-runs only the unsettled targets", async () => {
    // A first pass in which `files` settles and `tools` reports a receipt while
    // deleting nothing. No target rejected, so nothing rolls back and the two
    // land in genuinely different states.
    const settledFiles = new InMemoryErasureTarget("files");
    const silentTools = new InMemoryErasureTarget("tools");
    seed(settledFiles);
    seed(silentTools);
    silentTools.eraseSilently = true;
    const mixed = buildPrivacyTestContext({ targets: [settledFiles, silentTools] });
    mixed.directory.register(EXTERNAL_ID, { subjects: [SUBJECT], aliases: testAliases(EXTERNAL_ID, "eu-1") });
    const first = await requestErasure(mixed.dependencies, {
      organizationId: TEST_ORGANIZATION,
      externalUserId: EXTERNAL_ID,
      idempotencyKey: KEY,
    });
    if (!first.ok) throw new Error("unreachable");
    expect(first.value.outcomes.map((outcome) => outcome.verification)).toEqual(["passed", "failed"]);

    const filesCallsBefore = settledFiles.calls.length;
    silentTools.eraseSilently = false;
    const second = await retryErasure(mixed.dependencies, {
      organizationId: TEST_ORGANIZATION,
      operationId: first.value.operationId,
      externalUserId: EXTERNAL_ID,
    });
    if (!second.ok) throw new Error("unreachable");
    // `files` was never asked again — re-issuing deletes against data already
    // gone would report fresh counts for work that finished on the first pass.
    expect(settledFiles.calls.length).toBe(filesCallsBefore);
    expect(second.value.status).toBe("completed");
  });

  it("REFUSES a completed operation rather than re-issuing deletes", async () => {
    tools.eraseRejects = false;
    await retry();
    const again = await retry();
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error("unreachable");
    expect(again.error.code).toBe("PRIVACY_RETRY_NOT_PERMITTED");
  });

  it("refuses a held operation until the hold is released", async () => {
    const held = buildPrivacyTestContext({ targets: [new InMemoryErasureTarget("files")] });
    held.directory.register(EXTERNAL_ID, { subjects: [SUBJECT], aliases: testAliases(EXTERNAL_ID, "eu-1") });
    held.holds.set(TEST_ORGANIZATION, [EXTERNAL_ID]);
    const blocked = await requestErasure(held.dependencies, {
      organizationId: TEST_ORGANIZATION,
      externalUserId: EXTERNAL_ID,
      idempotencyKey: KEY,
    });
    if (!blocked.ok) throw new Error("unreachable");
    const refused = await retryErasure(held.dependencies, {
      organizationId: TEST_ORGANIZATION,
      operationId: blocked.value.operationId,
      externalUserId: EXTERNAL_ID,
    });
    expect(refused.ok).toBe(false);
  });

  it("REFUSES rather than running narrow when the subject can no longer be resolved", async () => {
    const refused = await retry({ externalUserId: "never-seen" });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error.code).toBe("PRIVACY_SUBJECT_NOT_RESOLVED");
    // Nothing ran, so the rows the first pass restored are still there.
    expect(files.remaining()).toHaveLength(1);
  });

  it("REFUSES a re-supplied handle that names a DIFFERENT person", async () => {
    context.directory.register("someone-else", {
      subjects: [testEnvironmentSubject("eu-2")],
      aliases: testAliases("someone-else", "eu-2"),
    });
    const refused = await retry({ externalUserId: "someone-else" });
    expect(refused.ok).toBe(false);
    expect(context.outbox.names()).toContain(PRIVACY_EVENT_NAMES.erasureRefused);
  });

  it("refuses once the automatic retry budget is spent", async () => {
    const row = context.repository.allOperations()[0];
    if (row === undefined) throw new Error("unreachable");
    context.repository.seedOperation({ ...row, retryCount: DEFAULT_PRIVACY_POLICY.retry.maxRetries });
    const refused = await retry();
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error.code).toBe("PRIVACY_RETRY_BUDGET_EXHAUSTED");
  });

  it("refuses while another pass holds the lease", async () => {
    const row = context.repository.allOperations()[0];
    if (row === undefined) throw new Error("unreachable");
    context.repository.seedOperation({
      ...row,
      leaseToken: asIdentifier<LeaseToken>("someone-elses-lease"),
      leaseExpiresAt: new Date(context.clock.now().getTime() + 60_000),
    });
    const refused = await retry();
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error.code).toBe("PRIVACY_LEASE_HELD");
  });

  it("reclaims a crashed pass's lease once it has expired", async () => {
    const row = context.repository.allOperations()[0];
    if (row === undefined) throw new Error("unreachable");
    context.repository.seedOperation({
      ...row,
      leaseToken: asIdentifier<LeaseToken>("crashed-lease"),
      leaseExpiresAt: new Date(context.clock.now().getTime() - 1),
    });
    tools.eraseRejects = false;
    const retried = await retry();
    expect(retried.ok).toBe(true);
  });

  it("does not find an operation belonging to another organization", async () => {
    const refused = await retryErasure(context.dependencies, {
      organizationId: asIdentifier("org-2"),
      operationId,
      externalUserId: EXTERNAL_ID,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error.code).toBe("PRIVACY_OPERATION_NOT_FOUND");
  });

  it("REFUSES to soften an earlier verification failure with a fresh unknown", async () => {
    // Arrange a first pass where `tools` reported a receipt and deleted nothing:
    // positive evidence that data survived.
    const silent = new InMemoryErasureTarget("files");
    silent.seed({
      model: "TestRow",
      subjectKind: "end-user",
      subjectId: "eu-1",
      scopePath: "org/org-1/proj/proj-1/env/env-1",
    });
    silent.eraseSilently = true;
    const evidence = buildPrivacyTestContext({ targets: [silent] });
    evidence.directory.register(EXTERNAL_ID, { subjects: [SUBJECT], aliases: testAliases(EXTERNAL_ID, "eu-1") });
    const first = await requestErasure(evidence.dependencies, {
      organizationId: TEST_ORGANIZATION,
      externalUserId: EXTERNAL_ID,
      idempotencyKey: KEY,
    });
    if (!first.ok) throw new Error("unreachable");
    expect(first.value.status).toBe("verification_failed");

    // The retry can no longer probe. Learning nothing must not upgrade the
    // operation from `verification_failed` to `partial_failure`.
    silent.reprobeFails = true;
    const second = await retryErasure(evidence.dependencies, {
      organizationId: TEST_ORGANIZATION,
      operationId: first.value.operationId,
      externalUserId: EXTERNAL_ID,
    });
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.status).toBe("verification_failed");
    expect(second.value.outcomes[0]?.note).toContain("not refuted by this pass");
  });

  it("appends a fresh intent record for the pass, naming only the unsettled targets", async () => {
    tools.eraseRejects = false;
    context.outbox.appended.length = 0;
    await retry();
    const intent = context.outbox.appended.find(
      (event) => event.name === PRIVACY_EVENT_NAMES.erasureRequested,
    );
    expect(intent).toBeDefined();
    expect((intent?.payload as { targets: string[] }).targets).toEqual(["files", "tools"]);
  });

  it("names the pass cause, so a queue resume is distinguishable from an operator", async () => {
    tools.eraseRejects = false;
    context.outbox.appended.length = 0;
    await retry({ cause: "queue-resume" });
    const finished = context.outbox.appended.find(
      (event) => event.name === PRIVACY_EVENT_NAMES.erasureFinished,
    );
    expect((finished?.payload as { cause: string }).cause).toBe("queue-resume");
  });

  it("stops scheduling once the operation completes", async () => {
    tools.eraseRejects = false;
    const retried = await retry();
    if (!retried.ok) throw new Error("unreachable");
    expect(retried.value.nextRetryAt).toBeNull();
  });

  it("schedules the next pass at a predictable backoff while it is still open", async () => {
    const before = context.clock.now();
    const retried = await retry();
    if (!retried.ok) throw new Error("unreachable");
    expect(retried.value.nextRetryAt).toEqual(
      new Date(before.getTime() + DEFAULT_PRIVACY_POLICY.retry.baseBackoffMs * 2),
    );
  });

  // The retry is where swallowing a failed progress write does its damage: the
  // pass has just re-run the destructive work, and a caller told `ok` over the
  // PRE-pass projection sees the record it already had — same retryCount, same
  // outcomes, same schedule — and has no reason to come back. The rows are gone
  // and the receipt says the erasure never advanced.
  it("REFUSES the retry when the progress write failed, rather than echoing the pre-pass record", async () => {
    tools.eraseRejects = false;
    context.repository.updateProgressFails = true;
    const retried = await retry();
    expect(retried.ok).toBe(false);
    if (retried.ok) throw new Error("unreachable");
    expect(retried.error.code).toBe("PRIVACY_OPERATION_STORE_UNAVAILABLE");
  });

  it("appends NO finished event for a pass whose row could not be written", async () => {
    tools.eraseRejects = false;
    context.outbox.appended.length = 0;
    context.repository.updateProgressFails = true;
    await retry();
    // The row and the audit trail are written in the same transaction precisely
    // so they cannot disagree; a finished event over an unwritten row would be
    // the disagreement.
    expect(context.outbox.names()).not.toContain(PRIVACY_EVENT_NAMES.erasureFinished);
    // The row is exactly as the FIRST pass left it: this retry advanced nothing.
    expect(context.repository.allOperations()[0]?.retryCount).toBe(1);
  });
});
