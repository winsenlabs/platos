import { moneyToCentsString } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  asProvidersIdentifier,
  textPart,
  TEXT_OUTPUT,
  NO_SAMPLING_LIMITS,
  type CredentialName,
  type GenerationEvent,
  type Prompt,
  type ProviderId,
  type ProviderKeyId,
  type ToolCallPart,
  type ToolDefinition,
  type ToolResultPart,
} from "../domain/index.js";
import { ingestRateCard } from "./ingest-rate-card.js";
import { priceModelUsage } from "./price-model-usage.js";
import { runModelGeneration, streamModelGeneration } from "./run-model-generation.js";
import type { RunModelGenerationCommand } from "./run-model-generation.js";
import {
  buildProvidersTestContext,
  otherEnvironment,
  testProviderKey,
  type ProvidersTestContext,
} from "./testing/index.js";

const SEARCH: ToolDefinition = {
  name: "search",
  description: "search the index",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
};

/** A prompt with a marked system message and one user turn. */
function conversation(): Prompt {
  return {
    messages: [
      { role: "system", content: [textPart("you are helpful")], cacheBreakpoint: true },
      { role: "user", content: [textPart("find me x")], cacheBreakpoint: false },
    ],
  };
}

function configure(context: ProvidersTestContext, provider = "anthropic"): void {
  const name = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const credential = context.secrets.seed({ name, provider, plaintext: "sk-live" });
  context.repository.seedProviderKey(
    testProviderKey(context.scope, {
      providerKeyId: asProvidersIdentifier<ProviderKeyId>(`key-${provider}`),
      provider: asProvidersIdentifier<ProviderId>(provider),
      credentialName: asProvidersIdentifier<CredentialName>(name),
      credentialId: credential.id,
    }),
  );
}

/** Every tool call is answered with the same shape, so a test can compare it. */
const answer = async (call: ToolCallPart): Promise<ToolResultPart> => ({
  kind: "tool-result",
  toolCallId: call.toolCallId,
  toolName: call.toolName,
  output: { hits: 2 },
  failed: false,
});

function command(
  context: ProvidersTestContext,
  overrides: Partial<RunModelGenerationCommand> = {},
): RunModelGenerationCommand {
  return {
    authorization: context.secrets.runtimeGrant(),
    scope: context.scope,
    model: "anthropic:claude-sonnet-4-6",
    prompt: conversation(),
    tools: [SEARCH],
    executeTool: answer,
    output: TEXT_OUTPUT,
    sampling: NO_SAMPLING_LIMITS,
    maxSteps: 8,
    ...overrides,
  };
}

/** Two steps: one that calls the tool, one that answers. */
function scriptTwoSteps(context: ProvidersTestContext): void {
  context.modelRouter.scriptGeneration("anthropic", [
    {
      usage: { inputTokens: 1_000, outputTokens: 20, cacheWriteInputTokens: 900 },
      toolCalls: [{ toolCallId: "call-1", toolName: "search", input: { q: "x" } }],
    },
    {
      text: "x is over there",
      usage: { inputTokens: 1_200, outputTokens: 40, cacheReadInputTokens: 900 },
      reasoningTokens: 7,
    },
  ]);
}

describe("running a generation", () => {
  it("runs every scripted step, through the caller's own tool executor", async () => {
    const context = buildProvidersTestContext();
    configure(context);
    scriptTwoSteps(context);
    const ran: string[] = [];

    const outcome = await runModelGeneration(
      context.dependencies,
      command(context, {
        executeTool: async (call) => {
          ran.push(`${call.toolName}:${call.toolCallId}`);
          return answer(call);
        },
      }),
    );
    if (!outcome.ok) throw new Error(`unreachable: ${outcome.error.code}`);
    expect(ran).toEqual(["search:call-1"]);
    expect(outcome.value.generation.steps).toHaveLength(2);
    expect(outcome.value.generation.text).toBe("x is over there");
    expect(outcome.value.generation.steps[0]?.finishReason).toBe("tool-calls");
    expect(outcome.value.generation.steps[1]?.finishReason).toBe("stop");
  });

  it("adds the steps up into a total the caller can bill", async () => {
    const context = buildProvidersTestContext();
    configure(context);
    scriptTwoSteps(context);

    const outcome = await runModelGeneration(context.dependencies, command(context));
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.value.generation.totalUsage).toEqual({
      inputTokens: 2_200,
      outputTokens: 60,
      cacheReadInputTokens: 900,
      cacheWriteInputTokens: 900,
    });
  });

  it("names the route and the key that paid, and hands the router the MATERIAL", async () => {
    const context = buildProvidersTestContext();
    configure(context);
    scriptTwoSteps(context);

    const outcome = await runModelGeneration(context.dependencies, command(context));
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.value.plan.reference.provider).toBe("anthropic");
    expect(outcome.value.plan.reference.modelName).toBe("claude-sonnet-4-6");
    expect(outcome.value.providerKey.providerKeyId).toBe("key-anthropic");
    expect(context.modelRouter.generations[0]?.revealed).toBe("sk-live");
    expect(context.modelRouter.generations[0]?.maxSteps).toBe(8);
  });

  it("stops at the step budget even when the script would go on", async () => {
    const context = buildProvidersTestContext();
    configure(context);
    context.modelRouter.scriptGeneration("anthropic", [
      { usage: { inputTokens: 1, outputTokens: 1 } },
      { usage: { inputTokens: 2, outputTokens: 2 } },
      { usage: { inputTokens: 4, outputTokens: 4 } },
    ]);

    const outcome = await runModelGeneration(context.dependencies, command(context, { maxSteps: 2 }));
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.value.generation.steps).toHaveLength(2);
    expect(outcome.value.generation.totalUsage.inputTokens).toBe(3);
  });
});

