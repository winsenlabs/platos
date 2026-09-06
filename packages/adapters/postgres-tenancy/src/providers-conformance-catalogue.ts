// The installation-global half of the conformance scenario: `Model` and
// `ModelPrice`.
//
// A SEPARATE FILE FOR A SEPARATE SCOPING REGIME. Every step in
// `providers-conformance.ts` takes an `EnvironmentScope`; not one step here
// does, because these two rows have none. Keeping them together would have put
// a call with a scope next to one without and made the missing argument look
// like an oversight rather than the port's decision.
//
// THE PRICE STEPS ARE WHERE THE TWO STORES ARE LEAST ALIKE, and the scenario is
// built around the three places they could quietly disagree:
//
//   THE RATE ROUND TRIP. A `TokenRate` is an exact integer count of pico-USD in
//   a bigint; the column is `Decimal(24, 12)`. The double keeps the bigint it
//   was handed and can never lose a digit. The database is the only side where
//   the crossing happens at all, so the cards below carry rates at the EDGES of
//   the grid — a twelve-decimal-place value whose last digit is significant, and
//   a value large enough that a JavaScript `number` could not hold it — and a
//   store that went through `number` returns a different bigint.
//
//   `UNAVAILABLE` IS NOT ZERO. One rate on the first card is unknown, with a
//   zero value and a null `sourceRef`. `ModelPrice_rate_check` allows exactly
//   that combination and refuses a KNOWN rate with a null reference, which is
//   the second card's fourth rate before the guard catches it.
//
//   THE APPEND-ONLY CLASH. A second card at an instant already taken must be
//   REFUSED — never converted into an update and never shifted to the next free
//   instant. The double compares instants in a list; the database has a unique
//   index and three rules that make the update the port forbids impossible
//   anyway.

import type {
  ModelFacts,
  ProviderId,
  ModelId,
  ModelKey,
  ModelPriceSnapshot,
  PriceCard,
  RateBook,
  RateEntry,
  RateSource,
  Result,
  TokenRate,
} from "@platos/context-providers/application/ports/index.js";
import {
  asProvidersIdentifier,
  rateFromDecimalString,
} from "@platos/context-providers/application/ports/index.js";
import { runResult } from "@platos/context-providers/application/ports/index.js";

import type { MintedIds, ProvidersConformanceEnvironment } from "./providers-conformance.js";

const OBSERVED = new Date("2026-04-01T00:00:00.000Z");
const VERIFIED_AT = new Date("2026-04-15T00:00:00.000Z");
const FIRST_EFFECTIVE = new Date("2026-01-01T00:00:00.000Z");
const SECOND_EFFECTIVE = new Date("2026-06-01T00:00:00.000Z");
const BETWEEN = new Date("2026-03-01T00:00:00.000Z");
const AFTER_BOTH = new Date("2026-07-01T00:00:00.000Z");

const FIRST_KEY = asProvidersIdentifier<ModelKey>("anthropic:claude-haiku-4-5-20251001");
const SECOND_KEY = asProvidersIdentifier<ModelKey>("openai:gpt-5-mini");
const ABSENT_KEY = asProvidersIdentifier<ModelKey>("google-vertex:gemini-nothing");

/**
 * A rate from its canonical decimal form.
 *
 * The fixture goes through `rateFromDecimalString` rather than through a bigint
 * literal so the value in the source reads as the price it is, and so a rate the
 * type refuses is a fixture error rather than a silent zero.
 */
function rate(value: string): TokenRate {
  const parsed = rateFromDecimalString(value);
  if (!parsed.ok) throw new Error(`fixture rate ${value} is not representable`);
  return parsed.value;
}

function entry(
  value: string,
  source: RateSource,
  observedAt: Date,
  sourceRef: string | null,
): RateEntry {
  return { rate: rate(value), source, observedAt, sourceRef };
}

