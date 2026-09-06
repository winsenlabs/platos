// Each of `ProviderKey`'s five database rules, standing beside the guard or the
// store method that meets it.
//
// THE PAIRING IS THE POINT. For every write-shape guard there are two cases: the
// guard refuses the value with a NAMED code, and PostgreSQL refuses the SAME
// value when the guard is stepped around with a raw statement. A guard that
// drifted looser is caught by the second half going green when it should be red;
// one that drifted tighter is caught by the conformance differential going red
// on a value the database accepts.
//
// NOT ONE of the rules below is in `schema.prisma`, so not one is in the
// generated client's types; and not one is in `InMemoryProvidersRepository`, so
// not one is in any use-case suite in the tree. That is the whole reason this
// file exists: the double this context ships stores any `credentialId` at all,
// and every provider key in every use-case suite in the repository was written
// against it.
//
// `Model` AND `ModelPrice` ARE NEXT DOOR, in
// `providers-catalogue-constraints.integration.test.ts`, and the seam is the
// port's own: these four rules are ENVIRONMENT-SCOPED and every case here needs
// a tenant chain and a credential, while not one case there needs a scope at
// all. The split is also what the §6 budget asked for — one file measured 491
// effective lines, inside the warning band and heading for the 500-line ERROR.
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
import { runResult } from "@platos/context-providers/application/ports/index.js";

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
      runResult(harness.base.adapter.unitOfWork, (transaction) =>
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
    const refused = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.repository.insertProviderKey(
        key({
          providerKeyId: asProvidersIdentifier<ProviderKeyId>(uuid("0002")),
          label: "wrong provider",
          credentialId: asProvidersIdentifier<CredentialId>(other),
        }),
        transaction,
      ),
    );
    // The rule's subject, in the CONTEXT's own vocabulary: from the
    // operator's position the credential they named does not exist here, for
    // this provider.
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "PROVIDERS_CREDENTIAL_UNAVAILABLE" },
    });
  });

  test("a credential whose NAME does not match environmentKeyName is refused too", async () => {
    // The rule compares FOUR columns, and this is the pair the double could
    // never model: `ProviderKey.environmentKeyName` must equal
    // `Credential.name`. A key that named the right credential id and the wrong
    // reference name would otherwise resolve to a credential the operator never
    // pointed it at.
    const refused = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
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
    const written = await runResult(harness.base.adapter.unitOfWork, async (transaction) => {
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
    await runResult(harness.base.adapter.unitOfWork, (transaction) =>
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
    const written = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
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
    // `environmentId`, so the rule has nothing to refuse. A key handed to it
    // carrying another environment's id writes ZERO rows and reports "no such
    // provider key" — the same answer an id that does not exist gets, which is
    // the answer a foreign id deserves.
    const elsewhere = await harness.freshScope();
    const moved = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
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

describe("WHICH unique index refused, established by reading", () => {
  test("an identifier already in use is NOT reported as a label conflict", () => {
    // The disambiguation's FIRST read, and the one the port has no code for. A
    // caller minting an identifier that is already taken has made a defect, not
    // a business conflict, and telling it the LABEL was taken would send an
    // operator to rename a key that is not the problem.
    //
    // It is a read rather than a driver error because only two of this table's
    // three unique indexes are in `schema.prisma`: the client can map those two
    // back to field names and has no model of the partial one at all.
    return runResult(
      harness.base.adapter.unitOfWork,
      (transaction) =>
        harness.repository.insertProviderKey(
          key({
            // The id `the partial index refuses a second default` already wrote.
            providerKeyId: asProvidersIdentifier<ProviderKeyId>(uuid("0006")),
            label: "a different label entirely",
          }),
          transaction,
        ),
      )
      .then((refused) => {
        expect(refused).toMatchObject({
          ok: false,
          error: {
            code: "PROVIDERS_REPOSITORY_UNAVAILABLE",
            details: { reason: "provider key id already exists" },
          },
        });
      });
  });

  test("a key claiming a second default is told about the DEFAULT, not its own label", async () => {
    // The disambiguation's `excluding` clause. An UPDATE that promotes a second
    // default violates the partial index; the label read that follows must
    // EXCLUDE the row being updated, or it finds the row's own label and reports
    // a conflict with itself — the right refusal for the wrong reason, and one an
    // operator would act on by renaming.
    const refused = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.repository.updateProviderKey(
        key({
          providerKeyId: asProvidersIdentifier<ProviderKeyId>(uuid("0008")),
          label: "not the default",
          isDefault: true,
        }),
        transaction,
      ),
    );
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "PROVIDERS_KEY_ALREADY_EXISTS", details: { label: "default" } },
    });
  });
});

describe("the instant and page-window guards", () => {
  test("an Invalid Date is refused before it reaches the driver", async () => {
    await expect(
      runResult(harness.base.adapter.unitOfWork, (transaction) =>
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
