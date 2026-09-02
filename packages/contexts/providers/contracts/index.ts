// The published surface of the `providers` context.
//
// ADR M0.3 §2: another context may import THIS entrypoint and nothing else —
// never `domain/`, never `application/`, never an adapter. The six contexts the
// §1 DAG permits to reach it are `agents`, `tools`, `memory`, `cost-monitoring`,
// `conversations` and, through the composition root, `apps/core-api`.
//
// The driven `ModelRouter` port is NOT re-exported here. It is adapter-facing,
// not context-facing, and it is published from `application/ports/index.js`
// where its one adapter imports it (ADR M0.3 §13). Neither is
// `ProvidersRepository` or `ProviderProbeCache`, for the same reason.
//
// WHAT THIS SURFACE DELIBERATELY WITHHOLDS.
//
//   * NO CREDENTIAL ID, ANYWHERE. A `ProviderKeyView` names the credential by
//     its bare reference name and never by id. An id is a handle into another
//     context's store, and handing one out invites a caller to try to use it.
//
//   * NO SECRET MATERIAL, AND NO WAY TO ASK FOR ANY. `openModelRoute` returns an
//     opaque `ModelSession` and the material stays inside the adapter that made
//     the call. There is no `readProviderKey`.
//
//   * NO EXACT AMOUNT AS A NUMBER. Rates are `Decimal(24, 12)` and costs are
//     `Decimal(18, 6)`; both leave as canonical decimal STRINGS, because a JSON
//     number cannot carry either without losing its last digits.

import type { EnvironmentId, Result } from "@platos/kernel";

import type {
  HealthStatus,
  ProbeFailure,
  RateName,
  RateSource,
} from "../domain/index.js";

// The identifier and scope vocabulary a caller needs to build a command. Branded
// types, so a `providerKeyId` cannot reach a `modelId` parameter across the
// boundary any more than it can inside it.
export type {
  ActorId,
  CredentialName,
  EnvironmentProviderId,
  ModelId,
  ModelKey,
  ModelPriceId,
  ProviderId,
  ProviderKeyId,
} from "../domain/index.js";

// The vocabulary a caller reads answers with.
export type {
  HealthStatus,
  ModelListShape,
  ProbeFailure,
  ProviderDialect,
  RateName,
  RateSource,
  TokenUsageDraft,
} from "../domain/index.js";

export {
  HEALTH_STATUSES,
  PROBE_FAILURES,
  PROVIDER_DIALECTS,
  PROVIDERS_ERROR_CODES,
  RATE_NAMES,
  RATE_SOURCES,
} from "../domain/index.js";

// The routing vocabulary. Published because the composition root builds the
// adapter around a plan, and because a caller logging a turn wants to record
// which provider and which model actually served it.
export type { ModelReference, ModelRoutePlan } from "../domain/index.js";

// The catalogue. Published as data so a transport can render the provider
// picker, and so an installation can compose its own list at the root.
export type { ProviderCatalogue, ProviderManifest } from "../domain/index.js";
export { DEFAULT_PROVIDER_CATALOGUE } from "../domain/index.js";

// Policy, published so the composition root can override a window without
// reaching into this package for the shape of one.
export type { ModelListPolicy, ProviderHealthPolicy, ProvidersPolicy } from "../domain/index.js";
export { DEFAULT_PROVIDERS_POLICY } from "../domain/index.js";

import type { ProvidersDependencies } from "../application/index.js";
import * as useCases from "../application/index.js";
import type { ModelSession, ProviderKeyPage } from "../application/index.js";

// --- read models -------------------------------------------------------------

export interface CredentialReadinessView {
  readonly name: string;
  readonly present: boolean;
}

/**
 * A provider key as seen from outside. It names the credential that backs it and
 * never identifies it: `credentialName` is a name in this environment's own
 * namespace, and the id stays inside this context.
 */
