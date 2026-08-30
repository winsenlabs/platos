import assert from "node:assert/strict";
import test from "node:test";

import { waitForAgentRuntimeHealth } from "./agent-runtime-health.mjs";

function boundedClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (milliseconds) => { time += milliseconds; },
  };
}

function response(status, body = { status: "ok", service: "platos-agent" }) {
  return { status, json: async () => body };
}

function trackedTimers() {
  const active = new Set();
  return {
    active,
    setTimer(callback, milliseconds) {
      const timer = setTimeout(() => {
        active.delete(timer);
        callback();
      }, milliseconds);
      active.add(timer);
      return timer;
    },
    clearTimer(timer) {
      active.delete(timer);
      clearTimeout(timer);
    },
  };
}

test("exact HTTP 200 with the expected Agent health body passes", async () => {
  const result = await waitForAgentRuntimeHealth({
    fetchImpl: async () => response(200),
    ...boundedClock(),
  });
  assert.deepEqual(result, {
    status: 200,
    body: { status: "ok", service: "platos-agent" },
  });
});

for (const status of [201, 204]) {
  test(`HTTP ${status} fails and reports the last observed status`, async () => {
    await assert.rejects(
      waitForAgentRuntimeHealth({
        timeoutMs: 2,
        pollIntervalMs: 1,
        fetchImpl: async () => response(status),
        ...boundedClock(),
      }),
      new RegExp(`lastStatus=${status}; lastObservation=non-200-status`),
    );
  });
}

test("HTTP 200 with an unexpected body remains unhealthy and reports status 200", async () => {
  await assert.rejects(
    waitForAgentRuntimeHealth({
      timeoutMs: 2,
      pollIntervalMs: 1,
      fetchImpl: async () => response(200, { status: "starting", service: "platos-agent" }),
      ...boundedClock(),
    }),
    /lastStatus=200; lastObservation=unexpected-body/,
  );
});

test("a never-resolving fetch is bounded by the overall deadline", async () => {
  const timers = trackedTimers();
  let suppliedSignal;
  const startedAt = Date.now();
  await assert.rejects(
    waitForAgentRuntimeHealth({
      timeoutMs: 20,
      pollIntervalMs: 1,
      fetchImpl: async (_endpoint, options) => {
        suppliedSignal = options.signal;
        return new Promise(() => {});
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    }),
    /lastStatus=none; lastObservation=headers-timeout/,
  );
  assert.ok(Date.now() - startedAt < 500, "hanging response headers must respect the deadline");
  assert.equal(suppliedSignal.aborted, true);
  assert.equal(timers.active.size, 0, "deadline timers must be cleaned up");
});

test("a never-resolving response body is bounded by the same overall deadline", async () => {
  const timers = trackedTimers();
  let suppliedSignal;
  const startedAt = Date.now();
  await assert.rejects(
    waitForAgentRuntimeHealth({
      timeoutMs: 20,
      pollIntervalMs: 1,
      fetchImpl: async (_endpoint, options) => {
        suppliedSignal = options.signal;
        return { status: 200, json: async () => new Promise(() => {}) };
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    }),
    /lastStatus=200; lastObservation=body-timeout/,
  );
  assert.ok(Date.now() - startedAt < 500, "hanging response bodies must respect the deadline");
  assert.equal(suppliedSignal.aborted, true);
  assert.equal(timers.active.size, 0, "deadline timers must be cleaned up");
});
