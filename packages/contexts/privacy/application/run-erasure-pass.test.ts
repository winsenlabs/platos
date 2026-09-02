import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_PRIVACY_POLICY, isTargetSettled } from "../domain/index.js";
import { planErasure, rejectionCode, totalPlannedRows } from "./plan-erasure.js";
import { runErasurePass } from "./run-erasure-pass.js";
import {
  InMemoryErasureTarget,
  TestTargetRejected,
  buildPrivacyTestContext,
  testEnvironmentSubject,
  type PrivacyTestContext,
} from "./testing/index.js";

const SUBJECT = testEnvironmentSubject("eu-1");
const OTHER_SCOPE = testEnvironmentSubject("eu-1", "env-2");

function seed(target: InMemoryErasureTarget, environmentId = "env-1", model = "TestRow"): void {
  target.seed({
    model,
    subjectKind: "end-user",
    subjectId: "eu-1",
    scopePath: `org/org-1/proj/proj-1/env/${environmentId}`,
  });
}

describe("planErasure", () => {
  let context: PrivacyTestContext;
  let files: InMemoryErasureTarget;

  beforeEach(() => {
    files = new InMemoryErasureTarget("files");
    context = buildPrivacyTestContext({ targets: [files] });
    seed(files);
  });

  it("plans once per subject, so a scope is never certified unasked", async () => {
    const planned = await planErasure(context.dependencies, [SUBJECT, OTHER_SCOPE]);
    expect(planned[0]?.plans).toHaveLength(2);
    expect(totalPlannedRows(planned)).toBe(1);
  });

  it("does not mutate anything", async () => {
    await planErasure(context.dependencies, [SUBJECT]);
    expect(files.remaining()).toHaveLength(1);
  });

  it("records a planner that threw as a failure rather than as an empty plan", async () => {
    files.planFails = true;
    const planned = await planErasure(context.dependencies, [SUBJECT]);
    expect(planned[0]?.failure).toBe("TEST_TARGET_PLAN_FAILED");
    expect(planned[0]?.plans).toEqual([]);
  });

  it("includes a REQUIRED target the composition root did not inject", async () => {
    const wired = buildPrivacyTestContext({
      targets: [files],
      policy: {
        ...DEFAULT_PRIVACY_POLICY,
        erasure: { requiredTargets: ["files", "tools"] },
      },
    });
    const planned = await planErasure(wired.dependencies, [SUBJECT]);
    expect(planned.map((entry) => entry.name)).toEqual(["files", "tools"]);
    expect(planned[1]?.target).toBeNull();
  });

  it("narrows to the targets a retry asked for", async () => {
    const two = buildPrivacyTestContext({
      targets: [files, new InMemoryErasureTarget("tools")],
    });
    const planned = await planErasure(two.dependencies, [SUBJECT], ["tools"]);
    expect(planned.map((entry) => entry.name)).toEqual(["tools"]);
  });

  it("orders the roster by name, so two passes produce identical outcome lists", async () => {
    const shuffled = buildPrivacyTestContext({
      targets: [new InMemoryErasureTarget("tools"), new InMemoryErasureTarget("files")],
    });
    const planned = await planErasure(shuffled.dependencies, [SUBJECT]);
    expect(planned.map((entry) => entry.name)).toEqual(["files", "tools"]);
  });
});

describe("rejectionCode", () => {
  it("reads the carried domain error's CODE, never its message", () => {
    expect(rejectionCode(new TestTargetRejected("FILES_BLOB_DESTRUCTION_FAILED"))).toBe(
      "FILES_BLOB_DESTRUCTION_FAILED",
    );
  });

  it("falls back to the error class for anything else", () => {
    expect(rejectionCode(new TypeError("boom"))).toBe("TypeError");
    expect(rejectionCode("boom")).toBe("Error");
  });
});

