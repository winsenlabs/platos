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
  ModelGenerationRequest,
  ModelRoutePlan,
  Prompt,
  ProviderCredential,
  ProviderDialect,
  ToolCallPart,
  ToolResultPart,
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

// --- the framework's own mock, and what a request looks like -----------------
//
// The double every suite in this package runs against is `MockLanguageModelV4`,
// which sits at the PROVIDER SPECIFICATION boundary: usage normalisation, the
// tool loop, `prepareStep`, `repairToolCall` and the object mode are all the
// real framework running for real, and only the wire is faked. A hand-written
// double of `generateText` would have let these suites agree with an adapter
// that never places a cache marker and reads usage out of the wrong field,
// because the double would have been built from the same misunderstanding as
// the code.

/** The two provider-specification shapes these suites construct. */
type Count = number | undefined;

export type SpecUsage = {
  inputTokens: { total: Count; noCache: Count; cacheRead: Count; cacheWrite: Count };
  outputTokens: { total: Count; text: Count; reasoning: Count };
};

export type SpecCallOptions = {
  prompt: readonly { role: string; providerOptions?: unknown }[];
};

/** Usage with nothing about caching in it, so the metadata chains must be used. */
export function bareUsage(input: number, output: number): SpecUsage {
  return {
    inputTokens: { total: input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

/** Usage the framework has already normalised. */
export function normalisedUsage(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  reasoning?: number,
): SpecUsage {
  return {
    inputTokens: { total: input, noCache: undefined, cacheRead, cacheWrite },
    outputTokens: { total: output, text: output - (reasoning ?? 0), reasoning },
  };
}

/** A request with a system message that carries a cache breakpoint. */
export function generationRequest(
  overrides: Partial<ModelGenerationRequest> = {},
): ModelGenerationRequest {
  const source: Prompt = {
    messages: [
      { role: "system", content: [{ kind: "text", text: "rules" }], cacheBreakpoint: true },
      { role: "user", content: [{ kind: "text", text: "hello" }], cacheBreakpoint: false },
    ],
  };
  return {
    session: { sessionId: "s1", plan: ANTHROPIC_PLAN, expiresAt: null },
    credential: credential("sk-live"),
    prompt: source,
    tools: [],
    executeTool: () => Promise.reject(new Error("no tools in this fixture")),
    output: { kind: "text" },
    sampling: { maxOutputTokens: null, temperature: null },
    maxSteps: 5,
    rewritePrompt: (given) => given,
    abortSignal: null,
    ...overrides,
  };
}

/** A tool answering with `output`, or reporting a failure. */
export function answering(output: unknown, failed = false) {
  return async (call: ToolCallPart): Promise<ToolResultPart> => ({
    kind: "tool-result",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output,
    failed,
  });
}
