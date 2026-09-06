// The crossing between `providers`' four rows and its four aggregates, without
// a database.
//
// WHAT A UNIT SUITE CAN CLAIM HERE, AND WHAT IT CANNOT. It cannot claim that a
// rate survives `Decimal(24, 12)` — only a real column can be asked that, and
// `providers-conformance.integration.test.ts` asks it. What it CAN claim is that
// the two directions of the crossing are inverse, that the column names on each
// side are the ones the schema uses, and that a row this binary cannot read
// RAISES with the column named instead of being guessed at.
//
// THE THREE COLUMN-NAME PAIRS ARE THE POINT OF THE FIRST HALF.
// `ProviderKey.environmentKeyName` is `ProviderKey.credentialName`,
// `EnvironmentProvider.providerId` is `ProviderLink.provider`, and `Model.key`
// is not `Model.name`. All three are plain `String` columns, all three read as
// ordinary prose in a log line, and swapping any two of them is silent — which
// is why `domain/identifiers.ts` brands them and why this file checks the
// mapping rather than assuming it.

import { describe, expect, test } from "vitest";

import type {
  EnvironmentProviderId,
  ModelFacts,
  ProviderKey,
  ProviderKeyId,
  ProviderLink,
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
  RATE_SOURCE_UNKNOWN,
  requireInstant,
  requireModelIntegerOrNull,
  requirePageWindow,
  requireRateInDomain,
  requireRateProvenance,
  requireRateSource,
  requireUuid,
} from "./providers-guards.js";
import {
  readModel,
  readModelPrice,
  readProviderKey,
  readProviderLink,
  UNKNOWN_RATE_SOURCE,
  UNREADABLE_RATE,
  writeModelFacts,
  writeModelPrice,
  writeProviderKey,
  writeProviderLink,
  writeRateBook,
  type ModelPriceRow,
} from "./providers-rows.js";

const AT = new Date("2026-05-01T09:00:00.000Z");
const OBSERVED = new Date("2026-04-01T00:00:00.000Z");

function uuid(slot: string): string {
  return `dd000000-${slot}-4000-8000-000000000000`;
}

function rate(value: string): { readonly picoUsdPerToken: bigint } {
  const parsed = rateFromDecimalString(value);
  if (!parsed.ok) throw new Error(`fixture rate ${value} is not representable`);
  return parsed.value;
}

const RATES: RateBook = {
  input: { rate: rate("0.000000800001"), source: "LITELLM", observedAt: OBSERVED, sourceRef: "ref" },
  output: { rate: rate("0.000004"), source: "LITELLM", observedAt: OBSERVED, sourceRef: "ref" },
  cacheRead: {
    rate: rate("0.00000008"),
    source: "VERIFIED_PROVIDER",
    observedAt: OBSERVED,
    sourceRef: "page",
  },
  cacheWrite: { rate: rate("0"), source: "UNAVAILABLE", observedAt: OBSERVED, sourceRef: null },
};

const KEY: ProviderKey = {
  providerKeyId: asProvidersIdentifier<ProviderKeyId>(uuid("0001")),
  environmentId: asProvidersIdentifier(uuid("0002")),
  credentialId: asProvidersIdentifier(uuid("0003")),
  provider: asProvidersIdentifier("anthropic"),
  label: "primary",
  credentialName: asProvidersIdentifier("ANTHROPIC_API_KEY"),
  isDefault: true,
  createdBy: asProvidersIdentifier("operator-1"),
  lastUsedAt: null,
  createdAt: AT,
  updatedAt: AT,
};

const FACTS: ModelFacts = {
  provider: asProvidersIdentifier("anthropic"),
  name: "claude-haiku-4-5-20251001",
  displayName: "Claude Haiku 4.5",
  description: null,
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  capabilities: ["text", "tools"],
  releaseDate: new Date("2025-10-01T00:00:00.000Z"),
  deprecationDate: null,
  baseModelName: null,
  sourceUpdatedAt: OBSERVED,
};

