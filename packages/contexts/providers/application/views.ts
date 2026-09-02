// Turning this context's aggregates into the shapes its contract publishes.
//
// The whole reason a view type exists is here: a `ProviderKey` names the
// credential that backs it, and a caller outside this context has no business
// with a credential id. The views below drop it.
//
// A view is also where a bigint stops being one. `Money` and `TokenRate` carry
// exact integers that JSON cannot represent, so every amount leaves as its
// canonical decimal STRING — the same form the store round-trips — rather than
// as a number that would silently lose the last digits on the way out.

import { moneyToCentsString } from "@platos/kernel";

import {
  rateToDecimalString,
  RATE_NAMES,
  type ModelPriceSnapshot,
  type ProviderHealthReport,
  type ProviderKey,
  type ProviderState,
  type RateBook,
  type RateName,
} from "../domain/index.js";
import type {
  ModelPriceView,
  PricedUsageView,
  ProviderHealthView,
  ProviderKeyView,
  ProviderStateView,
  RateEntryView,
} from "../contracts/index.js";
import type { PricedModelUsage } from "./price-model-usage.js";

export function toProviderKeyView(key: ProviderKey): ProviderKeyView {
  return {
    providerKeyId: key.providerKeyId,
    environmentId: key.environmentId,
    provider: key.provider,
    label: key.label,
    credentialName: key.credentialName,
    isDefault: key.isDefault,
    createdBy: key.createdBy,
    lastUsedAt: key.lastUsedAt,
    createdAt: key.createdAt,
    updatedAt: key.updatedAt,
  };
}

export function toProviderStateView(state: ProviderState): ProviderStateView {
  return {
    provider: state.provider,
    displayName: state.displayName,
    description: state.description,
    requiredCredentials: state.requiredCredentials.map((entry) => ({
      name: entry.name,
      present: entry.present,
    })),
    optionalCredentials: [...state.optionalCredentials],
    ready: state.ready,
    enabled: state.enabled,
    linked: state.linked,
    linkedAt: state.linkedAt,
    probeModel: state.probeModel,
    models: [...state.models],
  };
}

export function toProviderHealthView(report: ProviderHealthReport): ProviderHealthView {
  return {
    provider: report.provider,
    status: report.status,
    latencyMs: report.latencyMs,
    failure: report.failure,
    model: report.model,
    requiredCredentials: report.requiredCredentials.map((entry) => ({
      name: entry.name,
      present: entry.present,
    })),
    checkedAt: report.checkedAt,
  };
}

function toRateEntryView(rates: RateBook, name: RateName): RateEntryView {
  const entry = rates[name];
  return {
    rate: name,
    usdPerToken: rateToDecimalString(entry.rate),
    source: entry.source,
    observedAt: entry.observedAt,
    sourceRef: entry.sourceRef,
  };
}

export function toModelPriceView(snapshot: ModelPriceSnapshot): ModelPriceView {
  return {
    modelPriceId: snapshot.modelPriceId,
    modelKey: snapshot.modelKey,
    provider: snapshot.provider,
    modelName: snapshot.modelName,
    effectiveFrom: snapshot.effectiveFrom,
    rates: RATE_NAMES.map((name) => toRateEntryView(snapshot.rates, name)),
  };
}

export function toPricedUsageView(priced: PricedModelUsage): PricedUsageView {
  return {
    price: toModelPriceView(priced.price),
    // Canonical decimal cents, not a number: the exact amount has six decimal
    // places and a JSON number cannot carry them without drifting.
    costCents: moneyToCentsString(priced.amount),
    currency: priced.amount.currency,
    charged: {
      input: priced.charged.input,
      output: priced.charged.output,
      cacheRead: priced.charged.cacheRead,
      cacheWrite: priced.charged.cacheWrite,
    },
  };
}
