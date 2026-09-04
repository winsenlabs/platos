// Fixtures the suites in this package share.
//
// It follows the precedent `packages/contexts/providers/application/testing/`
// sets: a package's doubles live beside its code, typechecked under the same
// `strict` and `noUncheckedIndexedAccess` settings as the code they stand in
// for. It is NOT exported from `index.ts` — nothing outside this package has a
// use for it, and an adapter's published surface is a factory and three seams.
//
// THE PLANS ARE BUILT AS LITERALS, NOT ROUTED. `planModelRoute` lives in the
// `providers` domain, which this package cannot import: its one import edge is
// the ports entrypoint, and re-exporting a routing function there so a test
// could reach it would widen the port's surface for the convenience of a test.
// `ModelRoutePlan` is a plain value, so a literal is the same thing the router
// would have produced, and `packages/contexts/providers/domain/route.test.ts` is
// what holds the routing itself to account.

import type {
  ModelRoutePlan,
  ProviderCredential,
  ProviderDialect,
} from "@platos/context-providers/application/ports/index.js";

export function routePlan(
  modelString: string,
  overrides: Partial<Omit<ModelRoutePlan, "reference">> & { dialect: ProviderDialect },
): ModelRoutePlan {
  const separator = modelString.indexOf(":");
  const qualified = separator > 0;
  return {
    reference: {
      modelString,
      provider: (qualified ? modelString.slice(0, separator) : "anthropic") as ModelRoutePlan["reference"]["provider"],
      modelName: qualified ? modelString.slice(separator + 1) : modelString,
      qualified,
    },
    dialect: overrides.dialect,
    baseUrl: overrides.baseUrl ?? null,
    chatCompletionsOnly: overrides.chatCompletionsOnly ?? false,
    location: overrides.location ?? null,
    credentialIsServiceAccount: overrides.credentialIsServiceAccount ?? false,
  };
}

export const ANTHROPIC_PLAN = routePlan("anthropic:claude-sonnet-4-6", { dialect: "anthropic-native" });
export const OPENAI_PLAN = routePlan("openai:gpt-4.1", { dialect: "openai-native" });

/** Material for one call. `fingerprint` is never the material — that is the point. */
export function credential(material: string, fingerprint = "key-1"): ProviderCredential {
  return { reveal: () => material, fingerprint };
}