export interface ProviderKeyView {
  readonly providerKeyId: string;
  readonly environmentId: EnvironmentId;
  readonly provider: string;
  readonly label: string;
  readonly credentialName: string;
  readonly isDefault: boolean;
  readonly createdBy: string;
  readonly lastUsedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProviderKeyPageView {
  readonly items: readonly ProviderKeyView[];
  readonly total: number;
}

/**
 * A provider's three independent facts, plus what it can reach.
 *
 * `linked`, `enabled` and `ready` are separate because they fail separately: a
 * surface that showed one boolean could not tell an operator whether to adopt
 * the provider, switch it on, or add a key.
 */
export interface ProviderStateView {
  readonly provider: string;
  readonly displayName: string;
  readonly description: string;
  readonly requiredCredentials: readonly CredentialReadinessView[];
  readonly optionalCredentials: readonly string[];
  readonly ready: boolean;
  readonly enabled: boolean;
  readonly linked: boolean;
  readonly linkedAt: Date | null;
  readonly probeModel: string;
  readonly models: readonly string[];
}

export interface ProviderHealthView {
  readonly provider: string;
  readonly status: HealthStatus;
  readonly latencyMs: number;
  /** The stable failure token, or null when the call succeeded. */
  readonly failure: ProbeFailure | "unknown_provider" | null;
  readonly model: string | null;
  readonly requiredCredentials: readonly CredentialReadinessView[];
  readonly checkedAt: Date;
}

export interface RateEntryView {
  readonly rate: RateName;
  /** Canonical `Decimal(24, 12)` string. Never a number. */
  readonly usdPerToken: string;
  readonly source: RateSource;
  readonly observedAt: Date;
  readonly sourceRef: string | null;
}

export interface ModelPriceView {
  readonly modelPriceId: string;
  readonly modelKey: string;
  readonly provider: string;
  readonly modelName: string;
  readonly effectiveFrom: Date;
  readonly rates: readonly RateEntryView[];
}

export interface PricedUsageView {
  readonly price: ModelPriceView;
  /** Canonical `Decimal(18, 6)` cents. Never a number. */
  readonly costCents: string;
  readonly currency: string;
  readonly charged: { readonly [Name in RateName]: number };
}

// --- commands and queries ----------------------------------------------------

export type {
  CheckAllProvidersHealthQuery,
  CheckProviderHealthQuery,
  DeleteProviderKeyCommand,
  DescribeProviderKeyQuery,
  DescribeProviderQuery,
  DescribeProvidersQuery,
  IngestRateCardCommand,
  LinkProviderKeyCommand,
  OpenModelRouteCommand,
  PageProviderKeysQuery,
  PriceModelUsageQuery,
  RateCardIngestReport,
  ReadProviderKeysQuery,
  RegisterProviderKeyCommand,
  RelinkProviderKeyCommand,
  ResolveModelPriceQuery,
  RotateProviderKeySecretCommand,
  SetProviderAdoptionCommand,
  UpdateProviderKeyCommand,
} from "../application/index.js";

export type { ProvidersDependencies, ModelSession } from "../application/index.js";

export interface RelinkedProviderKeyView {
  readonly key: ProviderKeyView;
  /** What the key pointed at before. See `application/rotate-provider-key.ts`. */
  readonly previousCredentialName: string;
}

export interface OpenedModelRouteView {
  readonly session: ModelSession;
  /** Which key paid for it. The caller records this against the turn. */
  readonly providerKey: ProviderKeyView;
}

/**
 * The `providers` capability, as every other context sees it.
 *
 * Every method returns the kernel's `Result`: a failure a caller must handle is
 * visible in the type, and no vendor exception crosses this boundary.
 */
export interface ProvidersContract {
  readonly name: "providers";

