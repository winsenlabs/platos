// Each write-shape guard, standing beside the migration-only rule it restates.
//
// THE PAIRING IS THE POINT. For every guard in `providers-guards.ts` there are
// two cases: the guard refuses the value with a NAMED code, and PostgreSQL
// refuses the SAME value when the guard is stepped around with a raw statement.
// A guard that drifted looser is caught by the second half going green when it
// should be red; one that drifted tighter is caught by the conformance
// differential going red on a value the database accepts.
//
// NOT ONE of the rules below is in `schema.prisma`, so not one is in the
// generated client's types; and not one is in `InMemoryProvidersRepository`, so
// not one is in any use-case suite in the tree. That is the whole reason this
// file exists: the double this context ships mints values PostgreSQL refuses —
// a `VERIFIED_PROVIDER` rate with no source reference, a context window of four
// billion, a `credentialId` pointing at nothing — and every one of them
// type-checks.
//
// It FAILS when Docker is absent rather than skipping.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  ActorId,
  CredentialId,
  CredentialName,
  EnvironmentScope,
  ModelId,
  ModelKey,
  PriceCard,
  ProviderId,
  ProviderKey,
  ProviderKeyId,
  RateBook,
} from "@platos/context-providers/application/ports/index.js";
import {
  asProvidersIdentifier,
  rateFromDecimalString,
} from "@platos/context-providers/application/ports/index.js";

import {
  IDENTIFIER_NOT_UUID,
  INSTANT_NOT_REPRESENTABLE,
  MODEL_INTEGER_OUT_OF_RANGE,
  PAGE_WINDOW_INVALID,
  RATE_OUT_OF_DOMAIN,
  RATE_PROVENANCE_MISSING,
} from "./providers-guards.js";
import type { ProvidersHarness } from "./providers-harness.js";
import { startProvidersHarness } from "./providers-harness.js";

let harness: ProvidersHarness;
let scope: EnvironmentScope;
let credentialId: string;

const AT = new Date("2026-05-01T09:00:00.000Z");
const ANTHROPIC = asProvidersIdentifier<ProviderId>("anthropic");

function uuid(slot: string): string {
  return `cb000000-${slot}-4000-8000-000000000000`;
}

function rate(value: string): { readonly picoUsdPerToken: bigint } {
  const parsed = rateFromDecimalString(value);
  if (!parsed.ok) throw new Error(`fixture rate ${value} is not representable`);
  return parsed.value;
}

/** A card whose four rates are all known and all reference their source. */
function card(effectiveFrom: Date, overrides: Partial<RateBook> = {}): PriceCard {
  const known = {
    rate: rate("0.000001000000"),
    source: "LITELLM" as const,
    observedAt: AT,
    sourceRef: "litellm@2026-05-01",
  };
  return {
    effectiveFrom,
    rates: {
      input: known,
      output: known,
      cacheRead: known,
      cacheWrite: known,
      ...overrides,
    },
  };
}

