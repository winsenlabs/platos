// The published surface, exercised the way a composition root will use it.
//
// Everything below goes through `createPrivacyContract` rather than a use-case
// module, because the contract is the only thing another context or
// `apps/core-api` may import — a rule proved against an internal entrypoint is
// not proved on the surface that ships.

import { asIdentifier } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { createPrivacyContract } from "../application/privacy-contract.js";
import {
  InMemoryErasureTarget,
  TEST_ORGANIZATION,
  buildPrivacyTestContext,
  testAliases,
  testEnvironmentSubject,
  type PrivacyTestContext,
} from "../application/testing/index.js";
import { CANONICAL_ALIAS_CHANNEL, isLegalHoldReference, type IdempotencyKey, type PrivacyContract } from "./index.js";
import { subjectAlias } from "../domain/alias.js";

const EXTERNAL_ID = "walle-1";
const KEY = asIdentifier<IdempotencyKey>("key-1");
const SUBJECT = testEnvironmentSubject("eu-1");

describe("the privacy contract", () => {
  let context: PrivacyTestContext;
  let files: InMemoryErasureTarget;
  let privacy: PrivacyContract;

  beforeEach(() => {
    files = new InMemoryErasureTarget("files");
    context = buildPrivacyTestContext({ targets: [files] });
    context.directory.register(EXTERNAL_ID, {
      subjects: [SUBJECT],
      aliases: testAliases(EXTERNAL_ID, "eu-1"),
    });
    files.seed({
      model: "MessageAttachment",
      subjectKind: "end-user",
      subjectId: "eu-1",
      scopePath: "org/org-1/proj/proj-1/env/env-1",
    });
    privacy = createPrivacyContract(context.dependencies);
  });

  it("names itself, so a composition root can key its registry on the contract", () => {
    expect(privacy.name).toBe("privacy");
  });

  it("carries a request through to a completed, verified receipt", async () => {
    const requested = await privacy.requestErasure({
      organizationId: TEST_ORGANIZATION,
      externalUserId: EXTERNAL_ID,
      idempotencyKey: KEY,
    });
    if (!requested.ok) throw new Error("unreachable");
    expect(requested.value.status).toBe("completed");
    expect(requested.value.outcomes).toEqual([
      {
        target: "files",
        status: "done",
        verification: "passed",
        discovered: 1,
        deleted: 1,
        anonymized: 0,
        cryptoShredded: 0,
        retained: 0,
        failures: 0,
        note: null,
      },
    ]);
  });

  it("does NOT publish the lease, which would let a caller take one it did not earn", async () => {
    const requested = await privacy.requestErasure({
      organizationId: TEST_ORGANIZATION,
      externalUserId: EXTERNAL_ID,
      idempotencyKey: KEY,
    });
    if (!requested.ok) throw new Error("unreachable");
    expect("leaseToken" in requested.value).toBe(false);
    expect("leaseExpiresAt" in requested.value).toBe(false);
  });

  it("reads a receipt back by id, in the same shape", async () => {
    const requested = await privacy.requestErasure({
      organizationId: TEST_ORGANIZATION,
      externalUserId: EXTERNAL_ID,
      idempotencyKey: KEY,
    });
    if (!requested.ok) throw new Error("unreachable");
    const described = await privacy.describeOperation({
      organizationId: TEST_ORGANIZATION,
      operationId: requested.value.operationId,
    });
    if (!described.ok) throw new Error("unreachable");
    expect(described.value).toEqual(requested.value);
  });

  it("does not describe an operation belonging to another organization", async () => {
    const requested = await privacy.requestErasure({
      organizationId: TEST_ORGANIZATION,
      externalUserId: EXTERNAL_ID,
      idempotencyKey: KEY,
    });
    if (!requested.ok) throw new Error("unreachable");
    const denied = await privacy.describeOperation({
      organizationId: asIdentifier("org-2"),
      operationId: requested.value.operationId,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PRIVACY_OPERATION_NOT_FOUND");
  });

  it("exposes the write barrier the identity chokepoints call", async () => {
    await privacy.requestErasure({
      organizationId: TEST_ORGANIZATION,
      externalUserId: EXTERNAL_ID,
      idempotencyKey: KEY,
    });
    const refused = await privacy.assertSubjectNotErased({
      organizationId: TEST_ORGANIZATION,
      aliases: [{ channel: CANONICAL_ALIAS_CHANNEL, subject: "eu-1" }],
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error.code).toBe("PRIVACY_SUBJECT_ERASED");
  });

  it("exposes the batch barrier a drain needs, returning digests only", async () => {
    await privacy.requestErasure({
      organizationId: TEST_ORGANIZATION,
      externalUserId: EXTERNAL_ID,
      idempotencyKey: KEY,
    });
    const erased = await privacy.erasedAliases({
      organizationId: TEST_ORGANIZATION,
      aliases: [subjectAlias("external", EXTERNAL_ID), subjectAlias("external", "someone-else")],
    });
    if (!erased.ok) throw new Error("unreachable");
    expect(erased.value).toHaveLength(1);
    expect(erased.value.join("|")).not.toContain(EXTERNAL_ID);
  });

  it("publishes a hold as a reference, recognizable as such", async () => {
    context.holds.set(TEST_ORGANIZATION, [EXTERNAL_ID]);
    const held = await privacy.requestErasure({
      organizationId: TEST_ORGANIZATION,
      externalUserId: EXTERNAL_ID,
      idempotencyKey: KEY,
    });
    if (!held.ok) throw new Error("unreachable");
    expect(held.value.legalHoldPolicyId).not.toBeNull();
    expect(isLegalHoldReference(held.value.legalHoldPolicyId ?? "")).toBe(true);
  });

  it("inventories a subject without destroying anything", async () => {
    const taken = await privacy.inventorySubject({
      organizationId: TEST_ORGANIZATION,
      externalUserId: EXTERNAL_ID,
    });
    if (!taken.ok) throw new Error("unreachable");
    expect(taken.value.discovered).toBe(1);
    expect(files.remaining()).toHaveLength(1);
  });

  it("retries through the contract and completes", async () => {
    files.eraseRejects = true;
    const requested = await privacy.requestErasure({
      organizationId: TEST_ORGANIZATION,
      externalUserId: EXTERNAL_ID,
      idempotencyKey: KEY,
    });
    if (!requested.ok) throw new Error("unreachable");
    expect(requested.value.status).toBe("partial_failure");

    files.eraseRejects = false;
    const retried = await privacy.retryErasure({
      organizationId: TEST_ORGANIZATION,
      operationId: requested.value.operationId,
      externalUserId: EXTERNAL_ID,
    });
    if (!retried.ok) throw new Error("unreachable");
    expect(retried.value.status).toBe("completed");
  });

  it("purges elapsed tombstones on demand", async () => {
    await privacy.requestErasure({
      organizationId: TEST_ORGANIZATION,
      externalUserId: EXTERNAL_ID,
      idempotencyKey: KEY,
    });
    context.clock.advanceDays(31);
    const purged = await privacy.purgeExpiredTombstones({ organizationId: TEST_ORGANIZATION });
    if (!purged.ok) throw new Error("unreachable");
    expect(purged.value).toBeGreaterThan(0);
  });

  it("returns a `Result` on every failure rather than throwing", async () => {
    context.directory.fails = true;
    const outcomes = await Promise.all([
      privacy.requestErasure({ organizationId: TEST_ORGANIZATION, externalUserId: EXTERNAL_ID, idempotencyKey: KEY }),
      privacy.inventorySubject({ organizationId: TEST_ORGANIZATION, externalUserId: EXTERNAL_ID }),
      privacy.describeOperation({ organizationId: TEST_ORGANIZATION, operationId: asIdentifier("nope") }),
    ]);
    expect(outcomes.every((outcome) => outcome.ok === false)).toBe(true);
  });
});
