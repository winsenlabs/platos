// Use cases: what does a model cost, and what did this turn cost?
//
// INSTALLATION-GLOBAL AND UNSCOPED, ON PURPOSE. A rate card is a fact about the
// world, not about a tenant, so neither of these takes an authorization or a
// scope. Adding one would be a lie that invites an environment-filtered price
// lookup which silently finds nothing and prices a turn at zero.
//
// RESOLUTION IS BY KEY PRECEDENCE, NOT BY DATE. `modelLookupKeys` produces
// candidates most-specific-first and `selectByKeyPrecedence` walks them in that
// order, so an exact provider-qualified match beats a bare model name another
// provider also publishes — even when the bare name's card is newer.
//
// FAILING TO PRICE IS AN ERROR, NOT A ZERO. Both paths refuse rather than
// return nothing: a turn nobody can price must surface, or an installation
// quietly serves free work it is paying for.

import { err, ok, type CurrencyCode, type Result, USD } from "@platos/kernel";

import {
  modelLookupKeys,
  modelPricingUnavailable,
  priceUsage as priceAgainstSnapshot,
  selectByKeyPrecedence,
  type ModelPriceSnapshot,
  type PricedUsage,
  type TokenUsage,
  type TokenUsageDraft,
  tokenUsage,
} from "../domain/index.js";
import type { ProvidersDependencies } from "./dependencies.js";

export interface ResolveModelPriceQuery {
  /** `<provider>:<model>`, or a bare model name. */
  readonly model: string;
  /** The instant to price at. The card in force then, not today's. */
  readonly at?: Date;
}

export interface PriceModelUsageQuery extends ResolveModelPriceQuery {
  readonly usage: TokenUsageDraft;
  readonly currency?: CurrencyCode;
}

export interface PricedModelUsage extends PricedUsage {
  readonly price: ModelPriceSnapshot;
  readonly usage: TokenUsage;
}

/** The card in force for a model at an instant. */
export async function resolveModelPrice(
  dependencies: ProvidersDependencies,
  query: ResolveModelPriceQuery,
): Promise<Result<ModelPriceSnapshot>> {
  const at = query.at ?? dependencies.clock.now();
  const keys = modelLookupKeys(query.model);
  if (keys.length === 0) return err(modelPricingUnavailable(query.model));

  const candidates = await dependencies.repository.findPricesForKeys(keys, at);
  if (!candidates.ok) return err(candidates.error);

  const chosen = selectByKeyPrecedence(keys, candidates.value, at);
  if (chosen === null) return err(modelPricingUnavailable(query.model));
  return ok(chosen);
}

/** Resolve the card, then price the usage against it. */
export async function priceModelUsage(
  dependencies: ProvidersDependencies,
  query: PriceModelUsageQuery,
): Promise<Result<PricedModelUsage>> {
  const usage = tokenUsage(query.usage);
  if (!usage.ok) return err(usage.error);

  const price = await resolveModelPrice(dependencies, query);
  if (!price.ok) return err(price.error);

  const priced = priceAgainstSnapshot(price.value, usage.value, query.currency ?? USD);
  if (!priced.ok) return err(priced.error);
  return ok({ ...priced.value, price: price.value, usage: usage.value });
}
