import { describe, expect, it } from "vitest";

import type { RootKeyVersion } from "./ids.js";
import {
  ROOT_KEY_BYTE_LENGTH,
  canRemoveRootKey,
  needsReEncryption,
  priorRootKeyVersions,
  rootKeyReport,
  rootKeyRingState,
  rootKeyStatus,
} from "./key-ring.js";
import type { RootKeyRingState } from "./key-ring.js";

const version = (value: number): RootKeyVersion => value as RootKeyVersion;

function ring(active: number, present: readonly number[]): RootKeyRingState {
  const built = rootKeyRingState(version(active), present.map(version));
  if (!built.ok) throw new Error(built.error.code);
  return built.value;
}

describe("a ring must be able to open what it claims to seal", () => {
  it("refuses a ring whose active version is not in it", () => {
    const refused = rootKeyRingState(version(3), [version(1), version(2)]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("INVALID_KEY_RING");
  });

  it("de-duplicates and orders the versions it holds", () => {
    expect(ring(2, [2, 1, 2, 3]).presentVersions).toEqual([1, 2, 3]);
  });

  it("states the key width the canonical envelope needs", () => {
    expect(ROOT_KEY_BYTE_LENGTH).toBe(32);
  });
});

describe("root key status drives the whole rotation lifecycle", () => {
  const rotated = ring(2, [1, 2]);

  it("names the active, the prior and the absent", () => {
    expect(rootKeyStatus(rotated, version(2))).toBe("active");
    expect(rootKeyStatus(rotated, version(1))).toBe("prior");
    expect(rootKeyStatus(rotated, version(9))).toBe("absent");
  });

  it("owes re-encryption for every prior version and none for the active one", () => {
    expect(priorRootKeyVersions(rotated)).toEqual([1]);
    expect(needsReEncryption(rotated, version(1))).toBe(true);
    expect(needsReEncryption(rotated, version(2))).toBe(false);
  });

  it("does not owe re-encryption for a version that is already gone", () => {
    expect(needsReEncryption(rotated, version(9))).toBe(false);
  });
});

describe("a root key may leave only when nothing still needs it", () => {
  const rotated = ring(2, [1, 2]);

  it("never removes the active key", () => {
    const report = rootKeyReport(rotated, [{ rootKeyVersion: version(2), unpurgedVersionCount: 0 }]);
    expect(canRemoveRootKey(report, version(2))).toBe(false);
  });

  it("blocks removal while unpurged envelopes still reference the version", () => {
    const report = rootKeyReport(rotated, [
      { rootKeyVersion: version(1), unpurgedVersionCount: 3 },
      { rootKeyVersion: version(2), unpurgedVersionCount: 7 },
    ]);
    expect(canRemoveRootKey(report, version(1))).toBe(false);
  });

  it("permits removal once the count reaches zero, and when it never appeared", () => {
    const report = rootKeyReport(rotated, [
      { rootKeyVersion: version(1), unpurgedVersionCount: 0 },
      { rootKeyVersion: version(2), unpurgedVersionCount: 4 },
    ]);
    expect(canRemoveRootKey(report, version(1))).toBe(true);
    expect(canRemoveRootKey(report, version(5))).toBe(true);
  });

  it("orders the usage report by version so an operator reads it the same way twice", () => {
    const report = rootKeyReport(rotated, [
      { rootKeyVersion: version(2), unpurgedVersionCount: 1 },
      { rootKeyVersion: version(1), unpurgedVersionCount: 2 },
    ]);
    expect(report.usage.map((row) => row.rootKeyVersion)).toEqual([1, 2]);
    expect(report.activeRootKeyVersion).toBe(2);
  });
});
