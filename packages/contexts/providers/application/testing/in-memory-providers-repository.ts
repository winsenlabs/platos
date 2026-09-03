// An in-memory `ProvidersRepository`.
//
// It is a REAL implementation of the port, not a stub: it enforces the same
// invariants the store does, and it fails the same way. That is the whole point
// — a use case that passes against this double and fails against Postgres would
// mean the double lied, so every constraint the port's documentation promises is
// enforced here.
//
// What it enforces, and where the guarantee comes from:
//
//   * EVERY READ IS SCOPED. A key that exists in another environment is `null`,
//     not a row. The cross-tenant denial is tested against this.
//   * THE LISTING ORDER IS `byListingOrder`, tie-break included.
//   * `@@unique([environmentId, provider, label])` on insert.
//   * The partial unique index on `[environment, provider]` where `isDefault`.
//   * `@@unique([modelId, effectiveFrom])` on price append, refused and never
//     converted into an update.
//
// It is framework-free, like everything else under `application/`.

import { err, ok, resolvePath, type EnvironmentScope, type Result, type TransactionScope } from "@platos/kernel";

import {
  asProvidersIdentifier,
  byListingOrder,
  labelIsTaken,
  priceRevisionConflict,
  providerKeyAlreadyExists,
  repositoryUnavailable,
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
} from "../../domain/index.js";
import type {
  ProviderKeyPage,
  ProviderKeyQuery,
  ProvidersRepository,
} from "../ports/index.js";

export class InMemoryProvidersRepository implements ProvidersRepository {
  private readonly keys = new Map<string, ProviderKey>();
  private readonly links = new Map<string, ProviderLink>();
  private readonly models = new Map<string, Model>();
  private readonly prices: ModelPrice[] = [];
  private readonly pins = new Map<string, number>();
  private sequence = 0;

  /** Transactions this double was handed, so a test can assert atomicity. */
  readonly transactions: TransactionScope[] = [];

  // --- seeding, for tests --------------------------------------------------

  seedProviderKey(key: ProviderKey): ProviderKey {
    this.keys.set(key.providerKeyId, key);
    return key;
  }

  seedProviderLink(link: ProviderLink): ProviderLink {
    this.links.set(`${link.environmentId}/${link.provider}`, link);
    return link;
  }

  seedModel(model: Model): Model {
    this.models.set(model.key, model);
    return model;
  }

  seedPrice(price: ModelPrice): ModelPrice {
    this.prices.push(price);
    return price;
  }

  /** How many agent versions the next `countAgentVersionsPinning` will report. */
  pinKey(providerKeyId: ProviderKeyId, count: number): void {
    this.pins.set(providerKeyId, count);
  }

  /**
   * Make the next key insert fail the way an unreachable store would.
   *
   * Not a contrivance: it is the one failure a caller cannot provoke through the
   * port's own rules, and it is exactly the case the register path's compensation
   * exists for — the vault write succeeded and the row write did not.
   */
  failNextProviderKeyInsert(): void {
    this.nextInsertFails = true;
  }

  private nextInsertFails = false;

  allProviderKeys(): readonly ProviderKey[] {
    return [...this.keys.values()];
  }

  allPrices(): readonly ModelPrice[] {
    return [...this.prices];
  }

  // --- ProviderKey ---------------------------------------------------------

  private inScope(scope: EnvironmentScope): ProviderKey[] {
    return [...this.keys.values()]
      .filter((key) => key.environmentId === scope.environmentId)
      .sort(byListingOrder);
  }

  async listProviderKeys(scope: EnvironmentScope): Promise<Result<readonly ProviderKey[]>> {
    return ok(this.inScope(scope));
  }

  async pageProviderKeys(
    scope: EnvironmentScope,
    query: ProviderKeyQuery,
  ): Promise<Result<ProviderKeyPage>> {
    const needle = query.search?.toLowerCase() ?? null;
    const matched = this.inScope(scope).filter((key) => {
      if (query.provider !== null && key.provider !== query.provider) return false;
      if (needle === null) return true;
      return [key.provider, key.label, key.credentialName].some((field) =>
        field.toLowerCase().includes(needle),
      );
    });
    return ok({
      items: matched.slice(query.offset, query.offset + query.limit),
      total: matched.length,
    });
  }

  async findProviderKey(
    scope: EnvironmentScope,
    providerKeyId: ProviderKeyId,
  ): Promise<Result<ProviderKey | null>> {
    const held = this.keys.get(providerKeyId) ?? null;
    // A row from another environment is ABSENT, never returned.
    return ok(held !== null && held.environmentId === scope.environmentId ? held : null);
  }

  async listProviderKeysFor(
    scope: EnvironmentScope,
    provider: ProviderId,
  ): Promise<Result<readonly ProviderKey[]>> {
    return ok(this.inScope(scope).filter((key) => key.provider === provider));
  }

  async insertProviderKey(
    key: ProviderKey,
    transaction: TransactionScope,
  ): Promise<Result<ProviderKey>> {
    this.transactions.push(transaction);
    if (this.nextInsertFails) {
      this.nextInsertFails = false;
      return err(repositoryUnavailable("in-memory store refused the insert"));
    }
    const siblings = [...this.keys.values()];
    if (labelIsTaken(siblings, key.environmentId, key.provider, key.label)) {
      return err(providerKeyAlreadyExists(key.provider, key.label));
    }
    if (key.isDefault && this.defaultHeldBy(key) !== null) {
      // The partial unique index. A caller that did not demote first sees it.
      return err(providerKeyAlreadyExists(key.provider, "default"));
    }
    this.keys.set(key.providerKeyId, key);
    return ok(key);
  }

