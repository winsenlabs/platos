import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { JobId, JobKey } from "./identifiers.js";
import { isJobKey, JOB_KEY_PATTERN, parseJobKey } from "./job-key.js";
import {
  assertDispatchable,
  effectiveTimeoutMs,
  isActive,
  JOB_STATUS_TO_STORED,
  MAX_JOB_TIMEOUT_MS,
  withLastStartedAt,
  type Job,
} from "./job.js";

const EPOCH = new Date("2026-01-01T00:00:00.000Z");

function job(overrides: Partial<Job> = {}): Job {
  return {
    jobId: asIdentifier<JobId>("job-1"),
    jobKey: asIdentifier<JobKey>("nightly-rollup"),
    displayName: "Nightly rollup",
    description: null,
    invocationType: "manual",
    schedule: { cron: null, timezone: null },
    allowedAgentIds: [],
    payloadSchema: null,
    handler: "async function run() {}",
    budget: { timeoutSeconds: 300, maxRetries: 3 },
    status: "active",
    createdBy: "user-1",
    lastStartedAt: null,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...overrides,
  };
}

describe("job key", () => {
  it.each(["a", "nightly-rollup", "job-123", "x".repeat(64)])("accepts %s", (value) => {
    expect(isJobKey(value)).toBe(true);
  });

  it.each(["", "Nightly", "has space", "under_score", "x".repeat(65), "dot.dot"])(
    "REFUSES %s",
    (value) => {
      expect(isJobKey(value)).toBe(false);
    },
  );

  it("is anchored at both ends", () => {
    expect(JOB_KEY_PATTERN.test("ok\nnot-ok")).toBe(false);
  });

  it("reports the rule when it refuses", () => {
    const parsed = parseJobKey("NOPE");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.error.code).toBe("JOBS_JOB_KEY_INVALID");
  });
});

describe("status", () => {
  it("maps the two statuses a Job row actually takes", () => {
    expect(JOB_STATUS_TO_STORED).toEqual({ active: "ACTIVE", "registration-failed": "FAILED" });
  });

  it("recognises an active job", () => {
    expect(isActive(job())).toBe(true);
    expect(isActive(job({ status: "registration-failed" }))).toBe(false);
  });
});

describe("assertDispatchable", () => {
  it("returns the key for a dispatchable job", () => {
    const check = assertDispatchable(job(), isJobKey);
    expect(check).toEqual({ ok: true, value: "nightly-rollup" });
  });

  it("REFUSES an inactive job as NOT FOUND, not as unregistered", () => {
    const check = assertDispatchable(job({ status: "registration-failed" }), isJobKey);
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("unreachable");
    expect(check.error.code).toBe("JOB_NOT_FOUND_OR_INACTIVE");
  });

  it("REFUSES a job with no registered key", () => {
    const check = assertDispatchable(job({ jobKey: null }), isJobKey);
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("unreachable");
    expect(check.error.code).toBe("JOB_NOT_REGISTERED");
  });

  it("RE-CHECKS the key rather than trusting the stored row", () => {
    // A row predating a narrowing of the key rule must stop being dispatchable.
    const legacy = job({ jobKey: asIdentifier<JobKey>("Legacy_Key") });
    const check = assertDispatchable(legacy, isJobKey);
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("unreachable");
    expect(check.error.code).toBe("JOB_NOT_REGISTERED");
  });

  it("REFUSES a blank handler", () => {
    expect(assertDispatchable(job({ handler: "   " }), isJobKey).ok).toBe(false);
    expect(assertDispatchable(job({ handler: "" }), isJobKey).ok).toBe(false);
  });
});

describe("effectiveTimeoutMs", () => {
  it("converts seconds to milliseconds", () => {
    expect(effectiveTimeoutMs({ timeoutSeconds: 30, maxRetries: 0 })).toBe(30_000);
  });

  it("FLOORS a zero or negative column value at one second", () => {
    expect(effectiveTimeoutMs({ timeoutSeconds: 0, maxRetries: 0 })).toBe(1_000);
    expect(effectiveTimeoutMs({ timeoutSeconds: -5, maxRetries: 0 })).toBe(1_000);
  });

  it("CAPS at the platform ceiling so the sandbox gives up first", () => {
    expect(effectiveTimeoutMs({ timeoutSeconds: 100_000, maxRetries: 0 })).toBe(MAX_JOB_TIMEOUT_MS);
  });
});

describe("withLastStartedAt", () => {
  it("stamps both the start and the update time", () => {
    const started = new Date("2026-02-02T00:00:00.000Z");
    const stamped = withLastStartedAt(job(), started);
    expect(stamped.lastStartedAt).toEqual(started);
    expect(stamped.updatedAt).toEqual(started);
  });
});
