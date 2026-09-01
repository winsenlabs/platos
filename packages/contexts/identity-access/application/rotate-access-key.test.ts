import { describe, expect, it } from "vitest";

import { DEFAULT_ROTATION_OVERLAP_MS, acceptsRequestAt, isActive } from "../domain/index.js";
import { ENVIRONMENT_ID, T0, anAccessKey, at, tokenHash } from "../domain/testing.js";
import { revokeAccessKeys, rotateAccessKey } from "./rotate-access-key.js";
import { testPorts, type TestPorts } from "./testing.js";

const NEXT_HASH = "b".repeat(64);
const request = {
  environmentId: ENVIRONMENT_ID,
  keyHash: NEXT_HASH,
  keyPrefix: "platos_live_next",
} as const;

function arrange(withActiveKey: boolean): TestPorts {
  const ports = testPorts();
  ports.repository.state.revocationGenerations.set(ENVIRONMENT_ID, 0);
  if (withActiveKey) {
    const active = anAccessKey({ allowedOrigins: ["https://app.example.com"] });
    ports.repository.state.accessKeys.set(active.accessKeyId, active);
  }
  return ports;
}

describe("first install", () => {
  it("creates the one active key with nothing to retire", async () => {
    const ports = arrange(false);
    const result = await rotateAccessKey(ports, request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.retiringKey).toBeNull();
    expect(isActive(result.value.nextKey)).toBe(true);
    expect(await ports.repository.accessKeys.findActiveKey(ENVIRONMENT_ID)).not.toBeNull();
  });

  it("refuses when the environment does not exist", async () => {
    const ports = testPorts();
    const result = await rotateAccessKey(ports, request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("IDENTITY_STORE_UNAVAILABLE");
  });
});

describe("rotation keeps the outgoing key working for the overlap", () => {
  it("retires the old key with a closing instant and a forward pointer", async () => {
    const ports = arrange(true);
    const result = await rotateAccessKey(ports, request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.retiringKey?.validUntil).toEqual(at(DEFAULT_ROTATION_OVERLAP_MS));
    expect(result.value.retiringKey?.replacedById).toBe(result.value.nextKey.accessKeyId);
  });

  it("HONOURS BOTH KEYS during the overlap and only the new one after", async () => {
    const ports = arrange(true);
    const result = await rotateAccessKey(ports, request);
    if (!result.ok) return;
    const retiring = result.value.retiringKey;
    expect(retiring).not.toBeNull();
    if (retiring === null) return;

    expect(acceptsRequestAt(retiring, at(9 * 60_000))).toBe(true);
    expect(acceptsRequestAt(retiring, at(DEFAULT_ROTATION_OVERLAP_MS))).toBe(false);
    expect(acceptsRequestAt(result.value.nextKey, at(DEFAULT_ROTATION_OVERLAP_MS))).toBe(true);
  });

  it("carries the allowed origins forward, so rotation is not an outage", async () => {
    const ports = arrange(true);
    const result = await rotateAccessKey(ports, request);
    expect(result.ok && result.value.nextKey.allowedOrigins).toEqual([
      "https://app.example.com",
    ]);
  });

  it("leaves exactly one active key behind", async () => {
    const ports = arrange(true);
    await rotateAccessKey(ports, request);
    const active = [...ports.repository.state.accessKeys.values()].filter(isActive);
    expect(active).toHaveLength(1);
  });
});

describe("negative controls", () => {
  it("REFUSES A ROTATION SUPERSEDED BY A CONCURRENT REVOKE", async () => {
    const ports = arrange(true);
    // The revoke has to land in the window the fence exists to cover: AFTER the
    // rotation snapshots the generation and BEFORE it takes the lock. Bumping
    // the counter before the call would prove nothing — the snapshot would
    // simply read the new value and agree with it.
    const racing = {
      ...ports.repository,
      accessKeys: {
        ...ports.repository.accessKeys,
        async readRevocationGeneration(environmentId: typeof ENVIRONMENT_ID) {
          const snapshot = await ports.repository.accessKeys.readRevocationGeneration(
            environmentId,
          );
          await ports.repository.accessKeys.revokeAll(environmentId, T0);
          return snapshot;
        },
      },
    };

    const result = await rotateAccessKey(
      { repository: racing, clock: ports.clock, ids: ports.ids },
      { ...request, keyHash: "c".repeat(64) },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ACCESS_KEY_ROTATION_SUPERSEDED");
    // And the revoke stands: the destroyed key was not resurrected.
    expect(await ports.repository.accessKeys.findActiveKey(ENVIRONMENT_ID)).toBeNull();
  });

  it("does not rotate again when the SAME material is re-presented", async () => {
    const ports = arrange(false);
    const first = await rotateAccessKey(ports, request);
    const second = await rotateAccessKey(ports, request);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.nextKey.accessKeyId).toBe(first.value.nextKey.accessKeyId);
    expect(ports.repository.state.accessKeys.size).toBe(1);
  });

  it("refuses malformed key material before writing anything", async () => {
    const ports = arrange(true);
    const refused = await rotateAccessKey(ports, { ...request, keyHash: "not-a-digest" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("INVALID_ACCESS_KEY_MATERIAL");
    expect(ports.repository.state.accessKeys.size).toBe(1);
  });

  it("refuses a prefix that is not the public platos_live_ form", async () => {
    const refused = await rotateAccessKey(arrange(true), { ...request, keyPrefix: "sk_live_x" });
    expect(refused.ok).toBe(false);
  });
});

describe("revoke", () => {
  it("revokes every key and moves the generation so an in-flight rotation loses", async () => {
    const ports = arrange(true);
    const revoked = await revokeAccessKeys(ports, { environmentId: ENVIRONMENT_ID });
    expect(revoked.ok && revoked.value).toBe(1);
    expect(await ports.repository.accessKeys.findActiveKey(ENVIRONMENT_ID)).toBeNull();
    expect(ports.repository.state.revocationGenerations.get(ENVIRONMENT_ID)).toBe(1);
  });

  it("leaves a revoked key unusable even inside what would have been its overlap", async () => {
    const ports = arrange(true);
    await revokeAccessKeys(ports, { environmentId: ENVIRONMENT_ID });
    const key = [...ports.repository.state.accessKeys.values()][0];
    expect(key).toBeDefined();
    if (key === undefined) return;
    expect(acceptsRequestAt(key, T0)).toBe(false);
    expect(key.keyHash).toBe(tokenHash("a".repeat(64)));
  });
});
