import { asIdentifier } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { subjectAlias, type AliasHash, type ErasureOperationId, type ErasureTombstoneId } from "../domain/index.js";
import { assertSubjectNotErased } from "./guard-subject-write.js";
import { purgeExpiredTombstones, sealSubject } from "./seal-subject.js";
import { buildPrivacyTestContext, TEST_ORGANIZATION, type PrivacyTestContext } from "./testing/index.js";

const FIRST = asIdentifier<ErasureOperationId>("op-1");
const SECOND = asIdentifier<ErasureOperationId>("op-2");
const ALIASES = [subjectAlias("external", "walle-1")];

describe("sealSubject", () => {
  let context: PrivacyTestContext;

  beforeEach(() => {
    context = buildPrivacyTestContext();
  });

  it("does nothing, successfully, for an alias set that normalizes away", async () => {
    const sealed = await sealSubject(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      operationId: FIRST,
      aliases: [subjectAlias("", ""), subjectAlias("email", "  ")],
    });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error("unreachable");
    expect(sealed.value).toEqual({ aliases: 0, sealed: 0, extended: 0, purged: 0 });
    expect(context.repository.allTombstones()).toHaveLength(0);
  });

  it("EXTENDS on a re-seal rather than inserting a second row", async () => {
    await sealSubject(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      operationId: FIRST,
      aliases: ALIASES,
    });
    context.clock.advanceDays(1);
    const again = await sealSubject(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      operationId: SECOND,
      aliases: ALIASES,
    });
    if (!again.ok) throw new Error("unreachable");
    expect(again.value).toMatchObject({ sealed: 0, extended: 1 });
    expect(context.repository.allTombstones()).toHaveLength(1);
  });

  it("pushes the expiry out, so a retry's barrier covers the whole of the retry", async () => {
    await sealSubject(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      operationId: FIRST,
      aliases: ALIASES,
    });
    const first = context.repository.allTombstones()[0]?.expiresAt;
    context.clock.advanceDays(5);
    await sealSubject(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      operationId: SECOND,
      aliases: ALIASES,
    });
    const second = context.repository.allTombstones()[0]?.expiresAt;
    expect(second?.getTime()).toBeGreaterThan(first?.getTime() ?? 0);
  });

  it("re-points the row at the operation that last sealed it", async () => {
    await sealSubject(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      operationId: FIRST,
      aliases: ALIASES,
    });
    await sealSubject(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      operationId: SECOND,
      aliases: ALIASES,
    });
    expect(context.repository.allTombstones()[0]?.operationId).toBe(SECOND);
  });

  it("purges elapsed rows opportunistically, without touching live ones", async () => {
    await sealSubject(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      operationId: FIRST,
      aliases: [subjectAlias("external", "old-1")],
    });
    context.clock.advanceDays(31);
    const sealed = await sealSubject(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      operationId: SECOND,
      aliases: [subjectAlias("external", "new-1")],
    });
    if (!sealed.ok) throw new Error("unreachable");
    expect(sealed.value.purged).toBe(1);
    expect(context.repository.allTombstones().map((row) => row.operationId)).toEqual([SECOND]);
  });

  it("commits the seal in its own transaction, so a later rollback cannot open it", async () => {
    await sealSubject(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      operationId: FIRST,
      aliases: ALIASES,
    });
    expect(context.unitOfWork.committed).toHaveLength(1);
    expect(context.unitOfWork.rolledBack).toHaveLength(0);
  });

  it("stamps the policy version in force when the subject was sealed", async () => {
    await sealSubject(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      operationId: FIRST,
      aliases: ALIASES,
    });
    expect(context.repository.allTombstones()[0]?.policyVersion).toBe(context.dependencies.policy.version);
  });
});

describe("purgeExpiredTombstones", () => {
  it("is never load-bearing: the barrier already ignores what it would remove", async () => {
    const context = buildPrivacyTestContext();
    await sealSubject(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      operationId: FIRST,
      aliases: ALIASES,
    });
    context.clock.advanceDays(31);

    const beforePurge = await assertSubjectNotErased(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      aliases: ALIASES,
    });
    const purged = await purgeExpiredTombstones(context.dependencies);
    const afterPurge = await assertSubjectNotErased(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      aliases: ALIASES,
    });

    expect(beforePurge.ok).toBe(true);
    expect(afterPurge.ok).toBe(true);
    if (!purged.ok) throw new Error("unreachable");
    expect(purged.value).toBe(1);
  });

  it("leaves a live tombstone alone", async () => {
    const context = buildPrivacyTestContext();
    context.repository.seedTombstone({
      tombstoneId: asIdentifier<ErasureTombstoneId>("t-live"),
      organizationId: TEST_ORGANIZATION,
      aliasHash: asIdentifier<AliasHash>("h-live"),
      operationId: FIRST,
      policyVersion: "v",
      sealedAt: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    });
    const purged = await purgeExpiredTombstones(context.dependencies);
    if (!purged.ok) throw new Error("unreachable");
    expect(purged.value).toBe(0);
    expect(context.repository.allTombstones()).toHaveLength(1);
  });
});
