// From a model string to a routing plan.
//
// This is the whole of `resolveModel` except the one line that constructs a
// vendor client. Splitting a `<provider>:<model>` string, deciding which wire
// dialect the provider speaks, insisting on a base URL where one is mandatory,
// and normalising an operator-supplied root are all decisions with no I/O in
// them — and every one of them is a decision the system currently gets wrong
// silently when it gets it wrong at all. Here they are a value a test can
// inspect, and the SDK-holding adapter receives a finished plan rather than a
// string it has to re-parse.
//
// THE UNQUALIFIED-MODEL RULE IS PRESERVED EXACTLY. A model string with no colon
// — or with a colon at position zero — routes to `anthropic`, because that is
// what the running system does and agent versions in the field carry bare model
// names that depend on it. It is stated once, here, as `DEFAULT_PROVIDER`.
//
// THE PLAN CARRIES NO CREDENTIAL. It says which provider, which model, which
// dialect and which root; the material is supplied separately at the moment of
// use. That is what lets a plan be logged, cached and compared.

import { err, ok, type Result } from "@platos/kernel";

import { configurationUnavailable, modelStringInvalid } from "./errors.js";
import { asProvidersIdentifier, type ProviderId } from "./identifiers.js";
import { findManifest, type ProviderCatalogue, type ProviderDialect, type ProviderManifest } from "./manifest.js";

/** Where a model string with no provider segment routes. */
export const DEFAULT_PROVIDER = asProvidersIdentifier<ProviderId>("anthropic");

/** Where Vertex requests go when the environment names no region. */
export const DEFAULT_VERTEX_LOCATION = "us-central1";

/** A `<provider>:<model>` string, split. */
export interface ModelReference {
  readonly modelString: string;
  readonly provider: ProviderId;
  readonly modelName: string;
  /** False when the provider segment was absent and `anthropic` was assumed. */
  readonly qualified: boolean;
}

/**
 * The per-environment settings that refine a route.
 *
 * Both fields come from a provider's OPTIONAL credentials, so both are legitimately
 * absent. `baseUrl` is mandatory for `azure-openai` and refining for
 * `openai-native`; `location` is refining for `google-vertex` and meaningless
 * elsewhere. Absence and emptiness are the same thing on purpose: an operator who
 * saved a blank value has not configured anything.
 */
export interface ProviderRuntimeSettings {
  readonly baseUrl: string | null;
  readonly location: string | null;
}

export const NO_RUNTIME_SETTINGS: ProviderRuntimeSettings = Object.freeze({
  baseUrl: null,
  location: null,
});

/** Everything the SDK-holding adapter needs, and nothing it does not. */
export interface ModelRoutePlan {
  readonly reference: ModelReference;
  readonly dialect: ProviderDialect;
  /** The root to address. Null only for dialects that need no explicit root. */
  readonly baseUrl: string | null;
  /**
   * True when the provider speaks the chat-completions surface rather than the
   * newer responses surface. The source pins this by calling `.chat(model)`
   * instead of the default entry point, and getting it wrong yields a 404 from
   * a provider that is configured perfectly.
   */
  readonly chatCompletionsOnly: boolean;
  /** Vertex only. Null everywhere else. */
  readonly location: string | null;
  /**
   * True when the credential is a service-account document rather than a bearer
   * key. The adapter parses it; the plan only records that it must.
   */
  readonly credentialIsServiceAccount: boolean;
}

export function parseModelReference(modelString: string): Result<ModelReference> {
  const value = modelString.trim();
  if (value === "") return err(modelStringInvalid("model string must not be empty", modelString));

  const separator = value.indexOf(":");
  // `> 0`, not `>= 0`: a leading colon leaves an empty provider segment, which
  // the source treats as no provider at all rather than as a provider named "".
  if (separator > 0) {
    const modelName = value.slice(separator + 1);
    if (modelName === "") {
      return err(modelStringInvalid("model string names a provider but no model", modelString));
    }
    return ok({
      modelString: value,
      provider: asProvidersIdentifier<ProviderId>(value.slice(0, separator)),
      modelName,
      qualified: true,
    });
  }
  return ok({ modelString: value, provider: DEFAULT_PROVIDER, modelName: value, qualified: false });
}