describe("the cache breakpoints the caller never asked for", () => {
  it("re-places them at the top of EVERY step, moving the head as the array grows", async () => {
    const context = buildProvidersTestContext();
    configure(context);
    scriptTwoSteps(context);

    await runModelGeneration(context.dependencies, command(context));
    const steps = context.modelRouter.generations[0]?.steps ?? [];
    expect(steps).toHaveLength(2);
    // Step one sees [system, user]: the system keeps its own mark, the head is
    // index 1. Step two sees the assistant tool-call and tool-result messages
    // the round trip added, so the head has MOVED to index 3 -- and index 1 no
    // longer carries a mark, which is the property the whole rule turns on.
    expect(steps[0]?.messageCount).toBe(2);
    expect(steps[0]?.breakpointIndices).toEqual([0, 1]);
    expect(steps[1]?.messageCount).toBe(4);
    expect(steps[1]?.breakpointIndices).toEqual([0, 3]);
  });

  it("places NONE for a route whose provider honours none", async () => {
    const context = buildProvidersTestContext();
    configure(context, "openai");
    context.modelRouter.scriptGeneration("openai", [{ usage: { inputTokens: 5, outputTokens: 1 } }]);

    const outcome = await runModelGeneration(
      context.dependencies,
      command(context, { model: "openai:gpt-4.1" }),
    );
    if (!outcome.ok) throw new Error(`unreachable: ${outcome.error.code}`);
    // Only the system message, whose mark the caller placed and this context
    // never removes.
    expect(context.modelRouter.generations[0]?.steps[0]?.breakpointIndices).toEqual([0]);
  });
});

