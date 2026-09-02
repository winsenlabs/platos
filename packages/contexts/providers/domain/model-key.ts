// Resolving one model to the several names a rate card might be filed under.
//
// A model has one identity and many names. An agent version says
// `together:meta-llama/Llama-3.1-8B-Instruct-Turbo`; the public rate-card
// catalogue files the same model as `together_ai/meta-llama/Meta-Llama-3.1-8B-
// Instruct-Turbo`; a hand-written route may say `Llama-3.1-8B-Instruct-Turbo`.
// Pricing has to find one card from any of them, and has to do it in an order
// that cannot cross providers by accident.
//
// THE ORDER IS THE RULE, and `price-card.ts` depends on it: candidates come out
// MOST SPECIFIC FIRST, so an exact provider-qualified match is preferred over a
// bare model name that two providers both publish. Recency never overrides key
// order — that would let one provider's fresher card price another provider's
// turn.
//
// Every entry in the two tables below is transcribed from the running system.
// They are DATA, deliberately: adding a provider is a table row and not a code
// path, and a missing row degrades to "no catalogue prefix for this provider",
// which narrows the search rather than mis-resolving it.

/**
 * Platos provider id -> the prefix the public rate-card catalogue files it
 * under. The catalogue namespaces models with a slash where Platos uses a colon,
 * and does not always agree on the name of the provider either.
 */
export const CATALOGUE_PROVIDER_PREFIX: Readonly<Record<string, string>> = Object.freeze({
  together: "together_ai",
  groq: "groq",
  mistral: "mistral",
  xai: "xai",
  deepseek: "deepseek",
  cerebras: "cerebras",
  perplexity: "perplexity",
  fireworks: "fireworks_ai",
  openai: "openai",
  anthropic: "anthropic",
  google: "gemini",
  "google-vertex": "vertex_ai",
  azure: "azure",
  voyage: "voyage",
});

/** The same table read backwards, for naming the provider of a catalogue entry. */
export const PROVIDER_BY_CATALOGUE_PREFIX: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(CATALOGUE_PROVIDER_PREFIX).map(([platos, catalogue]) => [catalogue, platos]),
  ),
);

/**
 * Names the mechanical rules above cannot derive.
 *
 * The catalogue renamed one model in a way no prefix rule reproduces
 * (`Llama-3.1-8B` became `Meta-Llama-3.1-8B`), so the mapping is written down
 * rather than guessed at. One entry is not a pattern; a second one would be the
 * moment to ask whether the catalogue needs a normaliser instead.
 */
export const MODEL_KEY_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "together:meta-llama/Llama-3.1-8B-Instruct-Turbo": Object.freeze([
    "together_ai/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
  ]),
});

/** Embedding models that carry no provider segment but belong to one. */
const BARE_EMBEDDING_PROVIDER = /^voyage(?:-|$)/iu;

/**
 * Every name a rate card for this model could be filed under, most specific
 * first, de-duplicated.
 *
 * The order, and why each step earns its place:
 *
 *   1. the string as written              — an exact match, if one exists
 *   2. `<cataloguePrefix>/<model>`        — the same model in catalogue naming
 *   3. any written-down alias             — a rename no rule derives
 *   4. `voyage/<model>`                   — a bare embedding model's home
 *   5. the bare model name                — for a card filed without a provider
 *   6. the last path segment              — for a card filed without a namespace
 *
 * Steps 5 and 6 are the widest and come last, because they are the ones that can
 * match another provider's model of the same name.
 */
export function modelLookupKeys(model: string): readonly string[] {
  const value = model.trim();
  if (value === "") return [];

  const keys = [value];
  const separator = value.indexOf(":");
  const provider = separator > 0 ? value.slice(0, separator) : null;
  const bare = separator > 0 ? value.slice(separator + 1) : value;

  if (provider !== null) {
    const prefix = CATALOGUE_PROVIDER_PREFIX[provider];
    if (prefix !== undefined) keys.push(`${prefix}/${bare}`);
  }
  keys.push(...(MODEL_KEY_ALIASES[value] ?? []));
  if (provider === null && BARE_EMBEDDING_PROVIDER.test(bare)) keys.push(`voyage/${bare}`);
  if (bare !== value) keys.push(bare);

  const lastSlash = bare.lastIndexOf("/");
  if (lastSlash > 0) keys.push(bare.slice(lastSlash + 1));

  return [...new Set(keys.filter((key) => key !== ""))];
}

/**
 * Which Platos provider a catalogue entry belongs to.
 *
 * The catalogue states it on the entry when it can. When it cannot, the key's
 * own namespace segment is the next best evidence. When there is neither, the
 * entry is filed under `unknown` rather than guessed at — an entry with no
 * discoverable provider is still a real price for a real model name, and
 * dropping it would lose a card the system might later need.
 */
export const UNKNOWN_PROVIDER = "unknown";

export function providerForCatalogueEntry(key: string, declaredProvider: string | null): string {
  if (declaredProvider !== null && declaredProvider !== "") {
    return PROVIDER_BY_CATALOGUE_PREFIX[declaredProvider] ?? declaredProvider;
  }
  const slash = key.indexOf("/");
  if (slash > 0) {
    const prefix = key.slice(0, slash);
    return PROVIDER_BY_CATALOGUE_PREFIX[prefix] ?? prefix;
  }
  return UNKNOWN_PROVIDER;
}
