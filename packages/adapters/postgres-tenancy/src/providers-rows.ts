// The crossing between `providers`' four canonical rows and its four aggregates.
//
// ONE FILE FOR BOTH DIRECTIONS, so a column that is read and a column that is
// written cannot drift apart: `writeProviderKey` and `readProviderKey` are
// beside each other and a reader can see that `credentialName` is the column
// `environmentKeyName` in both.
//
// A ROW THIS BINARY CANNOT READ IS A REFUSAL, NEVER A GUESS. Two columns on
// `ModelPrice` can hold a value the running release does not understand:
// `ModelRateSource` is a PostgreSQL enum a later migration may widen, and the
// four `Decimal(24, 12)` rate columns are read back as text that `rate.ts` has
// to parse exactly. Substituting `UNAVAILABLE` for an unknown source would
// silently make a priced turn free, and substituting `ZERO_RATE` for an
// unparseable decimal would silently make it free in a different way — both are
// the failure `price-card.ts`'s "`UNAVAILABLE` IS NOT ZERO" note exists to
// prevent. So an unreadable row raises, with the column named.
//
// THE RATE CROSSING GOES THROUGH `rate.ts` AND NOWHERE ELSE.
// `rateFromDecimalString` and `rateToDecimalString` are exact and mutually
// inverse on the `Decimal(24, 12)` grid, and that file's own header records why
// the extraction source's `number` path was not: it rounds once, at the end,
// after the float sum has already drifted, and `cost.test.ts` pins a live rate
// card where the drift — not the price — decides the rounding. A store that
// multiplied by `1e12` here would put that defect back at the boundary the type
// exists to protect.

import {
  asProvidersIdentifier,
  isRateSource,
  rateFromDecimalString,
  rateToDecimalString,
  RATE_NAMES,
  RATE_SOURCES,
  type ActorId,
  type CredentialId,
  type CredentialName,
  type EnvironmentId,
  type EnvironmentProviderId,
  type Model,
  type ModelFacts,
  type ModelId,
  type ModelKey,
  type ModelPrice,
  type ModelPriceId,
  type ModelPriceSnapshot,
  type PriceCard,
  type ProviderId,
  type ProviderKey,
  type ProviderKeyId,
  type ProviderLink,
  type RateBook,
  type RateEntry,
  type RateName,
  type RateSource,
} from "@platos/context-providers/application/ports/index.js";

import {
  requireInstant,
  requireInstantOrNull,
  requireModelIntegerOrNull,
  requireRateInDomain,
  requireRateProvenance,
  requireRateSource,
  requireUuid,
} from "./providers-guards.js";

/** A `ModelRateSource` value the running binary has never heard of. */
export const UNKNOWN_RATE_SOURCE = "providers.row.unknown_rate_source";

/** A `Decimal(24, 12)` column whose text form `rate.ts` refused. */
export const UNREADABLE_RATE = "providers.row.unreadable_rate";

export class UnreadableProvidersRowError extends Error {
  readonly code: string;
  readonly column: string;

  constructor(code: string, column: string, message: string) {
    super(message);
    this.name = "UnreadableProvidersRowError";
    this.code = code;
    this.column = column;
  }
}

// --- ProviderKey -------------------------------------------------------------

