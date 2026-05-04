/**
 * Replay-guard tests (PPR-71).
 *
 * Exercises three invariants:
 *   1. Valid `{ts}.{nonce}.{body}` signed requests verify.
 *   2. Replays of the same nonce within the skew window are rejected.
 *   3. Legacy `{ts}.{body}` requests verify + emit one-time warning.
 */

import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetNonceCacheForTests,
  verifyRequest,
} from "../src/security/replay-guard.js";

const SECRET = "s".repeat(64);
const ENTITY = "ent_test";

function sign(body: string, ts: string, nonce?: string): string {
  const str = nonce ? `${ts}.${nonce}.${body}` : `${ts}.${body}`;
  return createHmac("sha256", SECRET).update(str).digest("hex");
}

describe("verifyRequest", () => {
  afterEach(() => {
    __resetNonceCacheForTests();
  });

  it("accepts a correctly signed new-format request", () => {
    const ts = new Date().toISOString();
    const nonce = "a".repeat(32);
    const body = JSON.stringify({ tool: "ping" });
    const res = verifyRequest({
      entityId: ENTITY,
      serviceSecret: SECRET,
      timestamp: ts,
      nonce,
      signature: sign(body, ts, nonce),
      body,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.usedLegacyFormat).toBe(false);
  });

  it("rejects a replay of the same nonce within skew", () => {
    const ts = new Date().toISOString();
    const nonce = "b".repeat(32);
    const body = JSON.stringify({ tool: "ping" });
    const sig = sign(body, ts, nonce);
    const first = verifyRequest({
      entityId: ENTITY,
      serviceSecret: SECRET,
      timestamp: ts,
      nonce,
      signature: sig,
      body,
    });
    expect(first.ok).toBe(true);
    const replay = verifyRequest({
      entityId: ENTITY,
      serviceSecret: SECRET,
      timestamp: ts,
      nonce,
      signature: sig,
      body,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe("nonce_replay");
  });

  it("accepts legacy (no-nonce) requests and warns once", () => {
    const warn = vi.fn();
    const ts = new Date().toISOString();
    const body = "{}";
    const res = verifyRequest({
      entityId: ENTITY,
      serviceSecret: SECRET,
      timestamp: ts,
      signature: sign(body, ts),
      body,
      logger: { warn },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.usedLegacyFormat).toBe(true);
    // Second legacy call should not re-warn.
    verifyRequest({
      entityId: ENTITY,
      serviceSecret: SECRET,
      timestamp: ts,
      signature: sign(body, ts),
      body,
      logger: { warn },
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("rejects stale timestamps", () => {
    const ts = new Date(Date.now() - 10 * 60_000).toISOString();
    const nonce = "c".repeat(32);
    const body = "{}";
    const res = verifyRequest({
      entityId: ENTITY,
      serviceSecret: SECRET,
      timestamp: ts,
      nonce,
      signature: sign(body, ts, nonce),
      body,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("timestamp_skew_exceeded");
  });

  it("rejects signature mismatches", () => {
    const ts = new Date().toISOString();
    const nonce = "d".repeat(32);
    const res = verifyRequest({
      entityId: ENTITY,
      serviceSecret: SECRET,
      timestamp: ts,
      nonce,
      signature: "deadbeef",
      body: "{}",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("signature_mismatch");
  });
});