describe("the ProviderKey crossing", () => {
  test("the write goes to environmentKeyName and the read comes back as credentialName", () => {
    const row = writeProviderKey(KEY);
    // THE COLUMN, not the field. `identifiers.ts` says why the field is named
    // differently: it is a name in the environment's own credential namespace,
    // "never a process variable", and the column's name is the one thing that
    // suggests otherwise.
    expect(row.environmentKeyName).toBe("ANTHROPIC_API_KEY");
    expect(Object.keys(row)).not.toContain("credentialName");
    expect(readProviderKey(row)).toEqual(KEY);
  });

  test("a uuid column refuses a value that is not one, and names the column", () => {
    expect(() => writeProviderKey({ ...KEY, credentialId: asProvidersIdentifier("nope") })).toThrow(
      expect.objectContaining({ code: IDENTIFIER_NOT_UUID, column: "ProviderKey.credentialId" }),
    );
  });

  test("the braced and urn forms of a uuid are refused too", () => {
    // The column would store the UNWRAPPED value, so a later read would not
    // compare equal to the string the caller wrote and `findProviderKey` would
    // miss a row it had just inserted.
    expect(() => requireUuid("x", `{${uuid("0001")}}`)).toThrow();
    expect(() => requireUuid("x", `urn:uuid:${uuid("0001")}`)).toThrow();
    expect(requireUuid("x", uuid("0001").toUpperCase())).toBe(uuid("0001").toUpperCase());
  });

  test("an Invalid Date is refused with the column that carried it", () => {
    expect(() => writeProviderKey({ ...KEY, updatedAt: new Date("nonsense") })).toThrow(
      expect.objectContaining({
        code: INSTANT_NOT_REPRESENTABLE,
        column: "ProviderKey.updatedAt",
      }),
    );
    expect(requireInstant("x", AT)).toBe(AT);
  });
});

describe("the EnvironmentProvider crossing", () => {
  test("providerId on the column is provider on the aggregate", () => {
    const link: ProviderLink = {
      environmentProviderId: asProvidersIdentifier<EnvironmentProviderId>(uuid("0004")),
      environmentId: asProvidersIdentifier(uuid("0002")),
      provider: asProvidersIdentifier("anthropic"),
      enabled: false,
      linkedAt: AT,
      updatedAt: AT,
    };
    const row = writeProviderLink(link);
    expect(row.providerId).toBe("anthropic");
    expect(Object.keys(row)).not.toContain("provider");
    expect(readProviderLink(row)).toEqual(link);
  });
});

describe("the Model crossing", () => {
  test("isHidden is not written, so a catalogue pass cannot un-hide a model", () => {
    const written = writeModelFacts(FACTS);
    // `ModelFacts` omits `isHidden` because it is an OPERATOR's decision and not
    // a catalogue fact. A pass that wrote `false` would un-hide every hidden
    // model on every run.
    expect(Object.keys(written)).not.toContain("isHidden");
    expect(Object.keys(written)).not.toContain("key");
    expect(written.sourceUpdatedAt).toBe(OBSERVED);
  });

  test("the read hands back a COPY of the capabilities, not the row's own array", () => {
    const row = {
      id: uuid("0005"),
      key: "anthropic:claude-haiku-4-5-20251001",
      isHidden: false,
      ...writeModelFacts(FACTS),
    };
    const model = readModel(row);
    expect(model.capabilities).toEqual(["text", "tools"]);
    // A caller holding the decoded value must not have a handle on the row.
    expect(model.capabilities).not.toBe(row.capabilities);
  });

  test("a context window the INTEGER column cannot hold is refused", () => {
    expect(() => writeModelFacts({ ...FACTS, contextWindow: 4_000_000_000 })).toThrow(
      expect.objectContaining({
        code: MODEL_INTEGER_OUT_OF_RANGE,
        column: "Model.contextWindow",
      }),
    );
    expect(requireModelIntegerOrNull("x", null)).toBeNull();
    expect(requireModelIntegerOrNull("x", 2_147_483_647)).toBe(2_147_483_647);
  });
});