  // ---- provider keys: metadata (operator grant, `metadata`) ---------------
  listProviderKeys(query: useCases.ReadProviderKeysQuery): Promise<Result<readonly ProviderKeyView[]>>;
  pageProviderKeys(query: useCases.PageProviderKeysQuery): Promise<Result<ProviderKeyPageView>>;
  describeProviderKey(query: useCases.DescribeProviderKeyQuery): Promise<Result<ProviderKeyView>>;

  // ---- provider keys: mutation (operator grant, `secret:mutate`) ----------
  /** Point a new key at a credential that is already in the vault. */
  linkProviderKey(command: useCases.LinkProviderKeyCommand): Promise<Result<ProviderKeyView>>;
  /** Put new material in the vault and point a new key at it. */
  registerProviderKey(command: useCases.RegisterProviderKeyCommand): Promise<Result<ProviderKeyView>>;
  /** Replace the material behind an existing key's credential. */
  rotateProviderKeySecret(
    command: useCases.RotateProviderKeySecretCommand,
  ): Promise<Result<ProviderKeyView>>;
  /** Point an existing key at a different credential. Touches no material. */
  relinkProviderKey(command: useCases.RelinkProviderKeyCommand): Promise<Result<RelinkedProviderKeyView>>;
  updateProviderKey(command: useCases.UpdateProviderKeyCommand): Promise<Result<ProviderKeyView>>;
  /** Remove the link. Never the credential, which `secrets` owns. */
  deleteProviderKey(command: useCases.DeleteProviderKeyCommand): Promise<Result<ProviderKeyView>>;

  // ---- the registry ------------------------------------------------------
  describeProviders(query: useCases.DescribeProvidersQuery): Promise<Result<readonly ProviderStateView[]>>;
  describeProvider(query: useCases.DescribeProviderQuery): Promise<Result<ProviderStateView>>;
  setProviderAdoption(command: useCases.SetProviderAdoptionCommand): Promise<Result<ProviderStateView>>;
  unlinkProvider(query: useCases.DescribeProviderQuery): Promise<Result<boolean>>;
  /** Linked, enabled and ready — the providers a turn may route to. */
  listUsableProviders(
    query: useCases.DescribeProvidersQuery,
  ): Promise<Result<readonly ProviderStateView[]>>;

  // ---- liveness (runtime grant) ------------------------------------------
  checkProviderHealth(query: useCases.CheckProviderHealthQuery): Promise<Result<ProviderHealthView>>;
  checkAllProvidersHealth(
    query: useCases.CheckAllProvidersHealthQuery,
  ): Promise<Result<readonly ProviderHealthView[]>>;

  // ---- routing (runtime grant) -------------------------------------------
  /**
   * Resolve a model string to a callable session, paid for by a named key.
   *
   * The seam `conversations` reaches for. It does not run a turn: composing a
   * turn out of sessions belongs to that context, which the ADR extracts last.
   */
  openModelRoute(command: useCases.OpenModelRouteCommand): Promise<Result<OpenedModelRouteView>>;

