import { asIdentifier } from "@platos/kernel";
import type { EnvironmentId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { asSecretsIdentifier } from "./ids.js";
import type { CredentialId, RootKeyVersion, SecretRevision, SecretVersionId } from "./ids.js";
import {
  bindingOf,
  isOpenable,
  isPurgeEligible,
  isRetired,
  lifecycleOf,
  purgeOrder,
} from "./secret-version.js";
import type { CredentialSecretVersion } from "./secret-version.js";

const environmentId = asIdentifier<EnvironmentId>("env-1");
const credentialId = asSecretsIdentifier<CredentialId>("cred-1");
const T0 = new Date("2026-01-01T00:00:00.000Z");
const T1 = new Date("2026-01-02T00:00:00.000Z");
const T2 = new Date("2026-01-03T00:00:00.000Z");

function version(overrides: Partial<CredentialSecretVersion> = {}): CredentialSecretVersion {
  return {
    id: asSecretsIdentifier<SecretVersionId>("ver-1"),
    credentialId,
    secretRevision: 1 as SecretRevision,
    formatVersion: 1,
    rootKeyVersion: 1 as RootKeyVersion,
    salt: new Uint8Array([1]),
    nonce: new Uint8Array([2]),
    ciphertext: new Uint8Array([3]),
    authTag: new Uint8Array([4]),
    retiredAt: null,
    readableUntil: null,
    createdAt: T0,
    ...overrides,
  };
}

describe("a version is openable only while active and un-retired", () => {
  it("opens the credential's current, un-retired version", () => {
    const current = version();
    expect(isOpenable(current, current.id)).toBe(true);
    expect(isRetired(current)).toBe(false);
  });

  it("REFUSES a retired version even while the credential still points at it", () => {
    const retired = version({ retiredAt: T1, readableUntil: T2 });
    expect(isOpenable(retired, retired.id)).toBe(false);
  });

  it("REFUSES a live version the credential no longer points at", () => {
    const orphan = version();
    expect(isOpenable(orphan, asSecretsIdentifier<SecretVersionId>("ver-9"))).toBe(false);
    expect(isOpenable(orphan, null)).toBe(false);
  });
});

describe("readableUntil defers purging; it does not re-open a read", () => {
  it("reports the three lifecycle states", () => {
    expect(lifecycleOf(version(), T1)).toBe("active");
    expect(lifecycleOf(version({ retiredAt: T0, readableUntil: T2 }), T1)).toBe("retired-retained");
    expect(lifecycleOf(version({ retiredAt: T0, readableUntil: T1 }), T2)).toBe("retired-purgeable");
    expect(lifecycleOf(version({ retiredAt: T0 }), T1)).toBe("retired-purgeable");
  });

  it("keeps a retained version closed to reads", () => {
    const retained = version({ retiredAt: T0, readableUntil: T2 });
    expect(lifecycleOf(retained, T1)).toBe("retired-retained");
    expect(isOpenable(retained, retained.id)).toBe(false);
  });
});

describe("purge eligibility", () => {
  it("never destroys a live version", () => {
    expect(isPurgeEligible(version(), null, T2)).toBe(false);
  });

  it("never destroys the version a credential still points at", () => {
    const retired = version({ retiredAt: T0 });
    expect(isPurgeEligible(retired, retired.id, T2)).toBe(false);
    expect(isPurgeEligible(retired, null, T2)).toBe(true);
  });

  it("respects the cutoff on both retiredAt and readableUntil", () => {
    expect(isPurgeEligible(version({ retiredAt: T2 }), null, T1)).toBe(false);
    expect(isPurgeEligible(version({ retiredAt: T0, readableUntil: T2 }), null, T1)).toBe(false);
    expect(isPurgeEligible(version({ retiredAt: T0, readableUntil: T1 }), null, T2)).toBe(true);
  });

  it("orders candidates deterministically, oldest first then by id", () => {
    const older = version({ id: asSecretsIdentifier<SecretVersionId>("b"), createdAt: T0 });
    const newer = version({ id: asSecretsIdentifier<SecretVersionId>("a"), createdAt: T1 });
    const sibling = version({ id: asSecretsIdentifier<SecretVersionId>("a"), createdAt: T0 });
    expect([newer, older].sort(purgeOrder).map((entry) => entry.id)).toEqual(["b", "a"]);
    expect([older, sibling].sort(purgeOrder).map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("the binding a version authenticates under", () => {
  it("carries every field the store's unique key does", () => {
    expect(bindingOf(version(), environmentId)).toEqual({
      environmentId,
      credentialId,
      secretRevision: 1,
      formatVersion: 1,
      rootKeyVersion: 1,
    });
  });
});
