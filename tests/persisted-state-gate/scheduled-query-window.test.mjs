import assert from "node:assert/strict";
import test from "node:test";
import {
  scheduledQueryQuietWindowDelay,
  waitForScheduledQueryQuietWindow,
} from "./scheduled-query-window.mjs";

test("waits past the every-minute scheduled Prisma sweep boundary", async () => {
  assert.equal(scheduledQueryQuietWindowDelay(0), 10_000);
  assert.equal(scheduledQueryQuietWindowDelay(9_999), 1);
  assert.equal(scheduledQueryQuietWindowDelay(10_000), 0);
  assert.equal(scheduledQueryQuietWindowDelay(34_999), 0);
  assert.equal(scheduledQueryQuietWindowDelay(35_000), 35_000);
  assert.equal(scheduledQueryQuietWindowDelay(59_999), 10_001);
});

test("sleeps only for the computed quiet-window delay", async () => {
  const sleeps = [];
  const delay = await waitForScheduledQueryQuietWindow({
    now: () => 58_500,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });
  assert.equal(delay, 11_500);
  assert.deepEqual(sleeps, [11_500]);
});
