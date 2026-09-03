// The tenancy-side half of the `accessKeyRevocationVersion` single-writer fix.
//
// identity-access owns `AccessKey` and today writes this tenancy-owned column
// directly. These tests pin the semantics that must survive the move: the row
// lock is taken, the counter only moves forward, and a caller whose snapshot
// has been overtaken is refused rather than silently applied.

import { describe, expect, it } from "vitest";

import { environmentId } from "../domain/index.js";
import { createRevokeAccessKeyGeneration } from "./revoke-access-key-generation.js";
import { createTenancyFixture, seedTree } from "./testing/tenant-fixture.js";

function scenario() {
  const fixture = createTenancyFixture();
  const tree = seedTree(fixture.store);
  return { fixture, tree, revoke: createRevokeAccessKeyGeneration(fixture.dependencies) };
}

describe("revokeAccessKeyGeneration", () => {
  it("advances the generation under the environment row lock", async () => {
    const { fixture, tree, revoke } = scenario();
    const result = await revoke({ environmentId: tree.environment.id });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value).toBe(1);
    expect([...fixture.locks.environmentLocks]).toEqual([tree.environment.id]);
    expect(fixture.store.environments[0]?.accessKeyRevocationVersion).toBe(1);
    expect(fixture.unitOfWork.transactionCount()).toBe(1);
  });

  it("is monotonic across repeated revocations", async () => {
    const { tree, revoke } = scenario();
    const first = await revoke({ environmentId: tree.environment.id });
    const second = await revoke({ environmentId: tree.environment.id });
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect([first.value, second.value]).toEqual([1, 2]);
  });

  it("accepts a caller whose snapshot is still current", async () => {
    const { tree, revoke } = scenario();
    const result = await revoke({ environmentId: tree.environment.id, expectedGeneration: 0 });
    expect(result.ok).toBe(true);
  });

  // A rotation that read an older generation must be superseded, never applied.
  it("refuses a caller whose snapshot has been overtaken", async () => {
    const { fixture, tree, revoke } = scenario();
    await revoke({ environmentId: tree.environment.id });
    const stale = await revoke({ environmentId: tree.environment.id, expectedGeneration: 0 });
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("unreachable");
    expect(stale.error.code).toBe("TENANCY_ACCESS_KEY_GENERATION_SUPERSEDED");
    expect(stale.error.details).toEqual({ observed: 1, expected: 0 });
    // The refusal did not advance the counter.
    expect(fixture.store.environments[0]?.accessKeyRevocationVersion).toBe(1);
  });

  it("refuses an unknown environment before it can lock anything", async () => {
    const { revoke } = scenario();
    const result = await revoke({ environmentId: environmentId("no-such-environment") });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("TENANCY_NOT_FOUND");
  });
});