export interface ProviderKeyRow {
  readonly id: string;
  readonly environmentId: string;
  readonly credentialId: string;
  readonly provider: string;
  readonly label: string;
  readonly environmentKeyName: string;
  readonly isDefault: boolean;
  readonly createdBy: string;
  readonly lastUsedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function readProviderKey(row: ProviderKeyRow): ProviderKey {
  return {
    providerKeyId: asProvidersIdentifier<ProviderKeyId>(row.id),
    environmentId: asProvidersIdentifier<EnvironmentId>(row.environmentId),
    credentialId: asProvidersIdentifier<CredentialId>(row.credentialId),
    provider: asProvidersIdentifier<ProviderId>(row.provider),
    label: row.label,
    // The column is `environmentKeyName` and the field is `credentialName`.
    // `identifiers.ts` says why the field is named that way: it is a name in the
    // environment's own credential namespace, "never a process variable", and
    // the column's name is the one thing that suggests otherwise.
    credentialName: asProvidersIdentifier<CredentialName>(row.environmentKeyName),
    isDefault: row.isDefault,
    createdBy: asProvidersIdentifier<ActorId>(row.createdBy),
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function writeProviderKey(key: ProviderKey): ProviderKeyRow {
  return {
    id: requireUuid("ProviderKey.id", key.providerKeyId),
    environmentId: requireUuid("ProviderKey.environmentId", key.environmentId),
    credentialId: requireUuid("ProviderKey.credentialId", key.credentialId),
    provider: key.provider,
    label: key.label,
    environmentKeyName: key.credentialName,
    isDefault: key.isDefault,
    createdBy: key.createdBy,
    lastUsedAt: requireInstantOrNull("ProviderKey.lastUsedAt", key.lastUsedAt),
    createdAt: requireInstant("ProviderKey.createdAt", key.createdAt),
    updatedAt: requireInstant("ProviderKey.updatedAt", key.updatedAt),
  };
}

// --- EnvironmentProvider -----------------------------------------------------

export interface ProviderLinkRow {
  readonly id: string;
  readonly environmentId: string;
  readonly providerId: string;
  readonly enabled: boolean;
  readonly linkedAt: Date;
  readonly updatedAt: Date;
}

export function readProviderLink(row: ProviderLinkRow): ProviderLink {
  return {
    environmentProviderId: asProvidersIdentifier<EnvironmentProviderId>(row.id),
    environmentId: asProvidersIdentifier<EnvironmentId>(row.environmentId),
    // `EnvironmentProvider.providerId` is the same value as
    // `ProviderKey.provider` and `Model.provider` under a third column name.
    // `identifiers.ts` names all four places it must agree.
    provider: asProvidersIdentifier<ProviderId>(row.providerId),
    enabled: row.enabled,
    linkedAt: row.linkedAt,
    updatedAt: row.updatedAt,
  };
}

export function writeProviderLink(link: ProviderLink): ProviderLinkRow {
  return {
    id: requireUuid("EnvironmentProvider.id", link.environmentProviderId),
    environmentId: requireUuid("EnvironmentProvider.environmentId", link.environmentId),
    providerId: link.provider,
    enabled: link.enabled,
    linkedAt: requireInstant("EnvironmentProvider.linkedAt", link.linkedAt),
    updatedAt: requireInstant("EnvironmentProvider.updatedAt", link.updatedAt),
  };
}

// --- Model -------------------------------------------------------------------

export interface ModelRow {
  readonly id: string;
  readonly key: string;
  readonly provider: string;
  readonly name: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  readonly capabilities: readonly string[];
  readonly releaseDate: Date | null;
  readonly deprecationDate: Date | null;
  readonly baseModelName: string | null;
  readonly isHidden: boolean;
  readonly sourceUpdatedAt: Date;
}

export function readModel(row: ModelRow): Model {
  return {
    modelId: asProvidersIdentifier<ModelId>(row.id),
    key: asProvidersIdentifier<ModelKey>(row.key),
    provider: asProvidersIdentifier<ProviderId>(row.provider),
    name: row.name,
    displayName: row.displayName,
    description: row.description,
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
    // A fresh array rather than the driver's own: `Model.capabilities` is
    // `readonly string[]` and the row's array is the client's mutable one, so
    // handing it out would give a caller a handle on the decoded row.
    capabilities: [...row.capabilities],
    releaseDate: row.releaseDate,
    deprecationDate: row.deprecationDate,
    baseModelName: row.baseModelName,
    isHidden: row.isHidden,
    sourceUpdatedAt: row.sourceUpdatedAt,
  };
}

/**
 * The mutable half of a model identity, as `upsertModel` writes it.
 *
 * `isHidden` is deliberately NOT here. `ModelFacts` omits it, and the column has
 * a `DEFAULT false` — so an insert leaves the default and an update leaves
 * whatever an operator set. A catalogue pass that wrote `isHidden: false` would
 * un-hide every model an operator had hidden, on every pass.
 */
export function writeModelFacts(facts: ModelFacts): Omit<ModelRow, "id" | "key" | "isHidden"> {
  return {
    provider: facts.provider,
    name: facts.name,
    displayName: facts.displayName,
    description: facts.description,
    contextWindow: requireModelIntegerOrNull("Model.contextWindow", facts.contextWindow),
    maxOutputTokens: requireModelIntegerOrNull("Model.maxOutputTokens", facts.maxOutputTokens),
    capabilities: [...facts.capabilities],
    releaseDate: requireInstantOrNull("Model.releaseDate", facts.releaseDate),
    deprecationDate: requireInstantOrNull("Model.deprecationDate", facts.deprecationDate),
    baseModelName: facts.baseModelName,
    sourceUpdatedAt: requireInstant("Model.sourceUpdatedAt", facts.sourceUpdatedAt),
  };
}

// --- ModelPrice --------------------------------------------------------------

/**
 * The four rates as sixteen columns.
 *
 * The card carries `rate`, `source`, `observedAt` and `sourceRef` PER RATE and
 * the table spells each of the four out, so the crossing is a fixed name pattern
 * rather than a loop over a JSON document. `price-card.ts` says why the
 * provenance is per rate: a card is routinely assembled from two origins, and
 * collapsing it to the card would erase which rate was verified.
 */
const RATE_COLUMNS: {
  readonly [Name in RateName]: {
    readonly rate: string;
    readonly source: string;
    readonly observedAt: string;
    readonly sourceRef: string;
  };
} = {
  input: {
    rate: "inputRate",
    source: "inputSource",
    observedAt: "inputObservedAt",
    sourceRef: "inputSourceRef",
  },
  output: {
    rate: "outputRate",
    source: "outputSource",
    observedAt: "outputObservedAt",
    sourceRef: "outputSourceRef",
  },
  cacheRead: {
    rate: "cacheReadRate",
    source: "cacheReadSource",
    observedAt: "cacheReadObservedAt",
    sourceRef: "cacheReadSourceRef",
  },
  cacheWrite: {
    rate: "cacheWriteRate",
    source: "cacheWriteSource",
    observedAt: "cacheWriteObservedAt",
    sourceRef: "cacheWriteSourceRef",
  },
};

/** Every column name a `ModelPrice` read or write touches, in one place. */
export function rateColumns(name: RateName): {
  readonly rate: string;
  readonly source: string;
  readonly observedAt: string;
  readonly sourceRef: string;
} {
  return RATE_COLUMNS[name];
}

/** What the driver hands back for a `Decimal` column: something stringable. */
type DecimalValue = { toString(): string };

export type ModelPriceRow = {
  readonly id: string;
  readonly modelId: string;
  readonly effectiveFrom: Date;
} & { readonly [column: string]: unknown };

function readRate(row: ModelPriceRow, name: RateName): RateEntry {
  const columns = RATE_COLUMNS[name];
  const raw = row[columns.rate] as DecimalValue;
  const parsed = rateFromDecimalString(String(raw));
  if (!parsed.ok) {
    throw new UnreadableProvidersRowError(
      UNREADABLE_RATE,
      columns.rate,
      `ModelPrice.${columns.rate} holds ${JSON.stringify(String(raw))}, which is not a rate this binary can read`,
    );
  }
  const source = String(row[columns.source]);
  if (!isRateSource(source)) {
    // NOT collapsed to `UNAVAILABLE`. A source this release does not know is a
    // row a later release wrote, and pricing a turn against a rate whose
    // provenance we cannot read is exactly the silent zero `price-card.ts`
    // refuses.
    throw new UnreadableProvidersRowError(
      UNKNOWN_RATE_SOURCE,
      columns.source,
      `ModelPrice.${columns.source} holds ${JSON.stringify(source)}, which is not a ModelRateSource this binary knows`,
    );
  }
  return {
    rate: parsed.value,
    source: source as RateSource,
    observedAt: row[columns.observedAt] as Date,
    sourceRef: (row[columns.sourceRef] as string | null) ?? null,
  };
}

export function readRateBook(row: ModelPriceRow): RateBook {
  return {
    input: readRate(row, "input"),
    output: readRate(row, "output"),
    cacheRead: readRate(row, "cacheRead"),
    cacheWrite: readRate(row, "cacheWrite"),
  };
}

export function readModelPrice(row: ModelPriceRow): ModelPrice {
  return {
    modelPriceId: asProvidersIdentifier<ModelPriceId>(row.id),
    modelId: asProvidersIdentifier<ModelId>(row.modelId),
    effectiveFrom: row.effectiveFrom,
    rates: readRateBook(row),
  };
}

/** A card joined to the model identity `findPricesForKeys` returns it with. */
export function readModelPriceSnapshot(
  row: ModelPriceRow,
  model: { readonly key: string; readonly provider: string; readonly name: string },
): ModelPriceSnapshot {
  return {
    ...readModelPrice(row),
    modelKey: asProvidersIdentifier<ModelKey>(model.key),
    provider: asProvidersIdentifier<ProviderId>(model.provider),
    modelName: model.name,
  };
}

/**
 * The sixteen rate columns of an insert, as strings on the exact decimal grid.
 *
 * The rate goes to the driver as `rateToDecimalString(...)` — the canonical
 * `Decimal(24, 12)` form — rather than as a number, because a `number` cannot
 * round-trip a 24-digit decimal and the column would store whatever the binary
 * float happened to be nearest to.
 */
/**
 * The sixteen rate columns, NAMED rather than as an index signature.
 *
 * A `Record<string, …>` would have compiled here and been refused by the
 * driver's own generated input type, which demands every one of the sixteen by
 * name: the shape is what proves at COMPILE time that a rate has not been left
 * out, which is the one mistake on this row that cannot be corrected afterwards
 * — `reject_model_price_mutation` refuses UPDATE, DELETE and TRUNCATE outright.
 */
export interface RateColumnValues {
  readonly inputRate: string;
  readonly outputRate: string;
  readonly cacheReadRate: string;
  readonly cacheWriteRate: string;
  readonly inputSource: RateSource;
  readonly outputSource: RateSource;
  readonly cacheReadSource: RateSource;
  readonly cacheWriteSource: RateSource;
  readonly inputObservedAt: Date;
  readonly outputObservedAt: Date;
  readonly cacheReadObservedAt: Date;
  readonly cacheWriteObservedAt: Date;
  readonly inputSourceRef: string | null;
  readonly outputSourceRef: string | null;
  readonly cacheReadSourceRef: string | null;
  readonly cacheWriteSourceRef: string | null;
}

export function writeRateBook(rates: RateBook): RateColumnValues {
  const written: Record<string, string | Date | null> = {};
  for (const name of RATE_NAMES) {
    const columns = RATE_COLUMNS[name];
    const entry = rates[name];
    // Three guards over one CHECK, in the order the CHECK reads: the range, the
    // enum, then the provenance clause. `ModelPrice_rate_check` reports only its
    // own name for any of the three, and they have three different fixes.
    requireRateInDomain(`ModelPrice.${columns.rate}`, entry.rate.picoUsdPerToken);
    requireRateSource(`ModelPrice.${columns.source}`, entry.source, RATE_SOURCES);
    requireRateProvenance(`ModelPrice.${columns.sourceRef}`, entry.source, entry.sourceRef);
    written[columns.rate] = rateToDecimalString(entry.rate);
    written[columns.source] = entry.source;
    written[columns.observedAt] = requireInstant(`ModelPrice.${columns.observedAt}`, entry.observedAt);
    written[columns.sourceRef] = entry.sourceRef;
  }
  // The cast is over a value this function has just built from a CLOSED list of
  // four names crossed with four column roles, so every field of the interface
  // above is present by construction. It is here because a loop cannot narrow a
  // computed key, and the alternative — sixteen literal assignments — is the
  // form where one of them can be forgotten.
  return written as unknown as RateColumnValues;
}

/**
 * The whole insert row for one card, keyed by a caller-supplied identifier.
 *
 * `insertPrice` does NOT use this: it omits the id so the column's own
 * `@default(uuid())` mints one, because the port hands no identifier for a card.
 * It is here for the constraint suites, which need to write a card at a KNOWN id
 * in order to assert that the immutability triggers refuse to touch it again.
 */
export function writeModelPrice(
  modelPriceId: string,
  modelId: string,
  card: PriceCard,
): RateColumnValues & { readonly id: string; readonly modelId: string; readonly effectiveFrom: Date } {
  return {
    id: requireUuid("ModelPrice.id", modelPriceId),
    modelId: requireUuid("ModelPrice.modelId", modelId),
    effectiveFrom: requireInstant("ModelPrice.effectiveFrom", card.effectiveFrom),
    ...writeRateBook(card.rates),
  };
}
