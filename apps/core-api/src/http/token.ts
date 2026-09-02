// Constant-time comparison for the readiness admin token.
//
// `a === b` on a secret leaks its prefix through timing: the comparison returns
// at the first differing byte, so an attacker who can measure the difference
// recovers the token one character at a time. `timingSafeEqual` does not
// short-circuit — but it THROWS on a length mismatch, which would reintroduce
// the leak as an exception, so both operands are hashed to a fixed 32 bytes
// first. Hashing also removes the length itself from the observable signal.

import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function constantTimeEquals(expected: string, presented: string): boolean {
  return timingSafeEqual(digest(expected), digest(presented));
}
