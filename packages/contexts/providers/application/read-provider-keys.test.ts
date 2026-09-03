import { describe, expect, it } from "vitest";

import { asProvidersIdentifier, type ProviderKeyId } from "../domain/index.js";
import { deleteProviderKey } from "./delete-provider-key.js";
import { describeProviderKey, listProviderKeys, pageProviderKeys } from "./read-provider-keys.js";
import {
  buildProvidersTestContext,
  otherEnvironment,
  testEnvironmentScope,
  testProviderKey,
} from "./testing/index.js";

describe("cross-tenant denial", () => {
  it("cannot see, describe or delete a key belonging to another environment", async () => {
    const context = buildProvidersTestContext();
    const elsewhere = testProviderKey(otherEnvironment(), {
      providerKeyId: asProvidersIdentifier<ProviderKeyId>("theirs"),
    });
    context.repository.seedProviderKey(elsewhere);

    const listed = await listProviderKeys(context.dependencies, {
      authorization: context.tenancy.grant(),
    });
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value).toEqual([]);

    const described = await describeProviderKey(context.dependencies, {
      authorization: context.tenancy.grant(),
      providerKeyId: elsewhere.providerKeyId,
    });
    expect(described.ok).toBe(false);
    if (described.ok) throw new Error("unreachable");
    expect(described.error.code).toBe("PROVIDERS_KEY_NOT_FOUND");

    const removed = await deleteProviderKey(context.dependencies, {
      authorization: context.tenancy.grant(),
      providerKeyId: elsewhere.providerKeyId,
    });
    expect(removed.ok).toBe(false);
    expect(context.repository.allProviderKeys()).toHaveLength(1);
  });
});

describe("listing and paging", () => {
  it("clamps a page size and refuses a negative offset", async () => {
    const context = buildProvidersTestContext();
    for (let index = 0; index < 5; index += 1) {
      context.repository.seedProviderKey(
        testProviderKey(context.scope, {
          providerKeyId: asProvidersIdentifier<ProviderKeyId>(`key-${index}`),
          label: `label-${index}`,
          isDefault: false,
        }),
      );
    }
    const page = await pageProviderKeys(context.dependencies, {
      authorization: context.tenancy.grant(),
      limit: 10_000,
      offset: -5,
    });
    if (!page.ok) throw new Error("unreachable");
    expect(page.value.items).toHaveLength(5);
    expect(page.value.total).toBe(5);
  });

  it("treats a blank search and a blank provider filter as no filter", async () => {
    const context = buildProvidersTestContext();
    context.repository.seedProviderKey(testProviderKey(context.scope));
    const page = await pageProviderKeys(context.dependencies, {
      authorization: context.tenancy.grant(),
      limit: 10,
      offset: 0,
      search: "   ",
      provider: "  ",
    });
    if (!page.ok) throw new Error("unreachable");
    expect(page.value.total).toBe(1);
  });

  it("narrows on a substring of the label, the provider or the credential name", async () => {
    const context = buildProvidersTestContext();
    context.repository.seedProviderKey(testProviderKey(context.scope, { label: "eu-west" }));
    context.repository.seedProviderKey(
      testProviderKey(context.scope, {
        providerKeyId: asProvidersIdentifier<ProviderKeyId>("key-2"),
        label: "us-east",
        isDefault: false,
      }),
    );
    const page = await pageProviderKeys(context.dependencies, {
      authorization: context.tenancy.grant(),
      limit: 10,
      offset: 0,
      search: "EU-",
    });
    if (!page.ok) throw new Error("unreachable");
    expect(page.value.items.map((key) => key.label)).toEqual(["eu-west"]);
  });

  it("uses the environment from the grant and never a supplied one", async () => {
    const context = buildProvidersTestContext();
    context.repository.seedProviderKey(testProviderKey(context.scope));
    const listed = await listProviderKeys(context.dependencies, {
      authorization: context.tenancy.grant("metadata", testEnvironmentScope("env-1")),
    });
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value).toHaveLength(1);
  });
});
