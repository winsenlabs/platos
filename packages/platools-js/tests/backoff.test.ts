/**
 * Exponential backoff math tests.
 *
 * PRD §5.2 mandates exponential backoff matching the Python SDK:
 *
 *   delay = base * 2^(attempt - 1)
 *   capped at max
 *
 * with base = 1s, max = 60s. Locking this curve down prevents drift
 * between the two SDKs — a customer running both must see the same
 * reconnect behavior when a platform deploy bounces connections.
 */

import { describe, expect, it } from "vitest";

import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  backoffDelayMs,
} from "../src/transport/client.js";

describe("backoffDelayMs", () => {
  it("matches the Python defaults exactly", () => {
    // Python: BACKOFF_BASE = 1.0s, BACKOFF_MAX = 60.0s.
    expect(BACKOFF_BASE_MS).toBe(1_000);
    expect(BACKOFF_MAX_MS).toBe(60_000);
  });

  it("doubles on every attempt", () => {
    expect(backoffDelayMs(1)).toBe(1_000); // 1s
    expect(backoffDelayMs(2)).toBe(2_000); // 2s
    expect(backoffDelayMs(3)).toBe(4_000); // 4s
    expect(backoffDelayMs(4)).toBe(8_000); // 8s
    expect(backoffDelayMs(5)).toBe(16_000); // 16s
    expect(backoffDelayMs(6)).toBe(32_000); // 32s
  });

  it("caps at BACKOFF_MAX_MS", () => {
    // 2^6 * 1s = 64s — should clamp to 60s.
    expect(backoffDelayMs(7)).toBe(60_000);
    expect(backoffDelayMs(10)).toBe(60_000);
    expect(backoffDelayMs(100)).toBe(60_000);
  });

  it("returns 0 for non-positive attempts (defensive)", () => {
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(-5)).toBe(0);
  });

  it("honors custom base and max overrides", () => {
    // Tests can inject a tight curve to keep the unit fast.
    expect(backoffDelayMs(1, 50, 400)).toBe(50);
    expect(backoffDelayMs(2, 50, 400)).toBe(100);
    expect(backoffDelayMs(3, 50, 400)).toBe(200);
    expect(backoffDelayMs(4, 50, 400)).toBe(400);
    expect(backoffDelayMs(5, 50, 400)).toBe(400); // capped
  });
});
