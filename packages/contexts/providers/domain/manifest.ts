// The provider manifest: non-secret, provider-published metadata.
//
// A manifest is the answer to "what does this provider need, and what can it
// do", written down once. It carries required and optional credential reference
// NAMES, a curated model list, the descriptor for a minimal liveness call, and —
// where the provider publishes one — the address of its own model list.
//
// IT NEVER CARRIES A CREDENTIAL. Not a key, not a token, not an envelope, not a
// process variable. The names below are names in an environment's own credential
// namespace; resolving one to material is `secrets`' job and happens a layer out.
//
// WHY THE REGISTRY IS PASSED IN RATHER THAN IMPORTED. `catalogue.ts` ships the
// transcribed default, and every rule in this file takes a `ProviderCatalogue`
// parameter. A rule that reached for a module-level constant would be untestable
// against anything but the shipped list, and the shipped list is the one thing an
// installation might reasonably extend.

import { err, ok, type Result } from "@platos/kernel";

import { unknownProvider } from "./errors.js";
import type { CredentialName, ProviderId } from "./identifiers.js";

/**
 * How a provider's model list is shaped when it publishes one.
 *
 * These are RESPONSE SHAPES, not vendors: two providers that answer with the
 * same JSON share one entry. The adapter that reads the list is the only thing
 * that interprets them; the domain only records which shape to expect, so
 * routing a provider onto the wrong parser is a compile-time question.
 */
export const MODEL_LIST_SHAPES = [
  "openai",
  "together",
  "anthropic",
  "google",
  "fireworks",
  "mistral",
  "groq",
] as const;

export type ModelListShape = (typeof MODEL_LIST_SHAPES)[number];

/** How the model-list call presents the credential. */
export const MODEL_LIST_AUTH = ["bearer", "header-key", "query-key"] as const;

export type ModelListAuth = (typeof MODEL_LIST_AUTH)[number];

export interface ModelListEndpoint {
  readonly url: string;
  readonly auth: ModelListAuth;
  readonly shape: ModelListShape;
}

/**
 * Which wire protocol a provider speaks.
 *
 * The extraction source held this fact TWICE — once as `healthCheck.kind` in the
 * manifests and once as membership of an `OPENAI_COMPAT_BASE_URLS` table in the
 * turn engine, with a comment reading "keep in sync". Two tables that must agree
 * by convention eventually will not. Here there is one: the dialect below, and
 * the base URL beside it, decide both the liveness call and the routing plan.
 */
export const PROVIDER_DIALECTS = [
  "anthropic-native",
  "openai-native",
  "openai-compatible",
  "azure-openai",
  "google-generative",
  "google-vertex",
] as const;

export type ProviderDialect = (typeof PROVIDER_DIALECTS)[number];

export interface ProviderManifest {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly description: string;
  /** Every one of these must resolve before the provider counts as ready. */
  readonly requiredCredentials: readonly CredentialName[];
  /** Refines behaviour — a base URL, a region. Absence is never an error. */
  readonly optionalCredentials: readonly CredentialName[];
  /**
   * The curated `<provider>:<model>` list. Always shown, even when the live list
   * cannot be fetched, so a broken upstream narrows the picker instead of
   * emptying it.
   */
  readonly models: readonly string[];
  readonly dialect: ProviderDialect;
  /**
   * The OpenAI-compatible root for `openai-compatible`, and the optional
   * override root for `openai-native`. Null for every dialect that addresses
   * its provider some other way, and for `azure-openai`, whose root is
   * per-resource and therefore an environment credential rather than a constant.
   */
  readonly baseUrl: string | null;
  /**
   * Which credential, if any, supplies a per-environment root for this provider.
   *
   * Named on the manifest rather than derived from the credential's spelling.
   * The source hard-codes `OPENAI_BASE_URL` and `AZURE_OPENAI_BASE_URL` at three
   * separate call sites, and a convention like "the one ending in _BASE_URL"
   * would only move the hard-coding somewhere less visible.
   */
  readonly baseUrlCredential: CredentialName | null;
  /** Which credential supplies a region. Vertex only, today. */
  readonly locationCredential: CredentialName | null;
  /** A tiny model the liveness call names. Never billed for real work. */
  readonly probeModel: string;
  /** Null when the provider publishes no model list this context can read. */
  readonly modelList: ModelListEndpoint | null;
}

/** The providers an installation knows about, keyed by id. */
export type ProviderCatalogue = readonly ProviderManifest[];

export function findManifest(catalogue: ProviderCatalogue, providerId: string): ProviderManifest | null {
  return catalogue.find((manifest) => manifest.id === providerId) ?? null;
}

export function requireManifest(
  catalogue: ProviderCatalogue,
  providerId: string,
): Result<ProviderManifest> {
  const manifest = findManifest(catalogue, providerId);
  return manifest === null ? err(unknownProvider(providerId)) : ok(manifest);
}

/**
 * The credential name a provider's API key is stored under.
 *
 * It is the FIRST required name, and that ordering is load-bearing: the source
 * resolves `requiredEnv[0]` as the API key and treats every later name as
 * configuration. Stating it as a named rule is what keeps a reordered manifest
 * from silently changing which credential is the key.
 */
export function apiKeyCredentialName(manifest: ProviderManifest): CredentialName | null {
  return manifest.requiredCredentials[0] ?? null;
}

/** Per-name readiness, in manifest order. */
export interface CredentialReadiness {
  readonly name: CredentialName;
  readonly present: boolean;
}

export interface ProviderReadiness {
  readonly required: readonly CredentialReadiness[];
  readonly ready: boolean;
}

/**
 * Decide readiness from a per-name presence map plus one override.
 *
 * The override exists because the API-key slot has two independent ways of being
 * satisfied: a `Credential` under that bare name, or a linked `ProviderKey`
 * pointing at an active credential. The source expresses this by overwriting
 * `requiredEnv[0].set` after the map is built; the rule is named here so it is
 * visible rather than buried in an index.
 */
export function readiness(
  manifest: ProviderManifest,
  present: Readonly<Record<string, boolean>>,
  linkedProviderCredential = false,
): ProviderReadiness {
  const apiKeyName = apiKeyCredentialName(manifest);
  const required = manifest.requiredCredentials.map((name) => ({
    name,
    present: (present[name] ?? false) || (linkedProviderCredential && name === apiKeyName),
  }));
  return { required, ready: required.every((entry) => entry.present) };
}

/**
 * Union the curated list with a live one, curated first, de-duplicated.
 *
 * Order is the contract: a picker renders this list top to bottom, so the models
 * an installation blessed stay above whatever the provider happens to publish
 * today. A live list that repeats a curated entry does not move it.
 */
export function mergeModelLists(
  curated: readonly string[],
  live: readonly string[],
): readonly string[] {
  const seen = new Set(curated);
  return [...curated, ...live.filter((model) => (seen.has(model) ? false : (seen.add(model), true)))];
}

/** Qualify a bare provider model id as `<provider>:<model>`. */
export function qualifyModel(providerId: ProviderId, modelId: string): string {
  return `${providerId}:${modelId}`;
}
