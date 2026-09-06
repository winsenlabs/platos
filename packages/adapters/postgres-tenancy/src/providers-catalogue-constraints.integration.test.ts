// `Model` and `ModelPrice`'s database rules, standing beside the guards that
// meet them.
//
// INSTALLATION-GLOBAL, WHICH IS WHY THIS IS A SEPARATE FILE. Not one case here
// takes an `EnvironmentScope`, because these two rows have none — the port says
// so outright — while every case in `providers-constraints.integration.test.ts`
// needs a tenant chain and a credential before it can write anything at all.
// The split is also what the ADR M0.3 §6 budget asked for: one file measured 491
// effective lines, inside the warning band and heading for the 500-line ERROR.
//
// THREE OF THESE RULES HAVE NO COUNTERPART IN THE PORT AT ALL.
// `ModelPrice_rate_check` refuses a KNOWN rate that names no source, and
// `InMemoryProvidersRepository.insertPrice` stores whatever `PriceCard` it is
// handed. `Model`'s `@@unique([provider, name])` is a SECOND identity
// `upsertModel` — keyed by `key` — has no code for, and the double's map is
// keyed by `key` alone so it stores both happily. And `ModelPrice`'s three
// immutability triggers refuse an UPDATE the port never makes, with the
// privileges revoked from PUBLIC on top.
//
// It FAILS when Docker is absent rather than skipping.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  ModelId,
  ModelKey,
  PriceCard,
  ProviderId,
  RateBook,
} from "@platos/context-providers/application/ports/index.js";
import {
  asProvidersIdentifier,
  rateFromDecimalString,
} from "@platos/context-providers/application/ports/index.js";

import { MODEL_INTEGER_OUT_OF_RANGE, RATE_OUT_OF_DOMAIN, RATE_PROVENANCE_MISSING } from "./providers-guards.js";
import type { ProvidersHarness } from "./providers-harness.js";
import { startProvidersHarness } from "./providers-harness.js";

let harness: ProvidersHarness;

const AT = new Date("2026-05-01T09:00:00.000Z");
const ANTHROPIC = asProvidersIdentifier<ProviderId>("anthropic");

function uuid(slot: string): string {
  return `ba000000-${slot}-4000-8000-000000000000`;
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

/** The facts every model in this file is written with. */
function facts(name: string): {
  readonly provider: ProviderId;
  readonly name: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  readonly capabilities: readonly string[];
  readonly releaseDate: Date | null;
  readonly deprecationDate: Date | null;
  readonly baseModelName: string | null;
  readonly sourceUpdatedAt: Date;
} {
  return {
    provider: ANTHROPIC,
    name,
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
}

beforeAll(async () => {
  harness = await startProvidersHarness();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("ModelPrice_rate_check", () => {
  let modelId: string;

  beforeAll(async () => {
    const model = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.upsertModel(
        asProvidersIdentifier<ModelKey>("anthropic:constraint-model"),
        facts("constraint-model"),
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
    const shared = facts("shared-name");
    const first = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.upsertModel(
        asProvidersIdentifier<ModelKey>("anthropic:shared-name"),
        shared,
        transaction,
      ),
    );
    expect(first.ok).toBe(true);
    const second = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.repository.upsertModel(
        asProvidersIdentifier<ModelKey>("anthropic:shared-name-alias"),
        shared,
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
          // A catalogue that published a context window in BYTES.
          { ...facts("too-wide"), contextWindow: 4_000_000_000 },
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