function key(overrides: Partial<ProviderKey> = {}): ProviderKey {
  return {
    providerKeyId: asProvidersIdentifier<ProviderKeyId>(uuid("0001")),
    environmentId: scope.environmentId,
    credentialId: asProvidersIdentifier<CredentialId>(credentialId),
    provider: ANTHROPIC,
    label: "primary",
    credentialName: asProvidersIdentifier<CredentialName>("ANTHROPIC_PRIMARY"),
    isDefault: false,
    createdBy: asProvidersIdentifier<ActorId>("operator-1"),
    lastUsedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

beforeAll(async () => {
  harness = await startProvidersHarness();
  scope = await harness.freshScope();
  credentialId = await harness.seedCredential(scope, {
    provider: "anthropic",
    name: "ANTHROPIC_PRIMARY",
  });
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("the uuid guard and the uuid columns behind it", () => {
  test("the guard refuses a value that is not a uuid", async () => {
    await expect(
      harness.base.adapter.unitOfWork.run((transaction) =>
        harness.repository.insertProviderKey(
          key({ providerKeyId: asProvidersIdentifier<ProviderKeyId>("not-a-uuid") }),
          transaction,
        ),
      ),
    ).rejects.toMatchObject({ code: IDENTIFIER_NOT_UUID, column: "ProviderKey.id" });
  });

  test("PostgreSQL refuses the same value when the guard is stepped around", async () => {
    // The column PARSES the value rather than storing the bytes it was given,
    // which is why the braced and `urn:uuid:` forms are refused by the guard
    // too: the column would store the UNWRAPPED value and a later read would
    // not compare equal to what the caller wrote.
    await expect(
      harness.base.client.$executeRawUnsafe(
        `INSERT INTO "ProviderKey" ("id", "environmentId", "credentialId", "provider", "label",
           "environmentKeyName", "isDefault", "createdBy", "createdAt", "updatedAt")
         VALUES ('not-a-uuid', '${scope.environmentId}', '${credentialId}', 'anthropic', 'raw',
                 'ANTHROPIC_PRIMARY', false, 'operator-1', now(), now())`,
      ),
    ).rejects.toThrow();
  });
});

describe("ProviderKey_credential_provider_integrity", () => {
  test("a credential belonging to another provider is refused, as unavailable", async () => {
    const other = await harness.seedCredential(scope, {
      provider: "openai",
      name: "OPENAI_ELSEWHERE",
    });
    const refused = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.insertProviderKey(
        key({
          providerKeyId: asProvidersIdentifier<ProviderKeyId>(uuid("0002")),
          label: "wrong provider",
          credentialId: asProvidersIdentifier<CredentialId>(other),
        }),
        transaction,
      ),
    );
    // The trigger's subject, in the CONTEXT's own vocabulary: from the
    // operator's position the credential they named does not exist here, for
    // this provider.
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "PROVIDERS_CREDENTIAL_UNAVAILABLE" },
    });
  });

  test("a credential whose NAME does not match environmentKeyName is refused too", async () => {
    // The trigger compares FOUR columns, and this is the pair the double could
    // never model: `ProviderKey.environmentKeyName` must equal
    // `Credential.name`. A key that named the right credential id and the wrong
    // reference name would otherwise resolve to a credential the operator never
    // pointed it at.
    const refused = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.insertProviderKey(
        key({
          providerKeyId: asProvidersIdentifier<ProviderKeyId>(uuid("0003")),
          label: "wrong name",
          credentialName: asProvidersIdentifier<CredentialName>("ANTHROPIC_SOMETHING_ELSE"),
        }),
        transaction,
      ),
    );
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "PROVIDERS_CREDENTIAL_UNAVAILABLE" },
    });
  });

  test("the refusal left the caller's transaction usable", async () => {
    // The savepoint, proven from the outside: a write made AFTER a refusal in
    // the same transaction lands. Without `ROLLBACK TO SAVEPOINT` the refusal
    // would have aborted the transaction and this second write would fail.
    const written = await harness.base.adapter.unitOfWork.run(async (transaction) => {
      const refused = await harness.repository.insertProviderKey(
        key({
          providerKeyId: asProvidersIdentifier<ProviderKeyId>(uuid("0004")),
          label: "doomed",
          credentialName: asProvidersIdentifier<CredentialName>("NOT_THE_CREDENTIAL_NAME"),
        }),
        transaction,
      );
      expect(refused.ok).toBe(false);
      return harness.repository.insertProviderKey(
        key({
          providerKeyId: asProvidersIdentifier<ProviderKeyId>(uuid("0005")),
          label: "after the refusal",
        }),
        transaction,
      );
    });
    expect(written.ok).toBe(true);
    const found = await harness.repository.findProviderKey(
      scope,
      asProvidersIdentifier<ProviderKeyId>(uuid("0005")),
    );
    expect(found).toMatchObject({ ok: true, value: { label: "after the refusal" } });
  });
});

