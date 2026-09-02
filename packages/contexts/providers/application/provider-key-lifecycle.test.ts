// The WRITE half of the ProviderKey lifecycle. The read half — listing, paging
// and the cross-tenant denial — is `read-provider-keys.test.ts`.
import { describe, expect, it } from "vitest";

import { asProvidersIdentifier, type ProviderId, type ProviderKeyId } from "../domain/index.js";
import { deleteProviderKey } from "./delete-provider-key.js";
import { linkProviderKey } from "./link-provider-key.js";
import { registerProviderKey } from "./register-provider-key.js";
import { relinkProviderKey, rotateProviderKeySecret } from "./rotate-provider-key.js";
import { buildProvidersTestContext, testProviderKey } from "./testing/index.js";
import { updateProviderKey } from "./update-provider-key.js";

const OPENAI = asProvidersIdentifier<ProviderId>("openai");

function intake(overrides: Partial<Parameters<typeof linkProviderKey>[1]["intake"]> = {}) {
  return {
    provider: "openai",
    label: "production",
    credentialName: "OPENAI_API_KEY",
    isDefault: false,
    ...overrides,
  };
}

describe("linking a key to a credential that already exists", () => {
  it("mints the row, taking the credential name from the resolved credential", async () => {
    const context = buildProvidersTestContext();
    context.secrets.seed({ name: "OPENAI_API_KEY", provider: "openai", plaintext: "sk-live" });

    const linked = await linkProviderKey(context.dependencies, {
      authorization: context.tenancy.grant(),
      intake: intake({ isDefault: true }),
    });
    if (!linked.ok) throw new Error(`unreachable: ${linked.error.code}`);
    expect(linked.value.credentialName).toBe("OPENAI_API_KEY");
    expect(linked.value.isDefault).toBe(true);
    expect(linked.value.createdBy).toBe("operator-1");
    expect(context.probeCache.forgotten).toEqual([OPENAI]);
  });

  it("refuses a credential that is another provider's", async () => {
    const context = buildProvidersTestContext();
    context.secrets.seed({ name: "OPENAI_API_KEY", provider: "anthropic", plaintext: "sk-live" });

    const denied = await linkProviderKey(context.dependencies, {
      authorization: context.tenancy.grant(),
      intake: intake(),
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PROVIDERS_CREDENTIAL_UNAVAILABLE");
  });

  it("refuses a revoked credential and one with no active envelope", async () => {
    for (const state of [{ revoked: true }, { withoutActiveVersion: true }]) {
      const context = buildProvidersTestContext();
      context.secrets.seed({
        name: "OPENAI_API_KEY",
        provider: "openai",
        plaintext: "sk-live",
        ...state,
      });
      const denied = await linkProviderKey(context.dependencies, {
        authorization: context.tenancy.grant(),
        intake: intake(),
      });
      expect(denied.ok).toBe(false);
    }
  });

  it("refuses a duplicate label BEFORE it resolves the credential", async () => {
    const context = buildProvidersTestContext();
    context.repository.seedProviderKey(testProviderKey(context.scope, { label: "production" }));

    const denied = await linkProviderKey(context.dependencies, {
      authorization: context.tenancy.grant(),
      intake: intake(),
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PROVIDERS_KEY_ALREADY_EXISTS");
  });

  it("refuses a grant tenancy did not issue", async () => {
    const context = buildProvidersTestContext();
    const denied = await linkProviderKey(context.dependencies, {
      authorization: { principalType: "operator", access: "secret:mutate", scope: context.scope },
      intake: intake(),
    });
    expect(denied.ok).toBe(false);
  });

  it("refuses a metadata-only grant", async () => {
    const context = buildProvidersTestContext();
    context.secrets.seed({ name: "OPENAI_API_KEY", provider: "openai", plaintext: "sk-live" });
    const denied = await linkProviderKey(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      intake: intake(),
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PROVIDERS_SCOPE_MISMATCH");
  });
});

describe("registering material directly", () => {
  it("mints a credential and a key when nothing of that name exists", async () => {
    const context = buildProvidersTestContext();
    const registered = await registerProviderKey(context.dependencies, {
      authorization: context.tenancy.grant(),
      intake: intake(),
      plaintext: "sk-new",
    });
    if (!registered.ok) throw new Error(`unreachable: ${registered.error.code}`);
    const listed = await context.secrets.listCredentials();
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]?.provider).toBe("openai");
    expect(context.secrets.rotations).toEqual([]);
  });

  it("ROTATES rather than duplicates when a usable credential of that name exists", async () => {
    const context = buildProvidersTestContext();
    const existing = context.secrets.seed({
      name: "OPENAI_API_KEY",
      provider: "openai",
      plaintext: "sk-old",
    });
    const registered = await registerProviderKey(context.dependencies, {
      authorization: context.tenancy.grant(),
      intake: intake(),
      plaintext: "sk-new",
    });
    if (!registered.ok) throw new Error("unreachable");
    expect(context.secrets.rotations).toEqual([existing.id]);
  });

  it("refuses to rotate a credential of that name belonging to another provider", async () => {
    const context = buildProvidersTestContext();
    context.secrets.seed({ name: "OPENAI_API_KEY", provider: "anthropic", plaintext: "sk-old" });
    const denied = await registerProviderKey(context.dependencies, {
      authorization: context.tenancy.grant(),
      intake: intake(),
      plaintext: "sk-new",
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PROVIDERS_CREDENTIAL_UNAVAILABLE");
    expect(context.secrets.rotations).toEqual([]);
  });

  it("REVOKES a freshly minted credential when the key write then fails", async () => {
    const context = buildProvidersTestContext();
    context.repository.failNextProviderKeyInsert();

    const denied = await registerProviderKey(context.dependencies, {
      authorization: context.tenancy.grant(),
      intake: intake(),
      plaintext: "sk-new",
    });
    expect(denied.ok).toBe(false);
    // The credential it minted is gone again: nothing points at it, so undoing
    // the vault half is total and leaves the environment as it was.
    expect(context.secrets.revocations).toHaveLength(1);
    expect(context.repository.allProviderKeys()).toEqual([]);
  });

  it("does NOT undo a rotation when the key write fails — the material really changed", async () => {
    const context = buildProvidersTestContext();
    const existing = context.secrets.seed({
      name: "OPENAI_API_KEY",
      provider: "openai",
      plaintext: "sk-old",
    });
    context.repository.failNextProviderKeyInsert();

    const denied = await registerProviderKey(context.dependencies, {
      authorization: context.tenancy.grant(),
      intake: intake(),
      plaintext: "sk-new",
    });
    expect(denied.ok).toBe(false);
    expect(context.secrets.rotations).toEqual([existing.id]);
    // Nothing is revoked: the operator asked for the material to change, it has
    // changed, and any other key pointing at this credential now uses it.
    expect(context.secrets.revocations).toEqual([]);
  });

  it("refuses an empty or oversized secret without touching the vault", async () => {
    const context = buildProvidersTestContext();
    for (const plaintext of ["", "x".repeat(16_385), undefined]) {
      const denied = await registerProviderKey(context.dependencies, {
        authorization: context.tenancy.grant(),
        intake: intake(),
        plaintext,
      });
      expect(denied.ok).toBe(false);
    }
    const listed = await context.secrets.listCredentials();
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value).toEqual([]);
  });
});

describe("rotating and relinking", () => {
  it("rotates the material behind the key's own credential", async () => {
    const context = buildProvidersTestContext();
    const credential = context.secrets.seed({
      name: "OPENAI_API_KEY",
      provider: "openai",
      plaintext: "sk-old",
    });
    const key = context.repository.seedProviderKey(
      testProviderKey(context.scope, { credentialId: credential.id }),
    );

    const rotated = await rotateProviderKeySecret(context.dependencies, {
      authorization: context.tenancy.grant(),
      providerKeyId: key.providerKeyId,
      plaintext: "sk-new",
    });
    if (!rotated.ok) throw new Error(`unreachable: ${rotated.error.code}`);
    expect(context.secrets.rotations).toEqual([credential.id]);
    expect(context.probeCache.forgotten).toEqual([OPENAI]);
  });

  it("refuses to rotate when the key's credential no longer matches it", async () => {
    const context = buildProvidersTestContext();
    const credential = context.secrets.seed({
      name: "SOMETHING_ELSE",
      provider: "openai",
      plaintext: "sk-old",
    });
    const key = context.repository.seedProviderKey(
      testProviderKey(context.scope, { credentialId: credential.id }),
    );
    const denied = await rotateProviderKeySecret(context.dependencies, {
      authorization: context.tenancy.grant(),
      providerKeyId: key.providerKeyId,
      plaintext: "sk-new",
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PROVIDERS_CREDENTIAL_UNAVAILABLE");
    expect(context.secrets.rotations).toEqual([]);
  });

  it("relinks to another credential and reports what it pointed at before", async () => {
    const context = buildProvidersTestContext();
    const first = context.secrets.seed({
      name: "OPENAI_API_KEY",
      provider: "openai",
      plaintext: "sk-a",
    });
    const second = context.secrets.seed({
      name: "OPENAI_API_KEY_2",
      provider: "openai",
      plaintext: "sk-b",
    });
    const key = context.repository.seedProviderKey(
      testProviderKey(context.scope, { credentialId: first.id }),
    );

    const relinked = await relinkProviderKey(context.dependencies, {
      authorization: context.tenancy.grant(),
      providerKeyId: key.providerKeyId,
      credentialName: "OPENAI_API_KEY_2",
      label: "renamed",
    });
    if (!relinked.ok) throw new Error(`unreachable: ${relinked.error.code}`);
    expect(relinked.value.key.credentialId).toBe(second.id);
    expect(relinked.value.key.label).toBe("renamed");
    expect(relinked.value.previousCredentialName).toBe("OPENAI_API_KEY");
    // Relinking touches no material at all.
    expect(context.secrets.rotations).toEqual([]);
  });
});

describe("updating a key", () => {
  it("promotes a key and demotes the incumbent in one transaction", async () => {
    const context = buildProvidersTestContext();
    context.repository.seedProviderKey(
      testProviderKey(context.scope, {
        providerKeyId: asProvidersIdentifier<ProviderKeyId>("incumbent"),
        label: "staging",
        isDefault: true,
      }),
    );
    const candidate = context.repository.seedProviderKey(
      testProviderKey(context.scope, {
        providerKeyId: asProvidersIdentifier<ProviderKeyId>("candidate"),
        label: "production",
        isDefault: false,
      }),
    );

    const promoted = await updateProviderKey(context.dependencies, {
      authorization: context.tenancy.grant(),
      providerKeyId: candidate.providerKeyId,
      patch: { isDefault: true },
    });
    if (!promoted.ok) throw new Error(`unreachable: ${promoted.error.code}`);
    const defaults = context.repository
      .allProviderKeys()
      .filter((key) => key.isDefault)
      .map((key) => key.providerKeyId);
    expect(defaults).toEqual(["candidate"]);
    // The demotion and the promotion shared ONE transaction handle.
    expect(new Set(context.repository.transactions).size).toBe(1);
  });

  it("does not take the demotion path when the key is already the default", async () => {
    const context = buildProvidersTestContext();
    const key = context.repository.seedProviderKey(
      testProviderKey(context.scope, { isDefault: true }),
    );
    const patched = await updateProviderKey(context.dependencies, {
      authorization: context.tenancy.grant(),
      providerKeyId: key.providerKeyId,
      patch: { isDefault: true, label: "renamed" },
    });
    if (!patched.ok) throw new Error("unreachable");
    expect(patched.value.isDefault).toBe(true);
    expect(patched.value.label).toBe("renamed");
  });

  it("refuses a rename onto a label another key already holds", async () => {
    const context = buildProvidersTestContext();
    context.repository.seedProviderKey(
      testProviderKey(context.scope, {
        providerKeyId: asProvidersIdentifier<ProviderKeyId>("held"),
        label: "taken",
      }),
    );
    const key = context.repository.seedProviderKey(
      testProviderKey(context.scope, {
        providerKeyId: asProvidersIdentifier<ProviderKeyId>("mine"),
        label: "mine",
      }),
    );
    const denied = await updateProviderKey(context.dependencies, {
      authorization: context.tenancy.grant(),
      providerKeyId: key.providerKeyId,
      patch: { label: "taken" },
    });
    expect(denied.ok).toBe(false);
  });
});

describe("deleting a key", () => {
  it("removes the link and leaves the credential alone", async () => {
    const context = buildProvidersTestContext();
    const credential = context.secrets.seed({
      name: "OPENAI_API_KEY",
      provider: "openai",
      plaintext: "sk-live",
    });
    const key = context.repository.seedProviderKey(
      testProviderKey(context.scope, { credentialId: credential.id }),
    );

    const removed = await deleteProviderKey(context.dependencies, {
      authorization: context.tenancy.grant(),
      providerKeyId: key.providerKeyId,
    });
    if (!removed.ok) throw new Error("unreachable");
    expect(context.repository.allProviderKeys()).toEqual([]);
    expect(context.secrets.revocations).toEqual([]);
  });

  it("refuses while an agent version still pins it, and says how many", async () => {
    const context = buildProvidersTestContext();
    const key = context.repository.seedProviderKey(testProviderKey(context.scope));
    context.repository.pinKey(key.providerKeyId, 3);

    const denied = await deleteProviderKey(context.dependencies, {
      authorization: context.tenancy.grant(),
      providerKeyId: key.providerKeyId,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("PROVIDERS_KEY_PINNED_BY_AGENTS");
    expect(denied.error.details.pinnedAgents).toBe(3);
    expect(context.repository.allProviderKeys()).toHaveLength(1);
  });
});