/**
 * Normalise an operator-supplied OpenAI root to one ending in `/v1`.
 *
 * An operator pastes `https://gateway.example.com`, `https://…/`, or
 * `https://…/v1`, and all three mean the same thing. The source normalises in
 * two separate places with the same three lines; doing it once here is what
 * keeps the inference root and the model-list root from diverging.
 */
export function normaliseOpenAiRoot(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function blankToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function planFor(
  reference: ModelReference,
  manifest: ProviderManifest,
  settings: ProviderRuntimeSettings,
): Result<ModelRoutePlan> {
  const configuredRoot = blankToNull(settings.baseUrl);
  const base = {
    reference,
    dialect: manifest.dialect,
    location: null,
    credentialIsServiceAccount: false,
  } as const;

  switch (manifest.dialect) {
    case "anthropic-native":
    case "google-generative":
      return ok({ ...base, baseUrl: null, chatCompletionsOnly: false });

    case "openai-native":
      // An override root points at a proxy or gateway that speaks the older
      // chat-completions surface, so overriding also pins the surface. Without
      // an override the provider's own default entry point is used.
      return configuredRoot === null
        ? ok({ ...base, baseUrl: null, chatCompletionsOnly: false })
        : ok({ ...base, baseUrl: normaliseOpenAiRoot(configuredRoot), chatCompletionsOnly: true });

    case "openai-compatible":
      // The root is a catalogue constant for these providers. A manifest that
      // declares this dialect without one is a malformed catalogue, not a
      // misconfigured environment, and it fails closed the same way.
      return manifest.baseUrl === null
        ? err(
            configurationUnavailable("openai-compatible manifest declares no base url", {
              provider: manifest.id,
              model: reference.modelString,
            }),
          )
        : ok({ ...base, baseUrl: manifest.baseUrl, chatCompletionsOnly: true });

    case "azure-openai":
      // Per-resource and therefore never a constant. Refusing here is the whole
      // reason the plan is separate from the client: an absent root is a
      // configuration failure, not a request that gets sent somewhere wrong.
      return configuredRoot === null
        ? err(
            configurationUnavailable("azure route has no per-resource base url configured", {
              provider: manifest.id,
              model: reference.modelString,
            }),
          )
        : ok({ ...base, baseUrl: configuredRoot.replace(/\/+$/u, ""), chatCompletionsOnly: false });

    case "google-vertex":
      return ok({
        ...base,
        baseUrl: null,
        chatCompletionsOnly: false,
        location: blankToNull(settings.location) ?? DEFAULT_VERTEX_LOCATION,
        credentialIsServiceAccount: true,
      });
  }
}

/**
 * Build the routing plan for a model string.
 *
 * A provider the catalogue does not know fails closed with the same
 * content-free message every other routing failure uses. The source reaches its
 * `default:` branch and raises exactly this; naming the reason in `details`
 * (which never leaves the server) is the only difference.
 */
export function planModelRoute(
  catalogue: ProviderCatalogue,
  modelString: string,
  settings: ProviderRuntimeSettings = NO_RUNTIME_SETTINGS,
): Result<ModelRoutePlan> {
  const reference = parseModelReference(modelString);
  if (!reference.ok) return err(reference.error);

  const manifest = findManifest(catalogue, reference.value.provider);
  if (manifest === null) {
    return err(
      configurationUnavailable("no manifest for the provider named by the model string", {
        provider: reference.value.provider,
        model: reference.value.modelString,
      }),
    );
  }
  return planFor(reference.value, manifest, settings);
}