describe("runErasurePass", () => {
  let context: PrivacyTestContext;
  let files: InMemoryErasureTarget;
  let tools: InMemoryErasureTarget;

  beforeEach(() => {
    files = new InMemoryErasureTarget("files");
    tools = new InMemoryErasureTarget("tools");
    context = buildPrivacyTestContext({ targets: [files, tools] });
    seed(files);
    seed(tools);
  });

  it("erases every target and verifies each with a post-delete probe", async () => {
    const pass = await runErasurePass(context.dependencies, { subjects: [SUBJECT] });
    expect(pass.rolledBack).toBe(false);
    expect(pass.outcomes.map((outcome) => outcome.verification)).toEqual(["passed", "passed"]);
    expect(files.remaining()).toHaveLength(0);
    expect(tools.remaining()).toHaveLength(0);
  });

  it("CATCHES a target that reports a receipt and deletes nothing", async () => {
    // The receipt is indistinguishable from a real one. Only the probe is not.
    tools.eraseSilently = true;
    const pass = await runErasurePass(context.dependencies, { subjects: [SUBJECT] });
    const outcome = pass.outcomes.find((entry) => entry.target === "tools");
    expect(outcome?.verification).toBe("failed");
    expect(isTargetSettled(outcome!)).toBe(false);
  });

  it("records a target that destroyed but could not prove it as UNKNOWN", async () => {
    tools.reprobeFails = true;
    const pass = await runErasurePass(context.dependencies, { subjects: [SUBJECT] });
    expect(pass.outcomes.find((entry) => entry.target === "tools")?.verification).toBe("unknown");
  });

  it("RUNS every target even after one rejects", async () => {
    files.eraseRejects = true;
    await runErasurePass(context.dependencies, { subjects: [SUBJECT] });
    // A crash in one target that stopped the rest from running would leave far
    // more personal data in place than it protected.
    expect(tools.calls.some((call) => call.startsWith("erase:"))).toBe(true);
  });

  it("ROLLS THE WHOLE PASS BACK when any target rejects", async () => {
    files.eraseRejects = true;
    const pass = await runErasurePass(context.dependencies, { subjects: [SUBJECT] });
    expect(pass.rolledBack).toBe(true);
    expect(context.unitOfWork.rolledBack).toHaveLength(1);
    // The rows the other target "deleted" are back, because it could not commit.
    expect(tools.remaining()).toHaveLength(1);
  });

  it("lets NO target claim a pass whose transaction was discarded", async () => {
    files.eraseRejects = true;
    const pass = await runErasurePass(context.dependencies, { subjects: [SUBJECT] });
    const survivor = pass.outcomes.find((entry) => entry.target === "tools");
    expect(survivor?.verification).toBe("unknown");
    expect(survivor?.note).toContain("rolled back");
    expect(pass.outcomes.some(isTargetSettled)).toBe(false);
  });

  it("records the rejecting target's CODE, never its message", async () => {
    files.eraseRejects = true;
    const pass = await runErasurePass(context.dependencies, { subjects: [SUBJECT] });
    const rejected = pass.outcomes.find((entry) => entry.target === "files");
    expect(rejected?.note).toBe("target rejected (TEST_TARGET_ERASE_REFUSED)");
    expect(rejected?.failures).toBe(1);
  });

  it("does not erase through a target whose PLAN failed", async () => {
    files.planFails = true;
    const pass = await runErasurePass(context.dependencies, { subjects: [SUBJECT] });
    expect(files.calls.some((call) => call.startsWith("erase:"))).toBe(false);
    expect(pass.rolledBack).toBe(true);
  });

  it("marks a required-but-unwired target FAILED rather than letting it read clean", async () => {
    const wired = buildPrivacyTestContext({
      targets: [files],
      policy: { ...DEFAULT_PRIVACY_POLICY, erasure: { requiredTargets: ["files", "memory"] } },
    });
    const pass = await runErasurePass(wired.dependencies, { subjects: [SUBJECT] });
    const missing = pass.outcomes.find((entry) => entry.target === "memory");
    expect(missing?.status).toBe("failed");
    expect(missing?.note).toBe("no target wired for this context");
    expect(isTargetSettled(missing!)).toBe(false);
  });

  it("settles a target that owns no model as NOT_PROVISIONED, never as verified", async () => {
    const empty = new InMemoryErasureTarget("observability", []);
    const wired = buildPrivacyTestContext({ targets: [empty] });
    const pass = await runErasurePass(wired.dependencies, { subjects: [SUBJECT] });
    expect(pass.outcomes[0]?.status).toBe("not_provisioned");
    expect(pass.outcomes[0]?.verification).toBe("not_applicable");
    expect(isTargetSettled(pass.outcomes[0]!)).toBe(true);
  });

  it("folds every scope into one outcome per target", async () => {
    seed(files, "env-2");
    const pass = await runErasurePass(context.dependencies, { subjects: [SUBJECT, OTHER_SCOPE] });
    const outcome = pass.outcomes.find((entry) => entry.target === "files");
    expect(outcome?.discovered).toBe(2);
    expect(outcome?.counts.deleted).toBe(2);
  });

  it("refuses to pass a target that cleaned one scope and failed another", async () => {
    seed(files, "env-2");
    const partial = new InMemoryErasureTarget("files");
    partial.seed({ model: "TestRow", subjectKind: "end-user", subjectId: "eu-1", scopePath: "org/org-1/proj/proj-1/env/env-1" });
    partial.eraseSilently = true;
    const wired = buildPrivacyTestContext({ targets: [partial] });
    const pass = await runErasurePass(wired.dependencies, { subjects: [SUBJECT, OTHER_SCOPE] });
    expect(pass.outcomes[0]?.verification).toBe("failed");
  });

  it("runs only the narrowed roster on a retry", async () => {
    const pass = await runErasurePass(context.dependencies, { subjects: [SUBJECT], only: ["tools"] });
    expect(pass.outcomes.map((entry) => entry.target)).toEqual(["tools"]);
    expect(files.remaining()).toHaveLength(1);
  });

  it("does not throw when a target crashes; a crash with no record is worse", async () => {
    files.eraseRejects = true;
    await expect(runErasurePass(context.dependencies, { subjects: [SUBJECT] })).resolves.toBeDefined();
  });
});