describe("ProviderKey_one_default_per_environment_provider", () => {
  test("the partial index refuses a second default even from a raw statement", async () => {
    await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.insertProviderKey(
        key({
          providerKeyId: asProvidersIdentifier<ProviderKeyId>(uuid("0006")),
          label: "the default",
          isDefault: true,
        }),
        transaction,
      ),
    );
    await expect(
      harness.base.client.$executeRawUnsafe(
        `INSERT INTO "ProviderKey" ("id", "environmentId", "credentialId", "provider", "label",
           "environmentKeyName", "isDefault", "createdBy", "createdAt", "updatedAt")
         VALUES ('${uuid("0007")}', '${scope.environmentId}', '${credentialId}', 'anthropic',
                 'second default', 'ANTHROPIC_PRIMARY', true, 'operator-1', now(), now())`,
      ),
    ).rejects.toThrow();
  });

  test("but a second NON-default is fine, which is what makes the index PARTIAL", async () => {
    // The negative control. An index on `(environmentId, provider)` without the
    // `WHERE "isDefault" = TRUE` clause would refuse this too, and the store's
    // whole reason for existing — several keys per provider per environment —
    // would be gone.
    const written = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.insertProviderKey(
        key({
          providerKeyId: asProvidersIdentifier<ProviderKeyId>(uuid("0008")),
          label: "not the default",
          isDefault: false,
        }),
        transaction,
      ),
    );
    expect(written.ok).toBe(true);
  });
});

describe("ProviderKey_owner_immutable", () => {
  test("a raw UPDATE that moves the row to another environment is refused", async () => {
    const elsewhere = await harness.freshScope();
    await expect(
      harness.base.client.$executeRawUnsafe(
        `UPDATE "ProviderKey" SET "environmentId" = '${elsewhere.environmentId}'
          WHERE "id" = '${uuid("0006")}'`,
      ),
    ).rejects.toThrow();
  });

  test("the store cannot reach that rule at all, and that is the claim", async () => {
    // `updateProviderKey` keys on BOTH id and environmentId and never writes
    // `environmentId`, so the trigger has nothing to refuse. A key handed to it
    // carrying another environment's id writes ZERO rows and reports "no such
    // provider key" — the same answer an id that does not exist gets, which is
    // the answer a foreign id deserves.
    const elsewhere = await harness.freshScope();
    const moved = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.updateProviderKey(
        key({
          providerKeyId: asProvidersIdentifier<ProviderKeyId>(uuid("0006")),
          environmentId: elsewhere.environmentId,
          label: "the default",
          isDefault: true,
        }),
        transaction,
      ),
    );
    expect(moved).toMatchObject({
      ok: false,
      error: { code: "PROVIDERS_REPOSITORY_UNAVAILABLE", details: { reason: "no such provider key" } },
    });
  });
});

