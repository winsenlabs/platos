// The `ProvidersRepository` port — the canonical store, seen only as an interface.
//
// ADR M0.3 §1 row 4 makes this context the SOLE WRITER of `ProviderKey`,
// `EnvironmentProvider`, `Model` and `ModelPrice`. This port is where that
// ownership is expressed: every mutation of those four tables in the V1 system
// passes through one of the methods below, and there is deliberately no generic
// `save(row)` or `query(where)` escape hatch another context could reach sideways.
//
// TWO SCOPING REGIMES, ON PURPOSE.
//
//   ProviderKey and EnvironmentProvider are ENVIRONMENT-SCOPED. Every read takes
//   an `EnvironmentScope` and an implementation MUST return `null` — never a row
//   from another environment — when an id exists elsewhere. There is no
//   `findProviderKey(id)`; making the scope a parameter is what stops a
//   scope-less lookup from compiling.
//
//   Model and ModelPrice are INSTALLATION-GLOBAL and their methods take no
//   scope, because they have none: what a model is, and what it cost on a given
//   date, do not vary by tenant. Giving them a scope parameter would be a lie
//   that invites an environment-filtered price lookup which silently finds
//   nothing.
//
// THE AUTHORIZATION IS NOT A PARAMETER HERE. A use case verifies the grant it
// was handed and derives the scope from it (never from an id the caller also
// supplied), then passes the derived scope down. That keeps this port free of a
// peer context's types, which matters because its adapter is shared: an
// implementation of this interface needs the tenancy database and nothing else.
//
// EVERY MUTATION TAKES A `TransactionScope`. The kernel's handle is opaque by
// construction (ADR M0.3 §3: no context passes a vendor transaction handle
// across a port), which is what lets a row write and an outbox append be atomic
// without either side naming the other's technology.
//
// EVERY METHOD RETURNS `Result`. A rejected promise is a defect, not an outcome.

import type { EnvironmentScope, Result, TransactionScope } from "@platos/kernel";

import type {
  Model,
  ModelFacts,
  ModelId,
  ModelKey,
  ModelPrice,
  ModelPriceSnapshot,
  PriceCard,
  ProviderId,
  ProviderKey,
  ProviderKeyId,
  ProviderLink,
} from "../../domain/index.js";

/** One page of a listing, with the total the surface renders beside it. */
export interface ProviderKeyPage {
  readonly items: readonly ProviderKey[];
  readonly total: number;
}

export interface ProviderKeyQuery {
  readonly limit: number;
  readonly offset: number;
  /** Narrow to one provider. Null means every provider in the scope. */
  readonly provider: ProviderId | null;
  /**
   * Case-insensitive substring across provider, label and credential name.
   * Null means no filter; an empty string is NOT the same as null and is
   * rejected by the use case before it reaches here.
   */
  readonly search: string | null;
}

export interface ProvidersRepository {
  // --- ProviderKey: environment-scoped, sole-writer -------------------------

  listProviderKeys(scope: EnvironmentScope): Promise<Result<readonly ProviderKey[]>>;

  /**
   * One page, in `byListingOrder`. An implementation MUST apply that exact
   * order, including its final id tie-break: a paged listing whose order is not
   * total silently drops and repeats rows across pages.
   */
  pageProviderKeys(scope: EnvironmentScope, query: ProviderKeyQuery): Promise<Result<ProviderKeyPage>>;

  findProviderKey(scope: EnvironmentScope, providerKeyId: ProviderKeyId): Promise<Result<ProviderKey | null>>;

  listProviderKeysFor(scope: EnvironmentScope, provider: ProviderId): Promise<Result<readonly ProviderKey[]>>;

  insertProviderKey(key: ProviderKey, transaction: TransactionScope): Promise<Result<ProviderKey>>;

  updateProviderKey(key: ProviderKey, transaction: TransactionScope): Promise<Result<ProviderKey>>;

  deleteProviderKey(
    scope: EnvironmentScope,
    providerKeyId: ProviderKeyId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>>;

  /**
   * How many agent versions still name this key.
   *
   * The source answers this with one query that walks agent bindings and both
   * places a version can pin a key — its runtime configuration and its model
   * routes. It is a COUNT and not a boolean because the refusal reports it: an
   * operator told "three agent versions still use this" can go and fix them.
   */
  countAgentVersionsPinning(scope: EnvironmentScope, providerKeyId: ProviderKeyId): Promise<Result<number>>;

  /**
   * Record that a key was used, outside any caller transaction.
   *
   * Deliberately NOT transactional. It is bookkeeping on a read path, and
   * enlisting it in the caller's unit of work would make a failed write of this
   * timestamp roll back the turn that succeeded.
   */
  touchProviderKey(providerKeyId: ProviderKeyId, usedAt: Date): Promise<Result<void>>;

  // --- EnvironmentProvider: environment-scoped, sole-writer -----------------

  listProviderLinks(scope: EnvironmentScope): Promise<Result<readonly ProviderLink[]>>;

  findProviderLink(scope: EnvironmentScope, provider: ProviderId): Promise<Result<ProviderLink | null>>;

  /** Insert or switch one adoption. Unique per `[environment, provider]`. */
  upsertProviderLink(link: ProviderLink, transaction: TransactionScope): Promise<Result<ProviderLink>>;

  deleteProviderLink(
    scope: EnvironmentScope,
    provider: ProviderId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>>;

  // --- Model and ModelPrice: installation-global, sole-writer ---------------

  findModelByKey(key: ModelKey): Promise<Result<Model | null>>;

  /**
   * Insert or refresh one model identity, keyed by `key`.
   *
   * `sourceUpdatedAt` is always written even when nothing else changed: it
   * records when the catalogue was last read, which is how an operator tells a
   * stale catalogue from a stable one.
   */
  upsertModel(key: ModelKey, facts: ModelFacts, transaction: TransactionScope): Promise<Result<Model>>;

  /** The newest card for a model, whatever its effective date. */
  findLatestPrice(modelId: ModelId): Promise<Result<ModelPrice | null>>;

  /**
   * Append one card. The `@@unique([modelId, effectiveFrom])` constraint is the
   * last line of defence: an implementation MUST surface a violation as
   * `PROVIDERS_PRICE_REVISION_CONFLICT` and MUST NOT convert the insert into an
   * update or shift the effective date to the next free instant.
   */
  insertPrice(
    modelId: ModelId,
    card: PriceCard,
    transaction: TransactionScope,
  ): Promise<Result<ModelPrice>>;

  /**
   * Every card in force at `at` for any of these model keys, joined to the model
   * identity. Ordering is the caller's: `selectByKeyPrecedence` decides which
   * one wins, and it decides by KEY order rather than by date.
   */
  findPricesForKeys(keys: readonly string[], at: Date): Promise<Result<readonly ModelPriceSnapshot[]>>;
}