/**
 * The first card: three known rates and one nobody could find.
 *
 * `cacheWrite` is `UNAVAILABLE` with a zero value and no reference — the exact
 * combination `ModelPrice_rate_check` permits and `chargeableRate` refuses to
 * bill a non-zero token count against.
 *
 * `input` is quoted to the LAST place of the `Decimal(24, 12)` grid. A store
 * that crossed the boundary through a JavaScript `number` cannot round-trip it:
 * a binary float carries about fifteen safe significant digits.
 */
const FIRST_CARD: PriceCard = {
  effectiveFrom: FIRST_EFFECTIVE,
  rates: {
    input: entry("0.000000800001", "LITELLM", OBSERVED, "litellm@2026-04-01"),
    output: entry("0.000004000000", "LITELLM", OBSERVED, "litellm@2026-04-01"),
    cacheRead: entry("0.000000080000", "LITELLM", OBSERVED, "litellm@2026-04-01"),
    cacheWrite: entry("0", "UNAVAILABLE", OBSERVED, null),
  },
};

/** The correction: a later date, a verified rate, and a value near the ceiling. */
const SECOND_CARD: PriceCard = {
  effectiveFrom: SECOND_EFFECTIVE,
  rates: {
    input: entry("0.000000900000", "VERIFIED_PROVIDER", VERIFIED_AT, "anthropic pricing page"),
    output: entry("0.000004500000", "VERIFIED_PROVIDER", VERIFIED_AT, "anthropic pricing page"),
    cacheRead: entry("0.000000090000", "LITELLM", OBSERVED, "litellm@2026-04-01"),
    // Eleven whole USD per token is absurd as a price and is here as a DOMAIN
    // probe: `999999999999.999999999999` is the largest value `Decimal(24, 12)`
    // holds, and a store that narrowed anywhere on the way in loses its tail.
    cacheWrite: entry("999999999999.999999999999", "LITELLM", OBSERVED, "litellm@2026-04-01"),
  },
};

function facts(provider: string, name: string, sourceUpdatedAt: Date): ModelFacts {
  return {
    provider: asProvidersIdentifier<ProviderId>(provider),
    name,
    displayName: `${name} (display)`,
    description: null,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    capabilities: ["text", "tools"],
    releaseDate: new Date("2025-10-01T00:00:00.000Z"),
    deprecationDate: null,
    baseModelName: null,
    sourceUpdatedAt,
  };
}

/** Snapshots in a deterministic order, for a port that says ordering is the caller's. */
function sortedSnapshots(result: Result<readonly ModelPriceSnapshot[]>): unknown {
  if (!result.ok) return result;
  return {
    ok: true,
    value: [...result.value].sort((left, right) => {
      if (left.modelKey !== right.modelKey) return left.modelKey < right.modelKey ? -1 : 1;
      return left.effectiveFrom.getTime() - right.effectiveFrom.getTime();
    }),
  };
}