describe("ModelPrice_rate_check", () => {
  let modelId: string;

  beforeAll(async () => {
    const model = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.upsertModel(
        asProvidersIdentifier<ModelKey>("anthropic:constraint-model"),
        {
          provider: ANTHROPIC,
          name: "constraint-model",
          displayName: null,
          description: null,
          contextWindow: 1000,
          maxOutputTokens: 100,
          capabilities: [],
          releaseDate: null,
          deprecationDate: null,
          baseModelName: null,
          sourceUpdatedAt: AT,
        },
        transaction,
      ),
    );
    if (!model.ok) throw new Error("the fixture model could not be written");
    modelId = model.value.modelId;
  }, 120_000);

  test("the guard refuses a KNOWN rate that names no source", async () => {
    await expect(
      harness.base.adapter.unitOfWork.run((transaction) =>
        harness.repository.insertPrice(
          asProvidersIdentifier<ModelId>(modelId),
          card(new Date("2026-01-01T00:00:00.000Z"), {
            output: {
              rate: rate("0.000002000000"),
              source: "VERIFIED_PROVIDER",
              observedAt: AT,
              sourceRef: null,
            },
          }),
          transaction,
        ),
      ),
    ).rejects.toMatchObject({
      code: RATE_PROVENANCE_MISSING,
      column: "ModelPrice.outputSourceRef",
    });
  });

  test("PostgreSQL refuses the same row when the guard is stepped around", async () => {
    await expect(
      harness.base.client.$executeRawUnsafe(
        `INSERT INTO "ModelPrice" ("id", "modelId", "effectiveFrom",
           "inputRate", "outputRate", "cacheReadRate", "cacheWriteRate",
           "inputSource", "outputSource", "cacheReadSource", "cacheWriteSource",
           "inputObservedAt", "outputObservedAt", "cacheReadObservedAt", "cacheWriteObservedAt",
           "inputSourceRef", "outputSourceRef", "cacheReadSourceRef", "cacheWriteSourceRef")
         VALUES ('${uuid("0010")}', '${modelId}', '2026-01-01T00:00:00Z',
                 1, 1, 1, 1,
                 'LITELLM', 'VERIFIED_PROVIDER', 'LITELLM', 'LITELLM',
                 now(), now(), now(), now(),
                 'ref', NULL, 'ref', 'ref')`,
      ),
    ).rejects.toThrow();
  });

  test("an UNAVAILABLE rate with no reference is ACCEPTED, which is the other half", async () => {
    // The rule is one-directional and a guard that demanded a null reference
    // for an unavailable rate would be STRICTER than the database — the drift
    // a constraints suite written only as "the guard refuses what the CHECK
    // refuses" cannot see.
    const written = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.insertPrice(
        asProvidersIdentifier<ModelId>(modelId),
        card(new Date("2026-02-01T00:00:00.000Z"), {
          cacheWrite: { rate: rate("0"), source: "UNAVAILABLE", observedAt: AT, sourceRef: null },
        }),
        transaction,
      ),
    );
    expect(written.ok).toBe(true);
  });

  test("the guard refuses a rate outside the Decimal(24, 12) domain", async () => {
    await expect(
      harness.base.adapter.unitOfWork.run((transaction) =>
        harness.repository.insertPrice(
          asProvidersIdentifier<ModelId>(modelId),
          card(new Date("2026-03-01T00:00:00.000Z"), {
            input: {
              // `tokenRate()` refuses both of these; a `TokenRate` is a plain
              // readonly object, so a literal never went near the constructor.
              rate: { picoUsdPerToken: -1n },
              source: "LITELLM",
              observedAt: AT,
              sourceRef: "litellm",
            },
          }),
          transaction,
        ),
      ),
    ).rejects.toMatchObject({ code: RATE_OUT_OF_DOMAIN, column: "ModelPrice.inputRate" });
  });

  test("PostgreSQL refuses a negative rate when the guard is stepped around", async () => {
    await expect(
      harness.base.client.$executeRawUnsafe(
        `INSERT INTO "ModelPrice" ("id", "modelId", "effectiveFrom",
           "inputRate", "outputRate", "cacheReadRate", "cacheWriteRate",
           "inputSource", "outputSource", "cacheReadSource", "cacheWriteSource",
           "inputObservedAt", "outputObservedAt", "cacheReadObservedAt", "cacheWriteObservedAt",
           "inputSourceRef", "outputSourceRef", "cacheReadSourceRef", "cacheWriteSourceRef")
         VALUES ('${uuid("0011")}', '${modelId}', '2026-04-01T00:00:00Z',
                 -1, 1, 1, 1,
                 'LITELLM', 'LITELLM', 'LITELLM', 'LITELLM',
                 now(), now(), now(), now(),
                 'ref', 'ref', 'ref', 'ref')`,
      ),
    ).rejects.toThrow();
  });
});

describe("ModelPrice is append-only, and the database means it", () => {
  test("a raw UPDATE of a stored card is refused", async () => {
    const stored = await harness.base.client.modelPrice.findFirst({ select: { id: true } });
    expect(stored).not.toBeNull();
    await expect(
      harness.base.client.$executeRawUnsafe(
        `UPDATE "ModelPrice" SET "inputRate" = 2 WHERE "id" = '${stored?.id ?? ""}'`,
      ),
    ).rejects.toThrow();
  });

  test("a raw DELETE of a stored card is refused", async () => {
    const stored = await harness.base.client.modelPrice.findFirst({ select: { id: true } });
    await expect(
      harness.base.client.$executeRawUnsafe(
        `DELETE FROM "ModelPrice" WHERE "id" = '${stored?.id ?? ""}'`,
      ),
    ).rejects.toThrow();
  });
});

