// The `Model` and `ModelPrice` half of `ProvidersRepository` —
// INSTALLATION-GLOBAL, and the half whose rows outlive every tenant that reads
// them.
//
// NO SCOPE PARAMETER, AND THAT IS THE PORT'S DECISION RATHER THAN AN OMISSION.
// `providers-repository.ts` states it: "what a model is, and what it cost on a
// given date, do not vary by tenant. Giving them a scope parameter would be a
// lie that invites an environment-filtered price lookup which silently finds
// nothing." So there is no `scopedWhere` in this file, and its absence is the
// one thing about it a reviewer should check hardest.
//
// `ModelPrice` IS APPEND-ONLY AND THE DATABASE MEANS IT. Three triggers reject
// UPDATE, DELETE and TRUNCATE outright and all three privileges are revoked from
// PUBLIC, so a card written wrong cannot be corrected — only superseded by a
// later-dated one. The port says the same thing from the other side:
// `insertPrice` "MUST surface a violation as `PROVIDERS_PRICE_REVISION_CONFLICT`
// and MUST NOT convert the insert into an update or shift the effective date to
// the next free instant." An `upsert` here would satisfy the type and be refused
// by the database, which is the better of the two failures but still the wrong
// statement.
//
// `Model` CARRIES TWO UNIQUE INDEXES AND THE PORT NAMES ONE. `upsertModel` is
// keyed by `key`, and `@@unique([provider, name])` is a SECOND identity the same
// row has to keep. Two catalogue keys that resolve to one provider-and-name —
// an alias and its target, published as separate entries — are a conflict the
// port has no code for and `InMemoryProvidersRepository` cannot produce at all:
// its map is keyed by `key` alone, so it happily stores both.

import type {
  Model,
  ModelFacts,
  ModelId,
  ModelKey,
  ModelPrice,
  ModelPriceSnapshot,
  PriceCard,
  Result,
  TransactionScope,
} from "@platos/context-providers/application/ports/index.js";
import {
  err,
  ok,
  priceRevisionConflict,
  repositoryUnavailable,
  type DomainError,
} from "@platos/context-providers/application/ports/index.js";

import {
  namesConstraint,
  providersRefusable,
  sqlstateOf,
  FOREIGN_KEY_VIOLATION,
  UNIQUE_VIOLATION,
} from "./providers-guards.js";
import {
  readModel,
  readModelPrice,
  readModelPriceSnapshot,
  writeModelFacts,
  writeRateBook,
  type ModelPriceRow,
  type ModelRow,
} from "./providers-rows.js";
import type { TenancyTransactions } from "./transaction.js";

const MODEL_COLUMNS = {
  id: true,
  key: true,
  provider: true,
  name: true,
  displayName: true,
  description: true,
  contextWindow: true,
  maxOutputTokens: true,
  capabilities: true,
  releaseDate: true,
  deprecationDate: true,
  baseModelName: true,
  isHidden: true,
  sourceUpdatedAt: true,
} as const;

/**
 * The sixteen rate columns plus the three the card is keyed by.
 *
 * Spelled out rather than taken as the whole row, for the reason every other
 * store in this directory names its columns: `createdAt` is on the table and is
 * on no aggregate, and a `select`-less read would hand a decoder a field it has
 * no home for the day somebody adds one.
 */
const PRICE_COLUMNS = {
  id: true,
  modelId: true,
  effectiveFrom: true,
  inputRate: true,
  outputRate: true,
  cacheReadRate: true,
  cacheWriteRate: true,
  inputSource: true,
  outputSource: true,
  cacheReadSource: true,
  cacheWriteSource: true,
  inputObservedAt: true,
  outputObservedAt: true,
  cacheReadObservedAt: true,
  cacheWriteObservedAt: true,
  inputSourceRef: true,
  outputSourceRef: true,
  cacheReadSourceRef: true,
  cacheWriteSourceRef: true,
} as const;

