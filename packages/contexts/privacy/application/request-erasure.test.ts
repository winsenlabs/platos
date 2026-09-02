import { asIdentifier, type Result } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { subjectAlias, type IdempotencyKey } from "../domain/index.js";
import { PRIVACY_EVENT_NAMES } from "../contracts/events.js";
import { assertSubjectNotErased } from "./guard-subject-write.js";
import { requestErasure } from "./request-erasure.js";
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

function command(overrides: Partial<Parameters<typeof requestErasure>[1]> = {}) {
  return {
    organizationId: TEST_ORGANIZATION,
    externalUserId: EXTERNAL_ID,
    idempotencyKey: KEY,
    ...overrides,
  };
}

function arrange(context: PrivacyTestContext, target: InMemoryErasureTarget): void {
  context.directory.register(EXTERNAL_ID, {
    subjects: [SUBJECT],
    aliases: testAliases(EXTERNAL_ID, "eu-1"),
  });
  target.seed({
    model: "TestRow",
    subjectKind: "end-user",
    subjectId: "eu-1",
    scopePath: "org/org-1/proj/proj-1/env/env-1",
  });
}

describe("requestErasure", () => {
  let context: PrivacyTestContext;
  let files: InMemoryErasureTarget;

  beforeEach(() => {
    files = new InMemoryErasureTarget("files");
    context = buildPrivacyTestContext({ targets: [files] });
    arrange(context, files);
  });

  it("destroys the subject's rows and completes with proof", async () => {
    const requested = await requestErasure(context.dependencies, command());
    expect(requested.ok).toBe(true);
    if (!requested.ok) throw new Error("unreachable");
    expect(requested.value.status).toBe("completed");
    expect(requested.value.outcomes[0]?.verification).toBe("passed");
    expect(files.remaining()).toHaveLength(0);
  });

  it("leaves the subject sealed once the erasure is done", async () => {
    await requestErasure(context.dependencies, command());
    const refused = await assertSubjectNotErased(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      aliases: [subjectAlias("email", `${EXTERNAL_ID}@example.com`)],
    });
    expect(refused.ok).toBe(false);
  });

  it("REFUSES A WRITE THAT LANDS MID-SWEEP, which is what sealing first buys", async () => {
    // Observed from inside a target's `erase`, because that is the only instant
    // at which the ordering is visible: seal-first and seal-last both end with
    // the subject sealed, and only a write arriving WHILE a target is working
    // can tell them apart. A turn landing here under the wrong ordering writes
    // rows the later targets have already scanned past.
    const midSweep: Result<void>[] = [];
    files.duringErase = async () => {
      midSweep.push(
        await assertSubjectNotErased(context.dependencies, {
          organizationId: TEST_ORGANIZATION,
          aliases: [subjectAlias("external", EXTERNAL_ID)],
        }),
      );
    };

    await requestErasure(context.dependencies, command());

    expect(midSweep).toHaveLength(1);
    expect(midSweep[0]?.ok).toBe(false);
  });

  it("refuses a mid-sweep write under an ALIAS the request did not name", async () => {
    const midSweep: Result<void>[] = [];
    files.duringErase = async () => {
      midSweep.push(
        await assertSubjectNotErased(context.dependencies, {
          organizationId: TEST_ORGANIZATION,
          aliases: [subjectAlias("email", `${EXTERNAL_ID}@example.com`)],
        }),
      );
    };

    await requestErasure(context.dependencies, command());

    expect(midSweep[0]?.ok).toBe(false);
  });

  it("leaves the subject sealed even when the destruction rolled back", async () => {
    files.eraseRejects = true;
    const requested = await requestErasure(context.dependencies, command());
    if (!requested.ok) throw new Error("unreachable");
    expect(requested.value.status).toBe("partial_failure");
    // Refusing writes for someone whose erasure is half-finished is the
    // direction that cannot produce an unrecoverable outcome.
    const refused = await assertSubjectNotErased(context.dependencies, {
      organizationId: TEST_ORGANIZATION,
      aliases: [subjectAlias("external", EXTERNAL_ID)],
    });
    expect(refused.ok).toBe(false);
  });

  it("appends INTENT before the outcome, in that order", async () => {
    await requestErasure(context.dependencies, command());
    expect(context.outbox.names()).toEqual([
      PRIVACY_EVENT_NAMES.erasureRequested,
      PRIVACY_EVENT_NAMES.erasureFinished,
    ]);
  });

  it("records neither the requested handle nor any alias in anything durable", async () => {
    await requestErasure(context.dependencies, command());
    const durable = JSON.stringify({
      operations: context.repository.allOperations(),
      tombstones: context.repository.allTombstones(),
      events: context.outbox.appended,
    });
    for (const handle of [EXTERNAL_ID, `${EXTERNAL_ID}@example.com`, "eu-1"]) {
      expect(durable).not.toContain(handle);
    }
  });

  it("is idempotent: a repeat returns the first answer without destroying again", async () => {
    const first = await requestErasure(context.dependencies, command());
    const before = context.outbox.appended.length;
    const second = await requestErasure(context.dependencies, command());
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(second.value.operationId).toBe(first.value.operationId);
    expect(second.value.retryCount).toBe(first.value.retryCount);
    expect(context.outbox.appended).toHaveLength(before);
    expect(context.repository.allOperations()).toHaveLength(1);
  });

  it("REFUSES a key already bound to another subject, and records the refusal", async () => {
    await requestErasure(context.dependencies, command());
    context.directory.register("someone-else", {
      subjects: [testEnvironmentSubject("eu-2")],
      aliases: testAliases("someone-else", "eu-2"),
    });
    const conflicted = await requestErasure(
      context.dependencies,
      command({ externalUserId: "someone-else" }),
    );
    expect(conflicted.ok).toBe(false);
    if (conflicted.ok) throw new Error("unreachable");
    expect(conflicted.error.code).toBe("PRIVACY_IDEMPOTENCY_KEY_CONFLICT");
    expect(context.outbox.names()).toContain(PRIVACY_EVENT_NAMES.erasureRefused);
  });

  it("BLOCKS a held subject before anything is destroyed", async () => {
    context.holds.set(TEST_ORGANIZATION, ["ops@example.com", `${EXTERNAL_ID}@example.com`]);
    const held = await requestErasure(context.dependencies, command());
    if (!held.ok) throw new Error("unreachable");
    expect(held.value.status).toBe("blocked_legal_hold");
    expect(files.remaining()).toHaveLength(1);
    expect(context.repository.allTombstones()).toHaveLength(0);
  });

  it("matches a hold registered under an ALIAS the request did not name", async () => {
    context.holds.set(TEST_ORGANIZATION, [`${EXTERNAL_ID}@example.com`]);
    const held = await requestErasure(context.dependencies, command());
    if (!held.ok) throw new Error("unreachable");
    expect(held.value.status).toBe("blocked_legal_hold");
  });

  it("names the hold by register POSITION and digest, never by its entry", async () => {
    context.holds.set(TEST_ORGANIZATION, ["ops@example.com", `${EXTERNAL_ID}@example.com`]);
    const held = await requestErasure(context.dependencies, command());
    if (!held.ok) throw new Error("unreachable");
    expect(held.value.legalHoldPolicyId).toMatch(/^legal-hold-register#2:/u);
    expect(held.value.legalHoldPolicyId).not.toContain(EXTERNAL_ID);
  });

  it("honours a caller-supplied hold even when the register knows nothing", async () => {
    const held = await requestErasure(
      context.dependencies,
      command({ legalHoldPolicyId: "caller-hold-1" }),
    );
    if (!held.ok) throw new Error("unreachable");
    expect(held.value.status).toBe("blocked_legal_hold");
  });

  it("does NOT let a caller without a hold id erase a subject the register protects", async () => {
    context.holds.set(TEST_ORGANIZATION, [EXTERNAL_ID]);
    const held = await requestErasure(context.dependencies, command());
    if (!held.ok) throw new Error("unreachable");
    expect(held.value.status).toBe("blocked_legal_hold");
  });

  it("REFUSES to run when the hold register cannot be read", async () => {
    context.holds.fails = true;
    const failed = await requestErasure(context.dependencies, command());
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error("unreachable");
    expect(failed.error.code).toBe("PRIVACY_LEGAL_HOLD_REGISTER_UNAVAILABLE");
    expect(files.remaining()).toHaveLength(1);
  });

  it("refuses to run when the subject directory cannot be read", async () => {
    context.directory.fails = true;
    const failed = await requestErasure(context.dependencies, command());
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error("unreachable");
    expect(failed.error.code).toBe("PRIVACY_SUBJECT_DIRECTORY_UNAVAILABLE");
  });

  it("does not certify an empty sweep when discovery resolved nobody", async () => {
    const unknown = await requestErasure(
      context.dependencies,
      command({ externalUserId: "never-seen" }),
    );
    if (!unknown.ok) throw new Error("unreachable");
    expect(unknown.value.status).toBe("verification_failed");
    expect(unknown.value.outcomes).toEqual([]);
    expect(files.remaining()).toHaveLength(1);
  });

  it("still leaves a row for an unresolved subject, because the request happened", async () => {
    await requestErasure(context.dependencies, command({ externalUserId: "never-seen" }));
    expect(context.repository.allOperations()).toHaveLength(1);
    expect(context.outbox.names()).toEqual([PRIVACY_EVENT_NAMES.erasureRefused]);
  });

  it("opens the row leased and already due, so a crash does not strand it", async () => {
    files.eraseRejects = true;
    await requestErasure(context.dependencies, command());
    const row = context.repository.allOperations()[0];
    expect(row?.nextRetryAt).not.toBeNull();
    // The lease is released once the pass ends, whatever the outcome.
    expect(row?.leaseToken).toBeNull();
  });

  it("stamps the policy version on the operation and its tombstones", async () => {
    await requestErasure(context.dependencies, command());
    const version = context.dependencies.policy.version;
    expect(context.repository.allOperations()[0]?.policyVersion).toBe(version);
    expect(context.repository.allTombstones().every((row) => row.policyVersion === version)).toBe(true);
  });

  it("records the scopes the subject occupies, de-duplicated", async () => {
    context.directory.register(EXTERNAL_ID, {
      subjects: [SUBJECT, SUBJECT, testEnvironmentSubject("eu-1", "env-2")],
      aliases: testAliases(EXTERNAL_ID, "eu-1"),
    });
    const requested = await requestErasure(context.dependencies, command());
    if (!requested.ok) throw new Error("unreachable");
    expect(requested.value.scopes).toHaveLength(2);
  });
});