describe("the ModelPrice crossing", () => {
  test("every rate is written on the canonical Decimal(24, 12) grid", () => {
    const written = writeRateBook(RATES);
    // TWELVE decimal places, always, including the trailing zeros a `number`
    // would have dropped. The column round-trips this string exactly.
    expect(written.inputRate).toBe("0.000000800001");
    expect(written.outputRate).toBe("0.000004000000");
    expect(written.cacheReadRate).toBe("0.000000080000");
    expect(written.cacheWriteRate).toBe("0.000000000000");
    expect(written.cacheWriteSourceRef).toBeNull();
  });

  test("the sixteen rate columns are all present, by name", () => {
    // The shape is what proves at COMPILE time that a rate has not been left
    // out; this is the runtime half of the same claim, and it matters because
    // the row cannot be corrected afterwards — three triggers refuse UPDATE,
    // DELETE and TRUNCATE on `ModelPrice`.
    expect(Object.keys(writeRateBook(RATES)).sort()).toEqual([
      "cacheReadObservedAt",
      "cacheReadRate",
      "cacheReadSource",
      "cacheReadSourceRef",
      "cacheWriteObservedAt",
      "cacheWriteRate",
      "cacheWriteSource",
      "cacheWriteSourceRef",
      "inputObservedAt",
      "inputRate",
      "inputSource",
      "inputSourceRef",
      "outputObservedAt",
      "outputRate",
      "outputSource",
      "outputSourceRef",
    ]);
  });

  test("a written card reads back as the card that was written", () => {
    const row = writeModelPrice(uuid("0006"), uuid("0007"), {
      effectiveFrom: AT,
      rates: RATES,
    }) as unknown as ModelPriceRow;
    expect(readModelPrice(row)).toEqual({
      modelPriceId: uuid("0006"),
      modelId: uuid("0007"),
      effectiveFrom: AT,
      rates: RATES,
    });
  });

  test("a KNOWN rate with no source reference is refused, and an UNAVAILABLE one is not", () => {
    expect(() =>
      writeRateBook({
        ...RATES,
        output: { ...RATES.output, sourceRef: null },
      }),
    ).toThrow(
      expect.objectContaining({
        code: RATE_PROVENANCE_MISSING,
        column: "ModelPrice.outputSourceRef",
      }),
    );
    // The rule is ONE-DIRECTIONAL. An unavailable rate MAY carry a reference,
    // and a guard that demanded otherwise would be stricter than the database.
    expect(() =>
      writeRateBook({
        ...RATES,
        cacheWrite: { ...RATES.cacheWrite, sourceRef: "a note about why it is unknown" },
      }),
    ).not.toThrow();
    expect(() => requireRateProvenance("x", "UNAVAILABLE", null)).not.toThrow();
  });

  test("a rate outside the Decimal(24, 12) domain is refused at either end", () => {
    expect(() => requireRateInDomain("x", -1n)).toThrow(
      expect.objectContaining({ code: RATE_OUT_OF_DOMAIN }),
    );
    expect(() => requireRateInDomain("x", 10n ** 24n)).toThrow(
      expect.objectContaining({ code: RATE_OUT_OF_DOMAIN }),
    );
    // The largest value the column holds is accepted, so the guard is not
    // narrower than the column it is standing in for.
    expect(requireRateInDomain("x", 10n ** 24n - 1n)).toBe(10n ** 24n - 1n);
  });

  test("a source outside the enum is refused on the way in", () => {
    expect(() => requireRateSource("x", "GUESSED", ["LITELLM", "UNAVAILABLE"])).toThrow(
      expect.objectContaining({ code: RATE_SOURCE_UNKNOWN }),
    );
  });
});

describe("a row this binary cannot read RAISES rather than guessing", () => {
  test("an unknown rate source is not collapsed to UNAVAILABLE", () => {
    const row = {
      ...(writeModelPrice(uuid("0008"), uuid("0009"), { effectiveFrom: AT, rates: RATES }) as
        unknown as ModelPriceRow),
      inputSource: "SOME_FUTURE_SOURCE",
    } as unknown as ModelPriceRow;
    // Collapsing it would make a priced turn silently free, which is exactly the
    // failure `price-card.ts`'s "`UNAVAILABLE` IS NOT ZERO" note exists to
    // prevent — a rate nobody knows must FAIL a non-zero charge, not bill zero.
    expect(() => readModelPrice(row)).toThrow(
      expect.objectContaining({ code: UNKNOWN_RATE_SOURCE, column: "inputSource" }),
    );
  });

  test("a decimal the rate type refuses is not read as zero", () => {
    const row = {
      ...(writeModelPrice(uuid("000a"), uuid("000b"), { effectiveFrom: AT, rates: RATES }) as
        unknown as ModelPriceRow),
      outputRate: "not a number",
    } as unknown as ModelPriceRow;
    expect(() => readModelPrice(row)).toThrow(
      expect.objectContaining({ code: UNREADABLE_RATE, column: "outputRate" }),
    );
  });
});

describe("the page window", () => {
  test("a non-positive limit and a negative offset are refused separately", () => {
    expect(() => requirePageWindow(0, 0)).toThrow(
      expect.objectContaining({ code: PAGE_WINDOW_INVALID, column: "limit" }),
    );
    expect(() => requirePageWindow(10, -1)).toThrow(
      expect.objectContaining({ code: PAGE_WINDOW_INVALID, column: "offset" }),
    );
    expect(() => requirePageWindow(1, 0)).not.toThrow();
  });
});
