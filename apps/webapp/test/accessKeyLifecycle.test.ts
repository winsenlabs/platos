import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccessKeyRevealLifecycle,
  generatePendingAccessKey,
  type PendingAccessKey,
} from "../app/components/platos/accessKeyLifecycle";

const FIRST_ATTEMPT = "11111111-1111-4111-8111-111111111111";
const SECOND_ATTEMPT = "22222222-2222-4222-8222-222222222222";

function pending(attemptId: string, marker: string): PendingAccessKey {
  const rawKey = `platos_live_${marker.padEnd(43, "x")}`;
  return {
    attemptId,
    rawKey,
    keyHash: marker.charCodeAt(0).toString(16).padStart(2, "0").repeat(32),
    keyPrefix: rawKey.slice(0, 24),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AccessKeyRevealLifecycle", () => {
  it("generates independent cryptographic request IDs and hash-only submissions", async () => {
    const first = await generatePendingAccessKey();
    const second = await generatePendingAccessKey();
    const lifecycle = new AccessKeyRevealLifecycle();

    expect(first.attemptId).not.toBe(second.attemptId);
    expect(first.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.rawKey).toMatch(/^platos_live_[A-Za-z0-9_-]{43}$/);
    expect(first.keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(lifecycle.begin(first)).toEqual({
      attemptId: first.attemptId,
      keyHash: first.keyHash,
      keyPrefix: first.keyPrefix,
    });
  });

  it("reveals only after the matching successful persisted response", () => {
    const lifecycle = new AccessKeyRevealLifecycle();
    const material = pending(FIRST_ATTEMPT, "a");

    lifecycle.begin(material);
    expect(lifecycle.hasPending).toBe(true);
    expect(lifecycle.settle({ ok: true, attemptId: FIRST_ATTEMPT, result: { key: { id: "persisted-key" } } })).toEqual({
      status: "revealed",
      rawKey: material.rawKey,
    });
    expect(lifecycle.hasPending).toBe(false);
    expect(lifecycle.settle({ ok: true, attemptId: FIRST_ATTEMPT })).toEqual({ status: "ignored" });
  });

  it("discards matching private material on failure or upstream correlation mismatch", () => {
    const failure = new AccessKeyRevealLifecycle();
    failure.begin(pending(FIRST_ATTEMPT, "a"));
    expect(failure.settle({ ok: false, attemptId: FIRST_ATTEMPT, error: "persistence failed" })).toEqual({
      status: "discarded",
    });
    expect(failure.hasPending).toBe(false);

    const mismatch = new AccessKeyRevealLifecycle();
    mismatch.begin(pending(SECOND_ATTEMPT, "b"));
    expect(mismatch.settle({ ok: false, attemptId: SECOND_ATTEMPT, error: "response did not match request" })).toEqual({
      status: "discarded",
    });
    expect(mismatch.hasPending).toBe(false);
  });

  it("cannot reveal a superseded key when overlapping responses arrive out of order", () => {
    const lifecycle = new AccessKeyRevealLifecycle();
    const first = pending(FIRST_ATTEMPT, "a");
    const second = pending(SECOND_ATTEMPT, "b");

    lifecycle.begin(first);
    lifecycle.begin(second);

    expect(lifecycle.settle({ ok: true, attemptId: FIRST_ATTEMPT })).toEqual({ status: "ignored" });
    expect(lifecycle.hasPending).toBe(true);
    expect(lifecycle.settle({ ok: true, attemptId: SECOND_ATTEMPT })).toEqual({
      status: "revealed",
      rawKey: second.rawKey,
    });
    expect(JSON.stringify(lifecycle)).not.toContain(first.rawKey);
  });

  it("discards pending private material when cancellation or disposal wins the race", () => {
    const lifecycle = new AccessKeyRevealLifecycle();
    const material = pending(FIRST_ATTEMPT, "a");

    lifecycle.begin(material);
    lifecycle.cancel();

    expect(lifecycle.hasPending).toBe(false);
    expect(lifecycle.settle({ ok: true, attemptId: FIRST_ATTEMPT })).toEqual({ status: "ignored" });
  });

  it("redacts pending raw, hash, and prefix material from logs and snapshots", () => {
    const lifecycle = new AccessKeyRevealLifecycle();
    const material = pending(FIRST_ATTEMPT, "a");
    lifecycle.begin(material);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    console.log(lifecycle);

    const evidence = [JSON.stringify(lifecycle), inspect(lifecycle), JSON.stringify(log.mock.calls)].join("\n");
    expect(evidence).toContain("AccessKeyRevealLifecycle redacted");
    expect(evidence).not.toContain(material.rawKey);
    expect(evidence).not.toContain(material.keyHash);
    expect(evidence).not.toContain(material.keyPrefix);
    expect(lifecycle).toMatchInlineSnapshot(`"[AccessKeyRevealLifecycle redacted]"`);
  });
});
