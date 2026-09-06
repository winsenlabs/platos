import { asIdentifier } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { PAYLOAD_LIMITS, repositoryUnavailable, type JobId } from "../domain/index.js";
import { executeJob } from "./execute-job.js";
import {
  aJob,
  anAgentId,
  anExecutionRequest,
  buildJobsTestContext,
  testEnvironmentScope,
  type JobsTestContext,
} from "./testing/index.js";

const SCOPE = testEnvironmentScope("env-1");
const OTHER_SCOPE = testEnvironmentScope("env-2");

async function seed(context: JobsTestContext, overrides = {}): Promise<void> {
  await context.jobs.insertJob(SCOPE, aJob(overrides), { transactionId: asIdentifier("seed") });
}

/**
 * A payload that PASSES `isAdmissibleJson` and FAILS the byte cap.
 *
 * The distinction is what makes the cap falsifiable at all. Every oversize
 * fixture in this suite before now was one enormous string, which
 * `isAdmissibleJson` refuses on `maxStringLength` long before the cap is
 * consulted — so deleting the cap's call site changed nothing anyone could
 * observe. This shape stays inside every OTHER limit (100 entries, 8192 chars
 * each, one level deep, no sensitive key) and clears 64 KB by an order of
 * magnitude, so the cap is the ONLY thing that can refuse it.
 */
function oversizedButAdmissible(): Record<string, string> {
  const value: Record<string, string> = {};
  for (let index = 0; index < PAYLOAD_LIMITS.maxCollectionItems; index += 1) {
    value[`k${String(index).padStart(3, "0")}`] = "x".repeat(PAYLOAD_LIMITS.maxStringLength);
  }
  return value;
}