describe("Model's SECOND identity, which the port does not model", () => {
  test("two keys resolving to one provider and name are refused", async () => {
    // `@@unique([provider, name])` is a second identity `upsertModel` — keyed by
    // `key` — has no code for, and `InMemoryProvidersRepository` stores both
    // happily because its map is keyed by `key` alone. An alias published beside
    // its target is exactly this shape.
    const facts = {
      provider: ANTHROPIC,
      name: "shared-name",
      displayName: null,
      description: null,
      contextWindow: 1000,
      maxOutputTokens: 100,
      capabilities: [],
      releaseDate: null,
      deprecationDate: null,
      baseModelName: null,
      sourceUpdatedAt: AT,
    };
    const first = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.upsertModel(
        asProvidersIdentifier<ModelKey>("anthropic:shared-name"),
        facts,
        transaction,
      ),
    );
    expect(first.ok).toBe(true);
    const second = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.upsertModel(
        asProvidersIdentifier<ModelKey>("anthropic:shared-name-alias"),
        facts,
        transaction,
      ),
    );
    expect(second).toMatchObject({
      ok: false,
      error: {
        code: "PROVIDERS_REPOSITORY_UNAVAILABLE",
        details: { reason: "model provider and name already belong to another key" },
      },
    });
  });

  test("a card for a model that does not exist is refused by the foreign key", async () => {
    const refused = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.insertPrice(
        asProvidersIdentifier<ModelId>(uuid("00ff")),
        card(new Date("2026-05-01T00:00:00.000Z")),
        transaction,
      ),
    );
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "PROVIDERS_REPOSITORY_UNAVAILABLE", details: { reason: "no such model" } },
    });
  });
});

describe("Model's two INTEGER columns", () => {
  test("the guard refuses a context window the column cannot hold", async () => {
    await expect(
      harness.base.adapter.unitOfWork.run((transaction) =>
        harness.repository.upsertModel(
          asProvidersIdentifier<ModelKey>("anthropic:too-wide"),
          {
            provider: ANTHROPIC,
            name: "too-wide",
            displayName: null,
            description: null,
            // A catalogue that published a context window in BYTES.
            contextWindow: 4_000_000_000,
            maxOutputTokens: 100,
            capabilities: [],
            releaseDate: null,
            deprecationDate: null,
            baseModelName: null,
            sourceUpdatedAt: AT,
          },
          transaction,
        ),
      ),
    ).rejects.toMatchObject({
      code: MODEL_INTEGER_OUT_OF_RANGE,
      column: "Model.contextWindow",
    });
  });

  test("PostgreSQL refuses the same value when the guard is stepped around", async () => {
    await expect(
      harness.base.client.$executeRawUnsafe(
        `INSERT INTO "Model" ("id", "key", "provider", "name", "contextWindow", "sourceUpdatedAt",
           "createdAt", "updatedAt")
         VALUES ('${uuid("0012")}', 'anthropic:raw-too-wide', 'anthropic', 'raw-too-wide',
                 4000000000, now(), now(), now())`,
      ),
    ).rejects.toThrow();
  });
});

describe("the instant and page-window guards", () => {
  test("an Invalid Date is refused before it reaches the driver", async () => {
    await expect(
      harness.base.adapter.unitOfWork.run((transaction) =>
        harness.repository.insertProviderKey(
          key({
            providerKeyId: asProvidersIdentifier<ProviderKeyId>(uuid("0013")),
            label: "bad instant",
            createdAt: new Date("nonsense"),
          }),
          transaction,
        ),
      ),
    ).rejects.toMatchObject({
      code: INSTANT_NOT_REPRESENTABLE,
      column: "ProviderKey.createdAt",
    });
  });

  test("a negative page window is refused before it reaches skip and take", async () => {
    // The port's signature says `number`. `read-provider-keys.ts` clamps before
    // it gets here, and that is exactly why the check belongs here too: a second
    // caller of the port has no such clamp, and a negative `take` is a driver
    // error rather than an empty page.
    await expect(
      harness.repository.pageProviderKeys(scope, {
        limit: -1,
        offset: 0,
        provider: null,
        search: null,
      }),
    ).rejects.toMatchObject({ code: PAGE_WINDOW_INVALID, column: "limit" });
    await expect(
      harness.repository.pageProviderKeys(scope, {
        limit: 10,
        offset: -1,
        provider: null,
        search: null,
      }),
    ).rejects.toMatchObject({ code: PAGE_WINDOW_INVALID, column: "offset" });
  });
});
