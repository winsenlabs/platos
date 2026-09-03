// Use case: read a public rate-card catalogue into `Model` and `ModelPrice`.
//
// THE CATALOGUE ARRIVES AS DATA. This use case fetches nothing. Whatever fetched
// it — a scheduled job, an operator upload, a fixture in a test — hands over a
// parsed document and the instant it was read. That is what makes the whole
// ingest exercisable in memory, and it is the difference between a rule and a
// side effect.
//
// A CARD IS APPENDED ONLY WHEN A PRICE FACT CHANGED. The catalogue is re-read on
// a schedule, so an unconditional append would add an identical row to every
// model on every pass and turn a price history into a heartbeat. `sameCard`
// decides, and its `observedAt` asymmetry — ignored for a catalogue rate,
// honoured for a verified one — is why that comparison is a domain rule rather
// than a deep-equal.
//
// A CORRECTION THE CATALOGUE DOES NOT MENTION IS STILL APPLIED. An operator can
// verify a price for a model the catalogue has never listed; the source
// synthesises an entry for it so the correction is not silently dropped, and so
// does this.
//
// ONE MODEL'S FAILURE DOES NOT ABANDON THE CATALOGUE. Thousands of entries are
// read in one pass and a single malformed key must not leave the rate card
// half-updated. Failures are counted and reported; the pass continues.

import { err, ok, type Result, type TransactionScope } from "@platos/kernel";

import {
  admitModelKey,
  coerceDate,
  coerceTokenCount,
  capabilitiesFor,
  overrideForCatalogueKey,
  providerForCatalogueEntry,
  rateBookFor,
  rateCardInvalid,
  sameCard,
  asProvidersIdentifier,
  overrideModelName,
  CATALOGUE_PROVIDER_PREFIX,
  VERIFIED_RATE_OVERRIDES,
  type ModelFacts,
  type ProviderId,
  type RateCardCatalogue,
  type RateCardEntry,
} from "../domain/index.js";
import type { ProvidersDependencies } from "./dependencies.js";

export interface IngestRateCardCommand {
  readonly catalogue: RateCardCatalogue;
  /** When the catalogue was read. Every rate it supplies is observed at this. */
  readonly readAt: Date;
}

export interface RateCardIngestReport {
  readonly modelsSeen: number;
  readonly pricesAppended: number;
  readonly unchanged: number;
  /** Keys this pass could not read. Named so the next pass can be checked. */
  readonly skipped: readonly string[];
}

/** Catalogue entries plus a synthetic one for every uncovered correction. */
export function entriesToIngest(catalogue: RateCardCatalogue): readonly (readonly [string, RateCardEntry])[] {
  const entries = Object.entries(catalogue).filter(
    ([key, entry]) => key.trim().length > 0 && entry !== null && typeof entry === "object",
  );
  const covered = new Set<string>();
  for (const [key, entry] of entries) {
    const provider = providerForCatalogueEntry(key, entry.litellm_provider ?? null);
    const override = overrideForCatalogueKey(key, provider);
    if (override !== null) covered.add(override.model);
  }
  const synthetic = VERIFIED_RATE_OVERRIDES.filter((override) => !covered.has(override.model)).map(
    (override) =>
      [
        overrideModelName(override),
        { litellm_provider: CATALOGUE_PROVIDER_PREFIX[override.provider] ?? override.provider },
      ] as const,
  );
  return [...entries, ...synthetic];
}

function factsFor(entry: RateCardEntry, key: string, provider: string, readAt: Date): ModelFacts {
  return {
    provider: asProvidersIdentifier<ProviderId>(provider),
    // The catalogue's key IS the model's name for a catalogue-sourced row.
    name: key,
    displayName: entry.model_name ?? null,
    description: entry.description ?? null,
    contextWindow: coerceTokenCount(entry.max_input_tokens) ?? coerceTokenCount(entry.max_tokens),
    maxOutputTokens: coerceTokenCount(entry.max_output_tokens),
    capabilities: capabilitiesFor(entry),
    releaseDate: coerceDate(entry.release_date),
    deprecationDate: coerceDate(entry.deprecation_date),
    baseModelName: null,
    sourceUpdatedAt: readAt,
  };
}

async function ingestOne(
  dependencies: ProvidersDependencies,
  key: string,
  entry: RateCardEntry,
  readAt: Date,
  transaction: TransactionScope,
): Promise<Result<"appended" | "unchanged">> {
  const modelKey = admitModelKey(key);
  if (!modelKey.ok) return err(modelKey.error);

  const provider = providerForCatalogueEntry(key, entry.litellm_provider ?? null);
  const override = overrideForCatalogueKey(key, provider);

  const model = await dependencies.repository.upsertModel(
    modelKey.value,
    factsFor(entry, key, provider, readAt),
    transaction,
  );
  if (!model.ok) return err(model.error);

  const rates = rateBookFor(entry, readAt, override);
  const latest = await dependencies.repository.findLatestPrice(model.value.modelId);
  if (!latest.ok) return err(latest.error);
  if (latest.value !== null && sameCard(latest.value.rates, rates)) return ok("unchanged");

  const appended = await dependencies.repository.insertPrice(
    model.value.modelId,
    { effectiveFrom: readAt, rates },
    transaction,
  );
  if (!appended.ok) return err(appended.error);
  return ok("appended");
}

export async function ingestRateCard(
  dependencies: ProvidersDependencies,
  command: IngestRateCardCommand,
): Promise<Result<RateCardIngestReport>> {
  if (Number.isNaN(command.readAt.getTime())) {
    return err(rateCardInvalid("readAt must be a valid instant"));
  }
  const entries = entriesToIngest(command.catalogue);

  return dependencies.unitOfWork.run(async (transaction) => {
    let pricesAppended = 0;
    let unchanged = 0;
    const skipped: string[] = [];

    for (const [key, entry] of entries) {
      const outcome = await ingestOne(dependencies, key, entry, command.readAt, transaction);
      if (!outcome.ok) {
        skipped.push(key);
        continue;
      }
      if (outcome.value === "appended") pricesAppended += 1;
      else unchanged += 1;
    }
    return ok({ modelsSeen: entries.length, pricesAppended, unchanged, skipped });
  });
}