describe("executeJob — stage 1, resolving the job", () => {
  let context: JobsTestContext;

  beforeEach(() => {
    context = buildJobsTestContext();
  });

  it("runs a registered, active, authorized job", async () => {
    await seed(context);
    context.handlers.willReturn({ kind: "completed", value: { rows: 3 } });

    const outcome = await executeJob(context.dependencies, {
      scope: SCOPE,
      request: anExecutionRequest(),
    });

    expect(outcome).toEqual({ ok: true, value: { value: { rows: 3 }, replayed: false } });
  });

  it("REFUSES a job that does not exist", async () => {
    const outcome = await executeJob(context.dependencies, { scope: SCOPE, request: anExecutionRequest() });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("JOB_NOT_FOUND_OR_INACTIVE");
  });

  it("REFUSES a job that lives in ANOTHER environment", async () => {
    await seed(context);
    const outcome = await executeJob(context.dependencies, {
      scope: OTHER_SCOPE,
      request: anExecutionRequest(),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("JOB_NOT_FOUND_OR_INACTIVE");
  });

  it("reports an unreachable store as unavailable, not as absent", async () => {
    context.jobs.failNext("connection reset");
    const outcome = await executeJob(context.dependencies, { scope: SCOPE, request: anExecutionRequest() });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.category).toBe("unavailable");
  });
});

describe("executeJob — stage 2, dispatchability", () => {
  let context: JobsTestContext;

  beforeEach(() => {
    context = buildJobsTestContext();
  });

  it("REFUSES an inactive job as NOT FOUND", async () => {
    await seed(context, { status: "registration-failed" });
    const outcome = await executeJob(context.dependencies, { scope: SCOPE, request: anExecutionRequest() });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("JOB_NOT_FOUND_OR_INACTIVE");
  });

  it("REFUSES a job with no registered key", async () => {
    await seed(context, { jobKey: null });
    const outcome = await executeJob(context.dependencies, { scope: SCOPE, request: anExecutionRequest() });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("JOB_NOT_REGISTERED");
  });

  it("REFUSES a job with a blank handler", async () => {
    await seed(context, { handler: "  " });
    const outcome = await executeJob(context.dependencies, { scope: SCOPE, request: anExecutionRequest() });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("JOB_NOT_REGISTERED");
  });
});

describe("executeJob — stage 3, authorization", () => {
  let context: JobsTestContext;

  beforeEach(() => {
    context = buildJobsTestContext();
  });

  it("REFUSES a manual dispatch of an agent-spawn job", async () => {
    await seed(context, { invocationType: "agent-spawn" });
    const outcome = await executeJob(context.dependencies, {
      scope: SCOPE,
      request: anExecutionRequest({ invokedBy: "manual" }),
    });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("JOB_NOT_AUTHORIZED");
  });

  it("PERMITS an agent dispatch of an agent-spawn job — the one bridge", async () => {
    await seed(context, { invocationType: "agent-spawn" });
    context.handlers.willReturn({ kind: "completed", value: null });
    const outcome = await executeJob(context.dependencies, {
      scope: SCOPE,
      request: anExecutionRequest({ invokedBy: "agent", agentId: anAgentId("agent-1") }),
    });
    expect(outcome.ok).toBe(true);
  });

  it("REFUSES an agent that is not on a populated allow-list", async () => {
    await seed(context, { invocationType: "agent-spawn", allowedAgentIds: [anAgentId("agent-9")] });
    const outcome = await executeJob(context.dependencies, {
      scope: SCOPE,
      request: anExecutionRequest({ invokedBy: "agent", agentId: anAgentId("agent-1") }),
    });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("JOB_NOT_AUTHORIZED");
  });

  it("does NOT reserve the request id when authorization fails", async () => {
    // Reserving before authorizing would let an unauthorized caller burn another
    // caller's request id for seven days.
    await seed(context, { invocationType: "agent-spawn" });
    const request = anExecutionRequest({ invokedBy: "manual" });
    await executeJob(context.dependencies, { scope: SCOPE, request });
    expect(
      context.idempotency.peek({ environmentId: SCOPE.environmentId, requestId: request.requestId }),
    ).toBeNull();
  });
});

describe("executeJob — stage 4, idempotency", () => {
  let context: JobsTestContext;

  beforeEach(async () => {
    context = buildJobsTestContext();
    await seed(context);
  });

  it("REPLAYS a completed result instead of re-running the handler", async () => {
    context.handlers.willReturn({ kind: "completed", value: { rows: 1 } });
    const request = anExecutionRequest();

    const first = await executeJob(context.dependencies, { scope: SCOPE, request });
    const second = await executeJob(context.dependencies, { scope: SCOPE, request });

    expect(first).toEqual({ ok: true, value: { value: { rows: 1 }, replayed: false } });
    expect(second).toEqual({ ok: true, value: { value: { rows: 1 }, replayed: true } });
    expect(context.handlers.invocations).toHaveLength(1);
  });

  it("REPLAYS a cached failure rather than re-running", async () => {
    context.handlers.willReturn({ kind: "failed", reason: "boom" });
    const request = anExecutionRequest();

    const first = await executeJob(context.dependencies, { scope: SCOPE, request });
    const second = await executeJob(context.dependencies, { scope: SCOPE, request });

    if (first.ok || second.ok) throw new Error("unreachable");
    expect(first.error.code).toBe("JOB_EXECUTION_FAILED");
    expect(second.error.code).toBe("JOB_EXECUTION_FAILED");
    expect(second.error.details).toEqual({ replayed: true });
    expect(context.handlers.invocations).toHaveLength(1);
  });

  // THE CACHED FAILURE'S CODE WAS UNPINNED. The only replay-of-failure case above
  // uses `kind: "failed"`, whose code IS the hard-coded `JOB_EXECUTION_FAILED`,
  // so replacing `outcome.error.code` with that literal survived all 354 tests.
  // The `settle()` docblock argues at length that a caller must never be handed
  // "a cached failure whose code it was never promised"; these two are the codes
  // that can be, and neither had ever round-tripped through a 7-day reservation.
  it.each([
    ["timed-out", "JOB_TIMEOUT"],
    ["result-rejected", "JOB_RESULT_REJECTED"],
  ] as const)("REPLAYS a %s as %s, not as a generic execution failure", async (kind, code) => {
    const fresh = buildJobsTestContext();
    await fresh.jobs.insertJob(SCOPE, aJob(), { transactionId: asIdentifier("seed") });
    fresh.handlers.willReturn(kind === "timed-out" ? { kind } : ({ kind, reason: "because" } as never));
    const request = anExecutionRequest();

    const first = await executeJob(fresh.dependencies, { scope: SCOPE, request });
    const second = await executeJob(fresh.dependencies, { scope: SCOPE, request });

    if (first.ok || second.ok) throw new Error("unreachable");
    expect(first.error.code).toBe(code);
    expect(second.error.code).toBe(code);
    expect(second.error.details).toEqual({ replayed: true });
    // The handler ran once: the second answer came from the reservation.
    expect(fresh.handlers.invocations).toHaveLength(1);
  });

  it("REFUSES the same request id carrying a DIFFERENT payload", async () => {
    context.handlers.willReturn({ kind: "completed", value: null });
    await executeJob(context.dependencies, { scope: SCOPE, request: anExecutionRequest() });

    const outcome = await executeJob(context.dependencies, {
      scope: SCOPE,
      request: anExecutionRequest({ payload: { changed: true } }),
    });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("treats a payload differing only in KEY ORDER as the same request", async () => {
    context.handlers.willReturn({ kind: "completed", value: null });
    await executeJob(context.dependencies, {
      scope: SCOPE,
      request: anExecutionRequest({ payload: { a: 1, b: 2 } }),
    });
    const second = await executeJob(context.dependencies, {
      scope: SCOPE,
      request: anExecutionRequest({ payload: { b: 2, a: 1 } }),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.replayed).toBe(true);
  });

  it("ISOLATES request ids per environment", async () => {
    await context.jobs.insertJob(OTHER_SCOPE, aJob(), { transactionId: asIdentifier("seed") });
    context.handlers.willReturn({ kind: "completed", value: { where: "one" } });
    context.handlers.willReturn({ kind: "completed", value: { where: "two" } });

    const request = anExecutionRequest();
    const first = await executeJob(context.dependencies, { scope: SCOPE, request });
    const second = await executeJob(context.dependencies, { scope: OTHER_SCOPE, request });

    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(first.value.value).toEqual({ where: "one" });
    expect(second.value.value).toEqual({ where: "two" });
  });

  it("FAILS CLOSED when the reservation store is unreachable", async () => {
    context.idempotency.failNext("redis down");
    const outcome = await executeJob(context.dependencies, { scope: SCOPE, request: anExecutionRequest() });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("IDEMPOTENCY_UNAVAILABLE");
    expect(context.handlers.invocations).toHaveLength(0);
  });

  it("FAILS CLOSED when a held record cannot be read", async () => {
    context.handlers.willReturn({ kind: "completed", value: null });
    const request = anExecutionRequest();
    await executeJob(context.dependencies, { scope: SCOPE, request });

    context.idempotency.corruptNextRead();
    const outcome = await executeJob(context.dependencies, { scope: SCOPE, request });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("JOBS_IDEMPOTENCY_RECORD_ABSENT");
    expect(context.handlers.invocations).toHaveLength(1);
  });

  it("tells the three unreadable reservations apart, and apart from a real CONFLICT", async () => {
    // WIN-260. All four used to arrive as IDEMPOTENCY_CONFLICT. The set below is
    // asserted for its SIZE as well as its members: a regression that merged any
    // two of them back together shrinks it, whatever the individual codes are.
    const codes: string[] = [];
    for (const reason of ["absent", "malformed", "unpromised-code"] as const) {
      const fresh = buildJobsTestContext();
      await seed(fresh);
      fresh.handlers.willReturn({ kind: "completed", value: null });
      const request = anExecutionRequest();
      await executeJob(fresh.dependencies, { scope: SCOPE, request });
      fresh.idempotency.corruptNextRead(reason);
      const outcome = await executeJob(fresh.dependencies, { scope: SCOPE, request });
      if (outcome.ok) throw new Error("unreachable");
      codes.push(outcome.error.code);
    }

    // The fourth: a genuine reuse of one request id under a different body.
    context.handlers.willReturn({ kind: "completed", value: null });
    await executeJob(context.dependencies, { scope: SCOPE, request: anExecutionRequest() });
    const conflict = await executeJob(context.dependencies, {
      scope: SCOPE,
      request: anExecutionRequest({ payload: { changed: true } }),
    });
    if (conflict.ok) throw new Error("unreachable");
    codes.push(conflict.error.code);

    expect(new Set(codes).size).toBe(4);
    expect(codes).toEqual([
      "JOBS_IDEMPOTENCY_RECORD_ABSENT",
      "JOBS_IDEMPOTENCY_RECORD_MALFORMED",
      "JOBS_IDEMPOTENCY_REPLAY_CODE_UNPROMISED",
      "IDEMPOTENCY_CONFLICT",
    ]);
  });
});

describe("executeJob — stage 5, running the handler", () => {
  let context: JobsTestContext;

  beforeEach(async () => {
    context = buildJobsTestContext();
    await seed(context);
  });

  it("passes the job's effective timeout to the sandbox", async () => {
    context.handlers.willReturn({ kind: "completed", value: null });
    await executeJob(context.dependencies, { scope: SCOPE, request: anExecutionRequest() });
    expect(context.handlers.invocations[0]?.timeoutMs).toBe(300_000);
  });

  it("caps the timeout at the platform ceiling", async () => {
    const fresh = buildJobsTestContext();
    await fresh.jobs.insertJob(
      SCOPE,
      aJob({ budget: { timeoutSeconds: 100_000, maxRetries: 0 } }),
      { transactionId: asIdentifier("seed") },
    );
    fresh.handlers.willReturn({ kind: "completed", value: null });
    await executeJob(fresh.dependencies, { scope: SCOPE, request: anExecutionRequest() });
    expect(fresh.handlers.invocations[0]?.timeoutMs).toBe(580_000);
  });

  it.each([
    ["timed-out", "JOB_TIMEOUT"],
    ["result-rejected", "JOB_RESULT_REJECTED"],
    ["failed", "JOB_EXECUTION_FAILED"],
  ] as const)("classifies a %s outcome as %s", async (kind, code) => {
    const fresh = buildJobsTestContext();
    await fresh.jobs.insertJob(SCOPE, aJob(), { transactionId: asIdentifier("seed") });
    fresh.handlers.willReturn(
      kind === "timed-out" ? { kind } : ({ kind, reason: "because" } as never),
    );
    const outcome = await executeJob(fresh.dependencies, { scope: SCOPE, request: anExecutionRequest() });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe(code);
  });

  it("RE-ADMITS the handler's result against the payload rules", async () => {
    // A handler is untrusted code and its output is persisted and replayed.
    context.handlers.willReturn({ kind: "completed", value: { apiKey: "leaked" } });
    const outcome = await executeJob(context.dependencies, { scope: SCOPE, request: anExecutionRequest() });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("JOB_RESULT_REJECTED");
  });

  it("REFUSES a result quoting a known secret", async () => {
    const fresh = buildJobsTestContext(["tok-secret"]);
    await fresh.jobs.insertJob(SCOPE, aJob(), { transactionId: asIdentifier("seed") });
    fresh.handlers.willReturn({ kind: "completed", value: { note: "tok-secret" } });
    const outcome = await executeJob(fresh.dependencies, { scope: SCOPE, request: anExecutionRequest() });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("JOB_RESULT_REJECTED");
  });

  it("REFUSES an oversized result", async () => {
    context.handlers.willReturn({ kind: "completed", value: { blob: "x".repeat(70_000) } });
    const outcome = await executeJob(context.dependencies, { scope: SCOPE, request: anExecutionRequest() });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("JOB_RESULT_REJECTED");
  });

  it("stamps lastStartedAt on a successful run", async () => {
    context.handlers.willReturn({ kind: "completed", value: null });
    await executeJob(context.dependencies, { scope: SCOPE, request: anExecutionRequest() });
    const stored = await context.jobs.findJob(SCOPE, asIdentifier<JobId>("job-0001"));
    if (!stored.ok || stored.value === null) throw new Error("unreachable");
    expect(stored.value.lastStartedAt).toEqual(context.clock.now());
  });

  it("does NOT cache a non-execution port failure as a replayable outcome", async () => {
    // A repository error is not one of the eleven inherited codes, so caching it
    // would put an unrecognisable code on a contract that says the set is closed.
    context.handlers.willReturn({ kind: "completed", value: null });
    context.jobs.failNext("store blip");
    const request = anExecutionRequest();
    // The failure lands on `findJob`, before any reservation is taken.
    const outcome = await executeJob(context.dependencies, { scope: SCOPE, request });
    expect(outcome.ok).toBe(false);
    expect(
      context.idempotency.peek({ environmentId: SCOPE.environmentId, requestId: request.requestId }),
    ).toBeNull();
  });

  // THE CAP WAS UNFALSIFIABLE AT THIS CALL SITE. The only oversize result the
  // suite offered was one 70,000-character string, which `isAdmissibleJson`
  // refuses on `maxStringLength` — so `classify`'s `withinSizeCap(value)` could be
  // deleted outright and every test stayed green. Note the asymmetry the
  // verification found: the admissibility half of the same pair WAS killed, so
  // "the result is re-admitted against the SAME rules as the payload" was only
  // half true in test terms. A handler's result is persisted into a seven-day
  // idempotency record and replayed from it, so an 819 KB result the cap does not
  // stop is 819 KB in the reservation store for a week.
  it("REFUSES a result that is admissible but exceeds the BYTE CAP", async () => {
    context.handlers.willReturn({ kind: "completed", value: oversizedButAdmissible() });
    const outcome = await executeJob(context.dependencies, { scope: SCOPE, request: anExecutionRequest() });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("JOB_RESULT_REJECTED");
    expect(outcome.error.details).toEqual({ reason: "result exceeds the size cap" });
  });
});

// THE FAIL-CLOSED FILTER IN `settle` HAD NO TEST THAT COULD REACH IT. Its
// docblock spends a paragraph on the property — a repository or sandbox-port
// error must leave the `running` reservation to expire "rather than being handed
// a cached failure whose code it was never promised" — and deleting the filter
// left all 367 tests green. The one test that named a non-execution failure
// injected it into `findJob`, which fails at stage 1, BEFORE any reservation
// exists; nothing had ever driven such an error past stage 4. `failNextRun` is
// the injector that can: it fails the PORT rather than the handler, which is the
// only way an error outside the eleven inherited codes reaches `settle`.
describe("executeJob — settling a reservation after a NON-execution failure", () => {
  let context: JobsTestContext;
  const request = anExecutionRequest();
  const key = { environmentId: SCOPE.environmentId, requestId: request.requestId };

  beforeEach(async () => {
    context = buildJobsTestContext();
    await seed(context);
    context.handlers.failNextRun(repositoryUnavailable("sandbox worker could not start"));
  });

  it("leaves the reservation RUNNING rather than caching a foreign code", async () => {
    const outcome = await executeJob(context.dependencies, { scope: SCOPE, request });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("JOBS_REPOSITORY_UNAVAILABLE");
    // Reserved at stage 4, so the record exists — but it must still say `running`.
    expect(context.idempotency.peek(key)).toEqual({ state: "running", digest: expect.anything() });
  });

  it("tells a retry IDEMPOTENCY_IN_PROGRESS, not a replayed foreign failure", async () => {
    await executeJob(context.dependencies, { scope: SCOPE, request });
    const retry = await executeJob(context.dependencies, { scope: SCOPE, request });
    if (retry.ok) throw new Error("unreachable");
    expect(retry.error.code).toBe("IDEMPOTENCY_IN_PROGRESS");
    expect(retry.error.details).not.toEqual({ replayed: true });
  });
});
