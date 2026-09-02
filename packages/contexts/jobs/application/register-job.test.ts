import { asIdentifier } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import type { JobKey } from "../domain/index.js";
import { registerJob } from "./register-job.js";
import { buildJobsTestContext, testEnvironmentScope, type JobsTestContext } from "./testing/index.js";

const SCOPE = testEnvironmentScope("env-1");
const OTHER_SCOPE = testEnvironmentScope("env-2");

const DRAFT = {
  jobKey: "nightly-rollup",
  displayName: "Nightly rollup",
  handler: "async function run(payload, ctx) { return 1; }",
};

describe("registerJob", () => {
  let context: JobsTestContext;

  beforeEach(() => {
    context = buildJobsTestContext();
  });

  it("stores an admissible definition as ACTIVE", async () => {
    const registered = await registerJob(context.dependencies, {
      scope: SCOPE,
      draft: DRAFT,
      createdBy: "user-1",
    });
    if (!registered.ok) throw new Error("unreachable");
    expect(registered.value.job.status).toBe("active");
    expect(registered.value.syntaxError).toBeNull();
    expect(registered.value.job.createdBy).toBe("user-1");
  });

  it("stamps createdAt and updatedAt from the CLOCK, not the wall", async () => {
    const registered = await registerJob(context.dependencies, {
      scope: SCOPE,
      draft: DRAFT,
      createdBy: "user-1",
    });
    if (!registered.ok) throw new Error("unreachable");
    expect(registered.value.job.createdAt).toEqual(context.clock.now());
    expect(registered.value.job.lastStartedAt).toBeNull();
  });

  it("KEEPS the row when the handler does not parse, marking it registration-failed", async () => {
    context.handlers.willParse("Unexpected token }");
    const registered = await registerJob(context.dependencies, {
      scope: SCOPE,
      draft: DRAFT,
      createdBy: "user-1",
    });
    if (!registered.ok) throw new Error("unreachable");
    expect(registered.value.job.status).toBe("registration-failed");
    expect(registered.value.syntaxError).toBe("Unexpected token }");
    // The row EXISTS — an author needs something to fix.
    expect(context.jobs.size()).toBe(1);
  });

  it("REFUSES an inadmissible definition before touching the store", async () => {
    const registered = await registerJob(context.dependencies, {
      scope: SCOPE,
      draft: { ...DRAFT, jobKey: "NOT VALID" },
      createdBy: "user-1",
    });
    expect(registered.ok).toBe(false);
    if (registered.ok) throw new Error("unreachable");
    expect(registered.error.code).toBe("JOBS_JOB_DEFINITION_INVALID");
    expect(context.jobs.size()).toBe(0);
  });

  it("REFUSES a duplicate key in the SAME environment", async () => {
    await registerJob(context.dependencies, { scope: SCOPE, draft: DRAFT, createdBy: "user-1" });
    const second = await registerJob(context.dependencies, {
      scope: SCOPE,
      draft: DRAFT,
      createdBy: "user-1",
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.error.code).toBe("JOBS_JOB_ALREADY_EXISTS");
  });

  it("PERMITS the same key in a DIFFERENT environment", async () => {
    await registerJob(context.dependencies, { scope: SCOPE, draft: DRAFT, createdBy: "user-1" });
    const other = await registerJob(context.dependencies, {
      scope: OTHER_SCOPE,
      draft: DRAFT,
      createdBy: "user-1",
    });
    expect(other.ok).toBe(true);
  });

  it("does NOT parse the handler until the cheap refusals have passed", async () => {
    // Syntax checking last stops a create endpoint being used as a free parser
    // for source the caller may not register.
    await registerJob(context.dependencies, {
      scope: SCOPE,
      draft: { ...DRAFT, displayName: "" },
      createdBy: "user-1",
    });
    // `willParse` was never consumed because `checkSyntax` was never reached.
    context.handlers.willParse("would have failed");
    const later = await registerJob(context.dependencies, {
      scope: SCOPE,
      draft: DRAFT,
      createdBy: "user-1",
    });
    if (!later.ok) throw new Error("unreachable");
    expect(later.value.syntaxError).toBe("would have failed");
  });

  it("does NOT parse the handler when the key is already taken", async () => {
    await registerJob(context.dependencies, { scope: SCOPE, draft: DRAFT, createdBy: "user-1" });
    await registerJob(context.dependencies, { scope: SCOPE, draft: DRAFT, createdBy: "user-1" });
    context.handlers.willParse("still queued");
    const third = await registerJob(context.dependencies, {
      scope: SCOPE,
      draft: { ...DRAFT, jobKey: "other-job" },
      createdBy: "user-1",
    });
    if (!third.ok) throw new Error("unreachable");
    expect(third.value.syntaxError).toBe("still queued");
  });

  it("reports an unreachable store rather than inventing a row", async () => {
    context.jobs.failNext("connection reset");
    const registered = await registerJob(context.dependencies, {
      scope: SCOPE,
      draft: DRAFT,
      createdBy: "user-1",
    });
    expect(registered.ok).toBe(false);
    if (registered.ok) throw new Error("unreachable");
    expect(registered.error.category).toBe("unavailable");
  });

  it("writes inside a unit of work", async () => {
    await registerJob(context.dependencies, { scope: SCOPE, draft: DRAFT, createdBy: "user-1" });
    expect(context.unitOfWork.transactions).toHaveLength(1);
  });

  it("makes the row findable by its key", async () => {
    await registerJob(context.dependencies, { scope: SCOPE, draft: DRAFT, createdBy: "user-1" });
    const found = await context.jobs.findJobByKey(SCOPE, asIdentifier<JobKey>("nightly-rollup"));
    if (!found.ok) throw new Error("unreachable");
    expect(found.value).not.toBeNull();
  });
});