describe("what it refuses, and refuses BEFORE spending anything", () => {
  async function refuse(overrides: Partial<RunModelGenerationCommand>) {
    const context = buildProvidersTestContext();
    configure(context);
    scriptTwoSteps(context);
    const outcome = await runModelGeneration(context.dependencies, command(context, overrides));
    return { context, outcome };
  }

  it("refuses a step budget of zero, and never opens a route", async () => {
    const { context, outcome } = await refuse({ maxSteps: 0 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("PROVIDERS_STEP_BUDGET_INVALID");
    expect(context.modelRouter.opens).toEqual([]);
    expect(context.modelRouter.generations).toEqual([]);
  });

  it("refuses two tools of one name, and never opens a route", async () => {
    const { context, outcome } = await refuse({ tools: [SEARCH, { ...SEARCH, description: "other" }] });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("PROVIDERS_TOOL_NAME_DUPLICATED");
    expect(context.modelRouter.opens).toEqual([]);
  });

  it("refuses a prompt already carrying more marks than the provider honours", async () => {
    const overloaded: Prompt = {
      messages: Array.from({ length: 5 }, (_unused, index) => ({
        role: index === 0 ? ("system" as const) : ("user" as const),
        content: [textPart(`m${index}`)],
        cacheBreakpoint: true,
      })),
    };
    const { context, outcome } = await refuse({ prompt: overloaded });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("PROVIDERS_CACHE_BUDGET_EXCEEDED");
    expect(outcome.error.details).toEqual({ placed: 5, allowed: 4 });
    expect(context.modelRouter.opens).toEqual([]);
  });

  it("refuses a session that has already expired, under its own code", async () => {
    const context = buildProvidersTestContext();
    configure(context);
    scriptTwoSteps(context);
    // Opened bindings expire one second before the clock this context reads, so
    // the refusal is the expiry and not a clock skew.
    const expired = new Date(context.clock.now().getTime() - 1_000);
    context.modelRouter.expireSessionsAt(expired);

    const outcome = await runModelGeneration(context.dependencies, command(context));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("PROVIDERS_MODEL_SESSION_EXPIRED");
    expect(outcome.error.details).toEqual({ sessionId: "session-1", expiredAt: expired.toISOString() });
    // The route was opened -- that is how the handle exists -- but nothing was
    // generated against it.
    expect(context.modelRouter.opens).toHaveLength(1);
    expect(context.modelRouter.generations).toEqual([]);
  });

  it("accepts a session that expires LATER, so the guard is not just 'has an expiry'", async () => {
    const context = buildProvidersTestContext();
    configure(context);
    scriptTwoSteps(context);
    context.modelRouter.expireSessionsAt(new Date(context.clock.now().getTime() + 1_000));

    const outcome = await runModelGeneration(context.dependencies, command(context));
    expect(outcome.ok).toBe(true);
  });

  it("refuses a runtime grant minted for another environment", async () => {
    const context = buildProvidersTestContext();
    configure(context);
    const outcome = await runModelGeneration(
      context.dependencies,
      command(context, { authorization: context.secrets.runtimeGrant(otherEnvironment()) }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("PROVIDERS_SCOPE_MISMATCH");
    expect(context.modelRouter.opens).toEqual([]);
  });

  it("refuses when this environment has registered no key for the provider", async () => {
    const context = buildProvidersTestContext();
    const outcome = await runModelGeneration(context.dependencies, command(context));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("PROVIDERS_CONFIGURATION_UNAVAILABLE");
  });
});

describe("the streaming path", () => {
  it("admits on exactly the same terms as the non-streaming one", async () => {
    const context = buildProvidersTestContext();
    configure(context);
    scriptTwoSteps(context);

    const refused = await streamModelGeneration(context.dependencies, command(context, { maxSteps: 0 }));
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error.code).toBe("PROVIDERS_STEP_BUDGET_INVALID");
  });

  it("delivers the round trip as events and ends in exactly one `finished`", async () => {
    const context = buildProvidersTestContext();
    configure(context);
    scriptTwoSteps(context);

    const started = await streamModelGeneration(context.dependencies, command(context));
    if (!started.ok) throw new Error(`unreachable: ${started.error.code}`);
    const events: GenerationEvent[] = [];
    for await (const event of started.value.events) events.push(event);

    expect(events.map((event) => event.kind)).toEqual([
      "tool-call",
      "tool-result",
      "step-finished",
      "text-delta",
      "step-finished",
      "finished",
    ]);
    const last = events[events.length - 1];
    if (last?.kind !== "finished") throw new Error("unreachable");
    expect(last.generation.totalUsage.cacheReadInputTokens).toBe(900);
  });
});

describe("what the cache accounting is actually worth", () => {
  // The whole reason the four counts survive the port: they are priced at four
  // separate rates, so a cached turn and an uncached one of the same size do
  // not cost the same. Rates below are the shipped catalogue's own shape --
  // reads at a tenth of input, writes at 1.25x.
  const CATALOGUE = {
    "anthropic/claude-sonnet-4-6": {
      input_cost_per_token: 3e-6,
      output_cost_per_token: 1.5e-5,
      cache_read_input_token_cost: 3e-7,
      cache_creation_input_token_cost: 3.75e-6,
      litellm_provider: "anthropic",
      mode: "chat",
    },
  };

  async function priced(context: ProvidersTestContext, usage: Record<string, number>) {
    return priceModelUsage(context.dependencies, {
      model: "anthropic:claude-sonnet-4-6",
      at: context.clock.now(),
      usage,
    });
  }

  it("charges a generation's derived total, cache counts and all", async () => {
    const context = buildProvidersTestContext();
    configure(context);
    scriptTwoSteps(context);
    const ingested = await ingestRateCard(context.dependencies, {
      catalogue: CATALOGUE,
      readAt: new Date("2025-12-01T00:00:00.000Z"),
    });
    if (!ingested.ok) throw new Error(`unreachable: ${ingested.error.code}`);

    const outcome = await runModelGeneration(context.dependencies, command(context));
    if (!outcome.ok) throw new Error(`unreachable: ${outcome.error.code}`);

    const cached = await priced(context, { ...outcome.value.generation.totalUsage });
    if (!cached.ok) throw new Error(`unreachable: ${cached.error.code}`);
    // 400 fresh input x 3e-6 + 60 output x 1.5e-5 + 900 reads x 3e-7
    //   + 900 writes x 3.75e-6  =  0.001200 + 0.000900 + 0.000270 + 0.003375
    //   = 0.005745 USD = 0.5745 cents.
    expect(moneyToCentsString(cached.value.amount)).toBe("0.574500");
    expect(cached.value.charged).toEqual({ input: 400, output: 60, cacheRead: 900, cacheWrite: 900 });
  });

  it("costs MORE when the same tokens are read fresh, which is the whole point", async () => {
    const context = buildProvidersTestContext();
    const ingested = await ingestRateCard(context.dependencies, {
      catalogue: CATALOGUE,
      readAt: new Date("2025-12-01T00:00:00.000Z"),
    });
    if (!ingested.ok) throw new Error("unreachable");

    const uncached = await priced(context, { inputTokens: 2_200, outputTokens: 60 });
    if (!uncached.ok) throw new Error(`unreachable: ${uncached.error.code}`);
    // 2200 x 3e-6 + 60 x 1.5e-5 = 0.006600 + 0.000900 = 0.0075 USD = 0.75 cents.
    expect(moneyToCentsString(uncached.value.amount)).toBe("0.750000");
    expect(Number(moneyToCentsString(uncached.value.amount))).toBeGreaterThan(0.5745);
  });
});
