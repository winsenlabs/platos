import { asIdentifier, type EnvironmentId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { ActorId, CredentialId, CredentialName, ProviderId, ProviderKeyId } from "./identifiers.js";
import {
  admitProviderKey,
  admitProviderKeyPatch,
  admitProviderSecret,
  applyPatch,
  byListingOrder,
  defaultsToDemote,
  demote,
  findDefault,
  labelIsTaken,
  markUsed,
  MAX_PROVIDER_SECRET_LENGTH,
  relink,
  type ProviderKey,
} from "./provider-key.js";

const ENVIRONMENT = asIdentifier<EnvironmentId>("env-1");
const OTHER_ENVIRONMENT = asIdentifier<EnvironmentId>("env-2");
const NOW = new Date("2026-01-01T00:00:00.000Z");

function key(overrides: Partial<ProviderKey> = {}): ProviderKey {
  return {
    providerKeyId: asIdentifier<ProviderKeyId>("key-1"),
    environmentId: ENVIRONMENT,
    credentialId: asIdentifier<CredentialId>("cred-1"),
    provider: asIdentifier<ProviderId>("openai"),
    label: "production",
    credentialName: asIdentifier<CredentialName>("OPENAI_API_KEY"),
    isDefault: false,
    createdBy: asIdentifier<ActorId>("user-1"),
    lastUsedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("admission", () => {
  it("trims every field before it judges it", () => {
    const admitted = admitProviderKey({
      provider: "  openai ",
      label: " production ",
      credentialName: " OPENAI_API_KEY ",
      isDefault: true,
    });
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value).toEqual({
      provider: "openai",
      label: "production",
      credentialName: "OPENAI_API_KEY",
      isDefault: true,
    });
  });

  it("refuses a field that is empty or only whitespace, naming it", () => {
    for (const field of ["provider", "label", "credentialName"] as const) {
      const intake = {
        provider: "openai",
        label: "production",
        credentialName: "OPENAI_API_KEY",
        isDefault: false,
      };
      const denied = admitProviderKey({ ...intake, [field]: "   " });
      expect(denied.ok).toBe(false);
      if (denied.ok) throw new Error("unreachable");
      expect(denied.error.code).toBe("PROVIDERS_KEY_METADATA_INVALID");
      expect(denied.error.fields[0]?.field).toBe(field);
    }
  });

  it("caps a label rather than letting the store decide", () => {
    const denied = admitProviderKey({
      provider: "openai",
      label: "x".repeat(201),
      credentialName: "OPENAI_API_KEY",
      isDefault: false,
    });
    expect(denied.ok).toBe(false);
  });
});

describe("admitting pasted material", () => {
  it("accepts a secret at the ceiling and refuses one above it", () => {
    expect(admitProviderSecret("x".repeat(MAX_PROVIDER_SECRET_LENGTH)).ok).toBe(true);
    expect(admitProviderSecret("x".repeat(MAX_PROVIDER_SECRET_LENGTH + 1)).ok).toBe(false);
  });

  it("refuses an empty or non-string secret", () => {
    expect(admitProviderSecret("").ok).toBe(false);
    expect(admitProviderSecret(undefined).ok).toBe(false);
    expect(admitProviderSecret(42).ok).toBe(false);
  });

  it("never puts the material in the refusal", () => {
    const denied = admitProviderSecret("x".repeat(MAX_PROVIDER_SECRET_LENGTH + 1));
    if (denied.ok) throw new Error("unreachable");
    expect(JSON.stringify(denied.error)).not.toContain("xxx");
  });
});

describe("the listing order is total", () => {
  it("orders by provider, then defaults first, then oldest first, then by id", () => {
    const rows = [
      key({ providerKeyId: asIdentifier<ProviderKeyId>("b"), provider: asIdentifier<ProviderId>("openai") }),
      key({ providerKeyId: asIdentifier<ProviderKeyId>("a"), provider: asIdentifier<ProviderId>("openai") }),
      key({ providerKeyId: asIdentifier<ProviderKeyId>("c"), provider: asIdentifier<ProviderId>("anthropic") }),
      key({ providerKeyId: asIdentifier<ProviderKeyId>("d"), provider: asIdentifier<ProviderId>("openai"), isDefault: true }),
      key({
        providerKeyId: asIdentifier<ProviderKeyId>("e"),
        provider: asIdentifier<ProviderId>("openai"),
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
      }),
    ];
    expect([...rows].sort(byListingOrder).map((row) => row.providerKeyId)).toEqual([
      "c",
      "d",
      "e",
      "a",
      "b",
    ]);
  });

  it("breaks a same-instant tie by id so paging cannot repeat or drop a row", () => {
    const left = key({ providerKeyId: asIdentifier<ProviderKeyId>("a") });
    const right = key({ providerKeyId: asIdentifier<ProviderKeyId>("b") });
    expect(byListingOrder(left, right)).toBeLessThan(0);
    expect(byListingOrder(right, left)).toBeGreaterThan(0);
    expect(byListingOrder(left, left)).toBe(0);
  });
});

describe("the single-default invariant", () => {
  const promoted = key({ providerKeyId: asIdentifier<ProviderKeyId>("new"), provider: asIdentifier<ProviderId>("openai") });

  it("demotes only the incumbent of the same environment and provider", () => {
    const rows = [
      key({ providerKeyId: asIdentifier<ProviderKeyId>("incumbent"), isDefault: true }),
      key({ providerKeyId: asIdentifier<ProviderKeyId>("other-provider"), provider: asIdentifier<ProviderId>("anthropic"), isDefault: true }),
      key({ providerKeyId: asIdentifier<ProviderKeyId>("other-env"), environmentId: OTHER_ENVIRONMENT, isDefault: true }),
      key({ providerKeyId: asIdentifier<ProviderKeyId>("not-default") }),
      promoted,
    ];
    expect(defaultsToDemote(rows, promoted).map((row) => row.providerKeyId)).toEqual(["incumbent"]);
  });

  it("never demotes the key being promoted, even when it is already the default", () => {
    const alreadyDefault = { ...promoted, isDefault: true };
    expect(defaultsToDemote([alreadyDefault], alreadyDefault)).toEqual([]);
  });

  it("finds the default for a provider, and nothing when there is none", () => {
    const rows = [key({ isDefault: true }), key({ providerKeyId: asIdentifier<ProviderKeyId>("k2") })];
    expect(findDefault(rows, asIdentifier<ProviderId>("openai"))?.providerKeyId).toBe("key-1");
    expect(findDefault(rows, asIdentifier<ProviderId>("anthropic"))).toBeNull();
  });
});

describe("label uniqueness within an environment and provider", () => {
  const rows = [key({ providerKeyId: asIdentifier<ProviderKeyId>("held"), label: "production" })];

  it("reports a taken label", () => {
    expect(labelIsTaken(rows, ENVIRONMENT, asIdentifier<ProviderId>("openai"), "production")).toBe(true);
  });

  it("does not reach across environments or providers", () => {
    expect(labelIsTaken(rows, OTHER_ENVIRONMENT, asIdentifier<ProviderId>("openai"), "production")).toBe(false);
    expect(labelIsTaken(rows, ENVIRONMENT, asIdentifier<ProviderId>("anthropic"), "production")).toBe(false);
  });

  it("excludes the row being renamed, so keeping its own label is not a clash", () => {
    expect(
      labelIsTaken(rows, ENVIRONMENT, asIdentifier<ProviderId>("openai"), "production", asIdentifier<ProviderKeyId>("held")),
    ).toBe(false);
  });
});

describe("mutation", () => {
  const later = new Date("2026-02-01T00:00:00.000Z");

  it("applies only the fields a patch names", () => {
    const patched = admitProviderKeyPatch({ label: " renamed " });
    if (!patched.ok) throw new Error("unreachable");
    const updated = applyPatch(key({ isDefault: true }), patched.value, later);
    expect(updated.label).toBe("renamed");
    expect(updated.isDefault).toBe(true);
    expect(updated.updatedAt).toBe(later);
  });

  it("treats an absent label as no change rather than as a blank one", () => {
    const patched = admitProviderKeyPatch({ isDefault: true });
    if (!patched.ok) throw new Error("unreachable");
    expect(patched.value.label).toBeNull();
    expect(applyPatch(key(), patched.value, later).label).toBe("production");
  });

  it("refuses a patch whose label is present and blank", () => {
    expect(admitProviderKeyPatch({ label: "  " }).ok).toBe(false);
  });

  it("relinks the credential and keeps the label when none is supplied", () => {
    const relinked = relink(
      key(),
      asIdentifier<CredentialId>("cred-2"),
      asIdentifier<CredentialName>("OPENAI_API_KEY_2"),
      null,
      later,
    );
    expect(relinked.credentialId).toBe("cred-2");
    expect(relinked.credentialName).toBe("OPENAI_API_KEY_2");
    expect(relinked.label).toBe("production");
  });

  it("demotes and records usage without touching anything else", () => {
    expect(demote(key({ isDefault: true }), later).isDefault).toBe(false);
    expect(markUsed(key(), later).lastUsedAt).toBe(later);
    expect(markUsed(key(), later).updatedAt).toBe(NOW);
  });
});