  // ---- pricing (installation-global, unscoped) ---------------------------
  /** The card in force for a model at an instant. Never today's for last month. */
  resolveModelPrice(query: useCases.ResolveModelPriceQuery): Promise<Result<ModelPriceView>>;
  priceModelUsage(query: useCases.PriceModelUsageQuery): Promise<Result<PricedUsageView>>;
  /** Read a public rate-card document into `Model` and `ModelPrice`. */
  ingestRateCard(command: useCases.IngestRateCardCommand): Promise<Result<useCases.RateCardIngestReport>>;
}

/** The integration events this context publishes through the kernel outbox. */
export const PROVIDERS_EVENT_NAMES = [
  "providers.key.linked",
  "providers.key.registered",
  "providers.key.rotated",
  "providers.key.relinked",
  "providers.key.updated",
  "providers.key.removed",
  "providers.provider.adopted",
  "providers.provider.released",
  "providers.model_price.appended",
] as const;

export type ProvidersEventName = (typeof PROVIDERS_EVENT_NAMES)[number];

/**
 * Retained from the generated skeleton so no sibling placeholder breaks. The
 * "aggregate" this context hands out is a provider's resolved state, not a row.
 */
export type ProvidersAggregate = ProviderStateView;

function keyPage(page: ProviderKeyPage): ProviderKeyPageView {
  return { items: page.items.map(useCases.toProviderKeyView), total: page.total };
}

/**
 * Bind the use cases into the driving port.
 *
 * The composition root builds the dependency bundle from adapters and calls this
 * once. Nothing here holds state: it is a lookup table from a contract method to
 * the one use case that implements it, which is what keeps the contract from
 * quietly growing behaviour of its own.
 */
export function providersContract(dependencies: ProvidersDependencies): ProvidersContract {
  const map = <Value, View>(
    result: Result<Value>,
    view: (value: Value) => View,
  ): Result<View> => (result.ok ? { ok: true, value: view(result.value) } : result);

  const contract: ProvidersContract = {
    name: "providers",

    listProviderKeys: async (query) =>
      map(await useCases.listProviderKeys(dependencies, query), (keys) =>
        keys.map(useCases.toProviderKeyView),
      ),
    pageProviderKeys: async (query) => map(await useCases.pageProviderKeys(dependencies, query), keyPage),
    describeProviderKey: async (query) =>
      map(await useCases.describeProviderKey(dependencies, query), useCases.toProviderKeyView),

    linkProviderKey: async (command) =>
      map(await useCases.linkProviderKey(dependencies, command), useCases.toProviderKeyView),
    registerProviderKey: async (command) =>
      map(await useCases.registerProviderKey(dependencies, command), useCases.toProviderKeyView),
    rotateProviderKeySecret: async (command) =>
      map(await useCases.rotateProviderKeySecret(dependencies, command), useCases.toProviderKeyView),
    relinkProviderKey: async (command) =>
      map(await useCases.relinkProviderKey(dependencies, command), (relinked) => ({
        key: useCases.toProviderKeyView(relinked.key),
        previousCredentialName: relinked.previousCredentialName,
      })),
    updateProviderKey: async (command) =>
      map(await useCases.updateProviderKey(dependencies, command), useCases.toProviderKeyView),
    deleteProviderKey: async (command) =>
      map(await useCases.deleteProviderKey(dependencies, command), useCases.toProviderKeyView),

    describeProviders: async (query) =>
      map(await useCases.describeProviders(dependencies, query), (states) =>
        states.map(useCases.toProviderStateView),
      ),
    describeProvider: async (query) =>
      map(await useCases.describeProvider(dependencies, query), useCases.toProviderStateView),
    setProviderAdoption: async (command) =>
      map(await useCases.setProviderAdoption(dependencies, command), useCases.toProviderStateView),
    unlinkProvider: (query) => useCases.unlinkProvider(dependencies, query),
    listUsableProviders: async (query) =>
      map(await useCases.listUsableProviders(dependencies, query), (states) =>
        states.map(useCases.toProviderStateView),
      ),

    checkProviderHealth: async (query) =>
      map(await useCases.checkProviderHealth(dependencies, query), useCases.toProviderHealthView),
    checkAllProvidersHealth: async (query) =>
      map(await useCases.checkAllProvidersHealth(dependencies, query), (reports) =>
        reports.map(useCases.toProviderHealthView),
      ),

    openModelRoute: async (command) =>
      map(await useCases.openModelRoute(dependencies, command), (opened) => ({
        session: opened.session,
        providerKey: useCases.toProviderKeyView(opened.providerKey),
      })),

    resolveModelPrice: async (query) =>
      map(await useCases.resolveModelPrice(dependencies, query), useCases.toModelPriceView),
    priceModelUsage: async (query) =>
      map(await useCases.priceModelUsage(dependencies, query), useCases.toPricedUsageView),
    ingestRateCard: (command) => useCases.ingestRateCard(dependencies, command),
  };
  return Object.freeze(contract);
}