  async updateProviderKey(
    key: ProviderKey,
    transaction: TransactionScope,
  ): Promise<Result<ProviderKey>> {
    this.transactions.push(transaction);
    const incumbent = this.defaultHeldBy(key);
    if (key.isDefault && incumbent !== null && incumbent !== key.providerKeyId) {
      return err(providerKeyAlreadyExists(key.provider, "default"));
    }
    this.keys.set(key.providerKeyId, key);
    return ok(key);
  }

  private defaultHeldBy(key: ProviderKey): ProviderKeyId | null {
    const held = [...this.keys.values()].find(
      (candidate) =>
        candidate.isDefault &&
        candidate.environmentId === key.environmentId &&
        candidate.provider === key.provider &&
        candidate.providerKeyId !== key.providerKeyId,
    );
    return held?.providerKeyId ?? null;
  }

  async deleteProviderKey(
    scope: EnvironmentScope,
    providerKeyId: ProviderKeyId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>> {
    this.transactions.push(transaction);
    const held = this.keys.get(providerKeyId);
    if (held === undefined || held.environmentId !== scope.environmentId) return ok(false);
    this.keys.delete(providerKeyId);
    return ok(true);
  }

  async countAgentVersionsPinning(
    scope: EnvironmentScope,
    providerKeyId: ProviderKeyId,
  ): Promise<Result<number>> {
    const held = this.keys.get(providerKeyId);
    if (held === undefined || held.environmentId !== scope.environmentId) return ok(0);
    return ok(this.pins.get(providerKeyId) ?? 0);
  }

  async touchProviderKey(providerKeyId: ProviderKeyId, usedAt: Date): Promise<Result<void>> {
    const held = this.keys.get(providerKeyId);
    if (held !== undefined) this.keys.set(providerKeyId, { ...held, lastUsedAt: usedAt });
    return ok(undefined);
  }

  // --- EnvironmentProvider -------------------------------------------------

  async listProviderLinks(scope: EnvironmentScope): Promise<Result<readonly ProviderLink[]>> {
    return ok([...this.links.values()].filter((link) => link.environmentId === scope.environmentId));
  }

  async findProviderLink(
    scope: EnvironmentScope,
    provider: ProviderId,
  ): Promise<Result<ProviderLink | null>> {
    return ok(this.links.get(`${scope.environmentId}/${provider}`) ?? null);
  }

  async upsertProviderLink(
    link: ProviderLink,
    transaction: TransactionScope,
  ): Promise<Result<ProviderLink>> {
    this.transactions.push(transaction);
    this.links.set(`${link.environmentId}/${link.provider}`, link);
    return ok(link);
  }

  async deleteProviderLink(
    scope: EnvironmentScope,
    provider: ProviderId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>> {
    this.transactions.push(transaction);
    return ok(this.links.delete(`${scope.environmentId}/${provider}`));
  }

  // --- Model and ModelPrice ------------------------------------------------

  async findModelByKey(key: ModelKey): Promise<Result<Model | null>> {
    return ok(this.models.get(key) ?? null);
  }

  async upsertModel(
    key: ModelKey,
    facts: ModelFacts,
    transaction: TransactionScope,
  ): Promise<Result<Model>> {
    this.transactions.push(transaction);
    const held = this.models.get(key);
    const model: Model = {
      modelId: held?.modelId ?? asProvidersIdentifier<ModelId>(`model-${(this.sequence += 1)}`),
      key,
      isHidden: held?.isHidden ?? false,
      ...facts,
    };
    this.models.set(key, model);
    return ok(model);
  }

  async findLatestPrice(modelId: ModelId): Promise<Result<ModelPrice | null>> {
    const held = this.prices
      .filter((price) => price.modelId === modelId)
      .sort((left, right) => right.effectiveFrom.getTime() - left.effectiveFrom.getTime());
    return ok(held[0] ?? null);
  }

  async insertPrice(
    modelId: ModelId,
    card: PriceCard,
    transaction: TransactionScope,
  ): Promise<Result<ModelPrice>> {
    this.transactions.push(transaction);
    const clash = this.prices.find(
      (price) =>
        price.modelId === modelId && price.effectiveFrom.getTime() === card.effectiveFrom.getTime(),
    );
    if (clash !== undefined) {
      // Refused, never converted into an update and never shifted to the next
      // free instant. The port's documentation promises exactly this.
      return err(priceRevisionConflict(modelId, card.effectiveFrom.toISOString()));
    }
    const price: ModelPrice = {
      modelPriceId: asProvidersIdentifier<ModelPriceId>(`price-${(this.sequence += 1)}`),
      modelId,
      ...card,
    };
    this.prices.push(price);
    return ok(price);
  }

  async findPricesForKeys(
    keys: readonly string[],
    at: Date,
  ): Promise<Result<readonly ModelPriceSnapshot[]>> {
    const wanted = new Set(keys);
    const byId = new Map([...this.models.values()].map((model) => [model.modelId as string, model]));
    const snapshots: ModelPriceSnapshot[] = [];
    for (const price of this.prices) {
      const model = byId.get(price.modelId);
      if (model === undefined || !wanted.has(model.key)) continue;
      if (price.effectiveFrom.getTime() > at.getTime()) continue;
      snapshots.push({
        ...price,
        modelKey: model.key,
        provider: model.provider,
        modelName: model.name,
      });
    }
    return ok(snapshots);
  }
}

/** The scope path a test asserts against, without importing the kernel twice. */
export function scopePath(scope: EnvironmentScope): string {
  return resolvePath(scope);
}