/** One card and the model identity it is returned with, from the joined read. */
type JoinedPriceRow = ModelPriceRow & {
  readonly modelKey: string;
  readonly modelProvider: string;
  readonly modelName: string;
};

export interface ProviderCatalogueStore {
  findModelByKey(key: ModelKey): Promise<Result<Model | null>>;
  upsertModel(key: ModelKey, facts: ModelFacts, transaction: TransactionScope): Promise<Result<Model>>;
  findLatestPrice(modelId: ModelId): Promise<Result<ModelPrice | null>>;
  insertPrice(
    modelId: ModelId,
    card: PriceCard,
    transaction: TransactionScope,
  ): Promise<Result<ModelPrice>>;
  findPricesForKeys(keys: readonly string[], at: Date): Promise<Result<readonly ModelPriceSnapshot[]>>;
}

export function createProviderCatalogueStore(
  transactions: TenancyTransactions,
): ProviderCatalogueStore {
  return {
    async findModelByKey(key: ModelKey): Promise<Result<Model | null>> {
      const row = await transactions.reader().model.findUnique({
        // `findUnique` is right HERE and wrong on every scoped read in this
        // tranche: `Model.key` is installation-wide unique and there is no scope
        // to leak a row across.
        where: { key },
        select: MODEL_COLUMNS,
      });
      return ok(row === null ? null : readModel(row as ModelRow));
    },

    async upsertModel(
      key: ModelKey,
      facts: ModelFacts,
      transaction: TransactionScope,
    ): Promise<Result<Model>> {
      const client = transactions.writer(transaction);
      const written = writeModelFacts(facts);
      const outcome = await providersRefusable(
        client,
        () =>
          client.model.upsert({
            where: { key },
            // `id` is omitted so the column's own `@default(uuid())` mints it.
            // The port hands no identifier for a model and inventing one here
            // would put a second source of model ids in the system.
            create: { key, ...written, capabilities: [...written.capabilities] },
            // `isHidden` is NOT in either branch. `ModelFacts` omits it because
            // it is an OPERATOR's decision and not a catalogue fact, and a pass
            // that wrote `false` would un-hide every hidden model on every run.
            //
            // `sourceUpdatedAt` IS written even when nothing else changed: the
            // port says so, and it is how an operator tells a stale catalogue
            // from a stable one.
            update: { ...written, capabilities: { set: [...written.capabilities] } },
            select: MODEL_COLUMNS,
          }),
        (error): DomainError | null => {
          if (sqlstateOf(error) !== UNIQUE_VIOLATION) return null;
          if (namesConstraint(error, "provider,name") || namesConstraint(error, "Model_provider_name_key")) {
            // THE SECOND IDENTITY, which the port does not model and the double
            // cannot produce. It is `repositoryUnavailable` rather than a new
            // `PROVIDERS_*` code because minting one would put an adapter's
            // finding into a context's published vocabulary; the reason string
            // is what tells an operator which of the two names collided.
            return repositoryUnavailable("model provider and name already belong to another key");
          }
          return null;
        },
      );
      if (!outcome.ok) return err(outcome.refusal);
      return ok(readModel(outcome.value as ModelRow));
    },

    async findLatestPrice(modelId: ModelId): Promise<Result<ModelPrice | null>> {
      // ONE statement. `@@unique([modelId, effectiveFrom])` makes the descending
      // order TOTAL, so no tie-break is needed and none is added: an id
      // tie-break here would be a second sort key that can never decide
      // anything, and a reader would have to work out that it cannot.
      //
      // NO `at` FILTER, which the port asks for in these words: "The newest card
      // for a model, WHATEVER its effective date." A future-dated card is
      // visible here on purpose — `ingest-rate-card.ts` compares against it to
      // decide whether a new card says anything new.
      const row = await transactions.reader().modelPrice.findFirst({
        where: { modelId },
        select: PRICE_COLUMNS,
        orderBy: { effectiveFrom: "desc" },
      });
      return ok(row === null ? null : readModelPrice(row as ModelPriceRow));
    },

    async insertPrice(
      modelId: ModelId,
      card: PriceCard,
      transaction: TransactionScope,
    ): Promise<Result<ModelPrice>> {
      const client = transactions.writer(transaction);
      const rates = writeRateBook(card.rates);
      const written = await providersRefusable(
        client,
        () =>
          client.modelPrice.create({
            // `id` omitted for the reason `upsertModel` omits it: the column
            // mints it. `createdAt` likewise.
            data: { modelId, effectiveFrom: card.effectiveFrom, ...rates },
            select: PRICE_COLUMNS,
          }),
        (error): DomainError | null => {
          if (sqlstateOf(error) === UNIQUE_VIOLATION) {
            // REFUSED, never converted into an update and never shifted to the
            // next free instant. The port's own documentation promises exactly
            // this, and `reject_model_price_mutation` would refuse the update
            // half anyway.
            //
            // The first argument is the MODEL ID, not the model key, and that is
            // a deliberate match with `InMemoryProvidersRepository`: the double
            // passes `modelId` into a parameter named `modelKey`, the shared
            // conformance scenario compares the two stores verbatim, and a store
            // that "corrected" it would report a different detail for the same
            // event. Reaching for the key would also cost a second statement on
            // a transaction the violation has already poisoned.
            return priceRevisionConflict(modelId, card.effectiveFrom.toISOString());
          }
          if (sqlstateOf(error) === FOREIGN_KEY_VIOLATION) {
            return repositoryUnavailable("no such model");
          }
          return null;
        },
      );
      if (!written.ok) return err(written.refusal);
      return ok(readModelPrice(written.value as ModelPriceRow));
    },

    async findPricesForKeys(
      keys: readonly string[],
      at: Date,
    ): Promise<Result<readonly ModelPriceSnapshot[]>> {
      if (keys.length === 0) return ok([]);
      // RAW SQL WITH A REAL JOIN, and that is a MEASURED decision rather than a
      // preference. The delegate form — `findMany` with a nested
      // `select: { model: … }` — is two statements, not one: the client's
      // default relation strategy issues a second query for the to-one relation
      // and stitches the rows together in JavaScript. The count does not grow
      // with the number of keys, so it is not an N+1; it is a second round trip
      // on a read that is asked once per priced step, and
      // `providers-statements.integration.test.ts` is where that was found.
      //
      // The statement is statically visible, names no mutation, and is therefore
      // attributed by `sole-writer.mjs` exactly as a delegate read is.
      //
      // EVERY card in force, not the newest per key. `selectByKeyPrecedence`
      // decides which one wins and it decides by KEY ORDER rather than by date,
      // so a store that pre-selected the newest would have thrown away the very
      // rows that rule exists to choose between.
      const rows = await transactions.reader().$queryRaw<readonly JoinedPriceRow[]>`
        SELECT price."id", price."modelId", price."effectiveFrom",
               price."inputRate", price."outputRate", price."cacheReadRate", price."cacheWriteRate",
               price."inputSource", price."outputSource",
               price."cacheReadSource", price."cacheWriteSource",
               price."inputObservedAt", price."outputObservedAt",
               price."cacheReadObservedAt", price."cacheWriteObservedAt",
               price."inputSourceRef", price."outputSourceRef",
               price."cacheReadSourceRef", price."cacheWriteSourceRef",
               model."key" AS "modelKey",
               model."provider" AS "modelProvider",
               model."name" AS "modelName"
          FROM "ModelPrice" price
          JOIN "Model" model ON model."id" = price."modelId"
         WHERE price."effectiveFrom" <= ${at}
           AND model."key" = ANY(${[...keys]}::text[])
      `;
      return ok(
        rows.map((row) =>
          readModelPriceSnapshot(row, {
            key: row.modelKey,
            provider: row.modelProvider,
            name: row.modelName,
          }),
        ),
      );
    },
  };
}
