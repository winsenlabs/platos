import { beforeEach, describe, expect, it } from "vitest";

import { PRIVACY_EVENT_NAMES } from "../contracts/events.js";
import { inventorySubject } from "./inventory-subject.js";
import {
  InMemoryErasureTarget,
  TEST_ORGANIZATION,
  buildPrivacyTestContext,
  testAliases,
  testEnvironmentSubject,
  type PrivacyTestContext,
} from "./testing/index.js";

const EXTERNAL_ID = "walle-1";
const SUBJECT = testEnvironmentSubject("eu-1");

describe("inventorySubject", () => {
  let context: PrivacyTestContext;
  let files: InMemoryErasureTarget;
  let tools: InMemoryErasureTarget;

  beforeEach(() => {
    files = new InMemoryErasureTarget("files");
    tools = new InMemoryErasureTarget("tools");
    context = buildPrivacyTestContext({ targets: [files, tools] });
    context.directory.register(EXTERNAL_ID, {
      subjects: [SUBJECT],
      aliases: testAliases(EXTERNAL_ID, "eu-1"),
    });
    for (const count of [0, 1]) {
      files.seed({
        model: "TestRow",
        subjectKind: "end-user",
        subjectId: "eu-1",
        scopePath: `org/org-1/proj/proj-1/env/env-${count === 0 ? "1" : "1"}`,
      });
    }
  });

  function inventory(externalUserId = EXTERNAL_ID) {
    return inventorySubject(context.dependencies, { organizationId: TEST_ORGANIZATION, externalUserId });
  }

  it("reports what each target holds, per target", async () => {
    const taken = await inventory();
    if (!taken.ok) throw new Error("unreachable");
    expect(taken.value.planned).toEqual([
      { target: "files", rowCount: 2 },
      { target: "tools", rowCount: 0 },
    ]);
    expect(taken.value.discovered).toBe(2);
  });

  it("DOES NOT MUTATE — the rows it counted are all still there", async () => {
    await inventory();
    expect(files.remaining()).toHaveLength(2);
    expect(files.calls.every((call) => call.startsWith("plan:"))).toBe(true);
  });

  it("leaves a record that somebody enumerated this person", async () => {
    await inventory();
    expect(context.outbox.names()).toEqual([PRIVACY_EVENT_NAMES.subjectInventoried]);
  });

  it("records the digest and the counts, never the handle", async () => {
    await inventory();
    const serialized = JSON.stringify(context.outbox.appended);
    expect(serialized).not.toContain(EXTERNAL_ID);
    expect(serialized).toContain("erasure-evidence");
  });

  it("returns the digest rather than the subject it describes", async () => {
    const taken = await inventory();
    if (!taken.ok) throw new Error("unreachable");
    expect(taken.value.subjectKeyHash).not.toContain(EXTERNAL_ID);
    expect(taken.value.resolvedSubjects).toBe(1);
  });

  it("FAILS for an unresolved subject rather than reporting an empty footprint", async () => {
    const missing = await inventory("never-seen");
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("unreachable");
    // An empty inventory is indistinguishable from "this person has no data".
    expect(missing.error.code).toBe("PRIVACY_SUBJECT_NOT_RESOLVED");
    expect(context.outbox.appended).toHaveLength(0);
  });

  it("REPORTS a hold without enforcing one, because nothing is being destroyed", async () => {
    context.holds.set(TEST_ORGANIZATION, [`${EXTERNAL_ID}@example.com`]);
    const taken = await inventory();
    if (!taken.ok) throw new Error("unreachable");
    expect(taken.value.legalHoldPolicyId).toMatch(/^legal-hold-register#1:/u);
    expect(taken.value.discovered).toBe(2);
  });

  it("fails when the directory cannot answer", async () => {
    context.directory.fails = true;
    const failed = await inventory();
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error("unreachable");
    expect(failed.error.code).toBe("PRIVACY_SUBJECT_DIRECTORY_UNAVAILABLE");
  });

  it("reports every scope the subject occupies", async () => {
    context.directory.register(EXTERNAL_ID, {
      subjects: [SUBJECT, testEnvironmentSubject("eu-1", "env-2")],
      aliases: testAliases(EXTERNAL_ID, "eu-1"),
    });
    const taken = await inventory();
    if (!taken.ok) throw new Error("unreachable");
    expect(taken.value.scopes).toHaveLength(2);
    expect(taken.value.resolvedSubjects).toBe(2);
  });
});