export async function runCatalogueConformance(
  environment: ProvidersConformanceEnvironment,
  record: (name: string, value: unknown) => void,
  minted: MintedIds,
): Promise<void> {
  const { repository } = environment;

  record("modelBeforeInsert", await repository.findModelByKey(FIRST_KEY));

  const first = await runResult(environment, (transaction) =>
    repository.upsertModel(FIRST_KEY, facts("anthropic", "claude-haiku-4-5-20251001", OBSERVED), transaction),
  );
  if (first.ok) minted.register(first.value.modelId);
  record("upsertModel", first);
  record("findModelAfterUpsert", await repository.findModelByKey(FIRST_KEY));
  record("findAbsentModel", await repository.findModelByKey(ABSENT_KEY));

  // THE SECOND PASS. Facts changed and `sourceUpdatedAt` moved; the identity
  // must not. The normaliser preserves exactly that: a store that minted a
  // fresh id here reports `minted#2` where the other reports `minted#1`.
  const again = await runResult(environment, (transaction) =>
    repository.upsertModel(
      FIRST_KEY,
      { ...facts("anthropic", "claude-haiku-4-5-20251001", VERIFIED_AT), contextWindow: 500_000 },
      transaction,
    ),
  );
  if (again.ok) minted.register(again.value.modelId);
  record("upsertModelAgain", again);

  const second = await runResult(environment, (transaction) =>
    repository.upsertModel(SECOND_KEY, facts("openai", "gpt-5-mini", OBSERVED), transaction),
  );
  if (second.ok) minted.register(second.value.modelId);
  record("upsertSecondModel", second);

  const modelId = first.ok ? first.value.modelId : asProvidersIdentifier<ModelId>("unreachable");
  const secondModelId = second.ok ? second.value.modelId : asProvidersIdentifier<ModelId>("unreachable");

  record("latestPriceBeforeAnyCard", await repository.findLatestPrice(modelId));

  const firstCard = await runResult(environment, (transaction) =>
    repository.insertPrice(modelId, FIRST_CARD, transaction),
  );
  if (firstCard.ok) minted.register(firstCard.value.modelPriceId);
  record("insertFirstCard", firstCard);

  // THE APPEND-ONLY CLASH: the same model at the same instant, with DIFFERENT
  // rates. Refused, and the store must not have written anything — which
  // `latestPriceAfterClash` shows.
  record(
    "insertDuplicateInstant",
    await runResult(environment, (transaction) =>
      repository.insertPrice(
        modelId,
        { ...SECOND_CARD, effectiveFrom: FIRST_EFFECTIVE },
        transaction,
      ),
    ),
  );
  record("latestPriceAfterClash", await repository.findLatestPrice(modelId));

  const laterCard = await runResult(environment, (transaction) =>
    repository.insertPrice(modelId, SECOND_CARD, transaction),
  );
  if (laterCard.ok) minted.register(laterCard.value.modelPriceId);
  record("insertLaterCard", laterCard);
  record("latestPrice", await repository.findLatestPrice(modelId));

  const otherCard = await runResult(environment, (transaction) =>
    repository.insertPrice(secondModelId, FIRST_CARD, transaction),
  );
  if (otherCard.ok) minted.register(otherCard.value.modelPriceId);
  record("insertCardForSecondModel", otherCard);

  // BEFORE the second card's date: only the first is in force. AFTER it: both
  // are returned, because the port hands the caller every card in force and
  // `selectByKeyPrecedence` decides by KEY order rather than by date.
  record(
    "pricesBetweenTheTwoDates",
    sortedSnapshots(await repository.findPricesForKeys([FIRST_KEY], BETWEEN)),
  );
  record(
    "pricesAfterBothDates",
    sortedSnapshots(await repository.findPricesForKeys([FIRST_KEY], AFTER_BOTH)),
  );
  record(
    "pricesForBothKeys",
    sortedSnapshots(await repository.findPricesForKeys([FIRST_KEY, SECOND_KEY], AFTER_BOTH)),
  );
  record(
    "pricesForAbsentKey",
    sortedSnapshots(await repository.findPricesForKeys([ABSENT_KEY], AFTER_BOTH)),
  );
  record(
    "pricesBeforeEveryCard",
    sortedSnapshots(
      await repository.findPricesForKeys([FIRST_KEY, SECOND_KEY], new Date("2025-01-01T00:00:00.000Z")),
    ),
  );
}

/** Re-exported so a suite can assert against the same values the scenario used. */
export const CONFORMANCE_CARDS: {
  readonly first: PriceCard;
  readonly second: PriceCard;
  readonly firstKey: ModelKey;
  readonly secondKey: ModelKey;
  readonly rates: (card: PriceCard) => RateBook;
} = {
  first: FIRST_CARD,
  second: SECOND_CARD,
  firstKey: FIRST_KEY,
  secondKey: SECOND_KEY,
  rates: (card) => card.rates,
};
