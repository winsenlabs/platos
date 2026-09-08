// What this suite is joined to, and why none of it is a double of mine.
//
// Lesson one of this programme is that an assertion comparing two things the
// author controls cannot fail. So every judgement below is taken against
// something written elsewhere:
//
//   THE REAL `providers` CONTEXT. `providersContract` is assembled over the
//   in-memory ports that package PUBLISHES, so the grant this file's judge mints
//   is checked by `verifyRuntimeGrant`, the route is resolved by
//   `resolveModelRoute`, the credential is read under `secrets`' real tier rule,
//   and the price comes off a rate card ingested by `ingestRateCard`. Nothing
//   here stubs a `ProvidersContract`.
//
//   THE REAL `governance` DOMAIN. The `JudgeModel` handed to `ask` is produced by
//   `parseJudgeModel`, not written as a literal, and the refusal is checked
//   against `GOVERNANCE_ERROR_CODES` — that context's own published taxonomy.
//
//   THE PUBLISHED RATE CARD SHAPE. The catalogue below is the four-rate shape
//   `ingest-rate-card.ts` reads, and the expected cost is arithmetic on those
//   four published rates rather than a number copied out of a previous run.

import {
  asIdentifier,
  environmentScope,
  type EnvironmentId,
  type EnvironmentScope,
  type LogFields,
  type LogLevel,
  type Logger,
} from "@platos/kernel";
import { DEFAULT_GOVERNANCE_POLICY, GOVERNANCE_ERROR_CODES } from "@platos/context-governance";
import { parseJudgeModel, type JudgeModel } from "@platos/context-governance/application/ports/index.js";
import {
  providersContract,
  type CredentialName,
  type ProviderId,
  type ProviderKeyId,
  type ProvidersContract,
} from "@platos/context-providers";
import {
  buildProvidersTestContext,
  testProviderKey,
  type ProvidersTestContext,
} from "@platos/context-providers/application/testing/index.js";
import { describe, expect, it } from "vitest";

import { createProvidersJudge, JUDGE_ACTOR_ID } from "./governance-judge.js";

/** The judge's standing instructions, copied verbatim from `run-judge.ts`. */
const INSTRUCTIONS =
  "You are a strict, impartial judge scoring an AI assistant's conversation against a single criterion.";

const CRITERION_PROMPT = "Criterion: Groundedness\n\nTranscript:\nuser: hi\nassistant: hello";

/**
 * The judge model this install actually uses, taken from the shipped policy.
 *
 * NOT a literal. `run-judge.ts` resolves a criterion's own judge model or falls
 * back to exactly this value, so the string under test is the one a default
 * install will send — and the rate card below is keyed on it. If `governance`'s
 * canonical spelling and `providers`' parser ever stop agreeing, the route
 * resolves to nothing and every case here fails.
 */
const DEFAULT_JUDGE_SPEC = DEFAULT_GOVERNANCE_POLICY.evals.defaultJudgeModel;

/**
 * The rate card, in the shape `ingest-rate-card.ts` parses.
 *
 * Four separate rates, because the judge's usage exercises all four and a card
 * with one rate could not tell a cache read priced correctly from one priced as
 * fresh input.
 */
const CATALOGUE = {
  [DEFAULT_JUDGE_SPEC.replace(":", "/")]: {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
    litellm_provider: "anthropic",
    mode: "chat",
  },
};

interface Recorded {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

class RecordingLogger implements Logger {
  readonly lines: Recorded[] = [];

  log(level: LogLevel, message: string, fields?: LogFields): void {
    this.lines.push({ level, message, fields: fields ?? {} });
  }

  child(): Logger {
    return this;
  }
}

function judgeModel(spec: string): JudgeModel {
  const parsed = parseJudgeModel(spec);
  if (!parsed.ok) throw new Error(`unreachable: ${parsed.error.code}`);
  return parsed.value;
}

/** A providers context with a key, a rate card and one scripted judge answer. */
async function providersWith(
  script: { usage: Record<string, number>; text: string; reasoningTokens?: number },
): Promise<{
  readonly contract: ProvidersContract;
  readonly context: ProvidersTestContext;
  readonly logger: RecordingLogger;
}> {
  const context = buildProvidersTestContext();
  const credential = context.secrets.seed({
    name: "ANTHROPIC_API_KEY",
    provider: "anthropic",
    plaintext: "sk-live-judge",
  });
  context.repository.seedProviderKey(
    testProviderKey(context.scope, {
      providerKeyId: asIdentifier<ProviderKeyId>("key-anthropic"),
      provider: asIdentifier<ProviderId>("anthropic"),
      credentialName: asIdentifier<CredentialName>("ANTHROPIC_API_KEY"),
      credentialId: credential.id,
    }),
  );
  const contract = providersContract(context.dependencies);
  const ingested = await contract.ingestRateCard({
    catalogue: CATALOGUE,
    readAt: new Date("2025-12-01T00:00:00.000Z"),
  });
  if (!ingested.ok) throw new Error(`unreachable: ${ingested.error.code}`);
  context.modelRouter.scriptGeneration("anthropic", [
    {
      text: script.text,
      usage: script.usage,
      reasoningTokens: script.reasoningTokens ?? 0,
      finishReason: "stop",
    },
  ]);
  return { contract, context, logger: new RecordingLogger() };
}

describe("the judge is the providers context, seen through governance's port", () => {
  it("answers with the model's text, the four token counts and a real price", async () => {
    const { contract, context, logger } = await providersWith({
      text: '{"score": 80, "rationale": "grounded", "passed": true}',
      usage: {
        inputTokens: 1_300,
        outputTokens: 60,
        cacheReadInputTokens: 900,
        cacheWriteInputTokens: 0,
      },
      reasoningTokens: 12,
    });
    const judge = createProvidersJudge({ providers: contract, logger });

    const answered = await judge.ask({
      scope: context.scope,
      model: judgeModel(DEFAULT_JUDGE_SPEC),
      instructions: INSTRUCTIONS,
      prompt: CRITERION_PROMPT,
    });

    if (!answered.ok) throw new Error(`unreachable: ${answered.error.code}`);
    expect(answered.value.text).toBe('{"score": 80, "rationale": "grounded", "passed": true}');
    expect(answered.value.usage).toEqual({
      inputTokens: 1_300,
      outputTokens: 60,
      cacheReadInputTokens: 900,
      // `providers` spells this `cacheWriteInputTokens`; the port spells it
      // `cacheCreationInputTokens`. One fact, two vendors' names for it.
      cacheCreationInputTokens: 0,
      // Not on `TokenUsage` at all — summed from the steps, which is the only
      // place `providers` reports it.
      reasoningTokens: 12,
    });
    // 400 fresh input x 3e-6 + 60 output x 1.5e-5 + 900 reads x 3e-7
    //   = 0.001200 + 0.000900 + 0.000270 = 0.002370 USD = 0.2370 cents.
    expect(answered.value.costCents).toBeCloseTo(0.237, 9);
  });

  it("agrees with priceModelUsage to the digit, because it IS priceModelUsage", async () => {
    const usage = {
      inputTokens: 2_222,
      outputTokens: 71,
      cacheReadInputTokens: 333,
      cacheWriteInputTokens: 111,
    };
    const { contract, context, logger } = await providersWith({ text: "{}", usage });
    const judge = createProvidersJudge({ providers: contract, logger });

    const answered = await judge.ask({
      scope: context.scope,
      model: judgeModel(DEFAULT_JUDGE_SPEC),
      instructions: INSTRUCTIONS,
      prompt: CRITERION_PROMPT,
    });
    const priced = await contract.priceModelUsage({ model: DEFAULT_JUDGE_SPEC, usage });

    if (!answered.ok) throw new Error(`unreachable: ${answered.error.code}`);
    if (!priced.ok) throw new Error(`unreachable: ${priced.error.code}`);
    // The port narrows a canonical `Decimal(18, 6)` string to a `number`; this
    // is that narrowing, stated once and asserted rather than assumed.
    expect(answered.value.costCents).toBe(Number(priced.value.costCents));
  });

  it("asks for no tools and exactly one step, so a judge cannot act on what it scores", async () => {
    const { contract, context, logger } = await providersWith({
      text: "{}",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    const judge = createProvidersJudge({ providers: contract, logger });

    await judge.ask({
      scope: context.scope,
      model: judgeModel(DEFAULT_JUDGE_SPEC),
      instructions: INSTRUCTIONS,
      prompt: CRITERION_PROMPT,
    });

    const recorded = context.modelRouter.generations;
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.maxSteps).toBe(1);
    expect(recorded[0]?.outputKind).toBe("text");
    expect(recorded[0]?.steps[0]?.toolNames).toEqual([]);
    // TWO messages rather than one concatenated block. The ROLE split — the
    // instructions as `system`, the criterion as `user` — is deliberate and is
    // NOT asserted here, because `RecordedStep` carries a message count, the
    // breakpoint indices and the tool names and no roles; there is nothing in
    // this double to join it to, and an assertion on a value this file also
    // wrote would be the vacuity lesson one is about. It is stated in
    // `governance-judge.ts` as a design decision instead of claimed as a
    // checked one.
    expect(recorded[0]?.steps[0]?.messageCount).toBe(2);
  });

  it("routes to the provider the SPEC names, not to the install's default", async () => {
    // The mutation this exists for: sending `model.model` instead of
    // `model.spec` still passes every other case here, because a bare model name
    // routes to the default provider and the default provider is the one the
    // fixture uses. It is only visible on a judge model whose provider is NOT
    // the default — which is the whole failure `judge-model.ts` was written
    // about, where `":gpt-4o"` reached the wrong vendor's client.
    const { contract, context, logger } = await providersWith({
      text: "{}",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    const openaiCredential = context.secrets.seed({
      name: "OPENAI_API_KEY",
      provider: "openai",
      plaintext: "sk-live-openai",
    });
    context.repository.seedProviderKey(
      testProviderKey(context.scope, {
        providerKeyId: asIdentifier<ProviderKeyId>("key-openai"),
        provider: asIdentifier<ProviderId>("openai"),
        credentialName: asIdentifier<CredentialName>("OPENAI_API_KEY"),
        credentialId: openaiCredential.id,
      }),
    );
    context.modelRouter.scriptGeneration("openai", [
      { text: "{}", usage: { inputTokens: 10, outputTokens: 2 }, finishReason: "stop" },
    ]);
    const judge = createProvidersJudge({ providers: contract, logger });

    const answered = await judge.ask({
      scope: context.scope,
      model: judgeModel("openai:gpt-5-judge"),
      instructions: INSTRUCTIONS,
      prompt: CRITERION_PROMPT,
    });

    if (!answered.ok) throw new Error(`unreachable: ${answered.error.code}`);
    expect(context.modelRouter.generations.at(-1)?.provider).toBe("openai");
    expect(context.modelRouter.generations.at(-1)?.model).toBe("gpt-5-judge");
    // And the log says the same, which is what makes a stored score joinable to
    // the vendor that produced it.
    expect(logger.lines.at(-1)?.fields.provider).toBe("openai");
  });

  it("prices null rather than refusing when the install has no card for the judge's model", async () => {
    const { contract, context, logger } = await providersWith({
      text: "{}",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    context.modelRouter.scriptGeneration("anthropic", [
      { text: "{}", usage: { inputTokens: 10, outputTokens: 2 }, finishReason: "stop" },
    ]);
    const judge = createProvidersJudge({ providers: contract, logger });

    // A model the catalogue above does not carry a card for. The route still
    // resolves — routing and pricing are separate questions — so the call is
    // made, paid for, and answered with a null price rather than thrown away.
    const answered = await judge.ask({
      scope: context.scope,
      model: judgeModel("anthropic:claude-haiku-9-9"),
      instructions: INSTRUCTIONS,
      prompt: CRITERION_PROMPT,
    });

    if (!answered.ok) throw new Error(`unreachable: ${answered.error.code}`);
    expect(answered.value.text).toBe("{}");
    expect(answered.value.costCents).toBeNull();
    expect(logger.lines.at(-1)?.fields.priced).toBe(false);
  });
});

describe("the grant it mints, and the environment it cannot leave", () => {
  it("reads keys for the scope it was handed, and the vault accepts the mint", async () => {
    const { contract, context, logger } = await providersWith({
      text: "{}",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    const judge = createProvidersJudge({ providers: contract, logger });

    const answered = await judge.ask({
      scope: context.scope,
      model: judgeModel(DEFAULT_JUDGE_SPEC),
      instructions: INSTRUCTIONS,
      prompt: CRITERION_PROMPT,
    });

    // `verifyRuntimeGrant` runs `isMintedAuthorization` against `secrets`' own
    // WeakSet register and then compares the ancestry field for field. An
    // object shaped like a grant does not get this far, so an `ok` here is the
    // vault's judgement on the mint, not this file's.
    expect(answered.ok).toBe(true);
  });

  it("cannot read another environment's keys with a scope it was handed", async () => {
    const { contract, context, logger } = await providersWith({
      text: "{}",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    const judge = createProvidersJudge({ providers: contract, logger });

    const elsewhere: EnvironmentScope = environmentScope(
      context.scope.organizationId,
      context.scope.projectId,
      asIdentifier<EnvironmentId>("env-2"),
    );
    const answered = await judge.ask({
      scope: elsewhere,
      model: judgeModel(DEFAULT_JUDGE_SPEC),
      instructions: INSTRUCTIONS,
      prompt: CRITERION_PROMPT,
    });

    // The grant is minted FOR the scope it is handed, so it is `secret:read` in
    // env-2 and in nothing else — and env-2 has no provider key, so the vault
    // refuses. What this pins is that the mint does not widen: a grant minted
    // for one environment cannot read the environment the keys are actually in.
    expect(answered.ok).toBe(false);
    if (answered.ok) throw new Error("unreachable");
    expect(answered.error.code).toBe("GOVERNANCE_JUDGE_UNAVAILABLE");
  });

  it("attributes the call to a system actor that cannot be mistaken for a user", () => {
    // `User.id` is `@db.Uuid` in the canonical schema. A URN is not a UUID, so
    // an audit row carrying this can never be read back as a person.
    expect(JUDGE_ACTOR_ID).toBe("urn:platos:system:governance-judge");
    expect(JUDGE_ACTOR_ID).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
    );
  });
});

describe("a judge that could not be reached is an answer, not an exception", () => {
  it("refuses with governance's own code and never with the provider's", async () => {
    const { contract, context, logger } = await providersWith({
      text: "{}",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    context.modelRouter.breakProvider("anthropic");
    const judge = createProvidersJudge({ providers: contract, logger });

    const answered = await judge.ask({
      scope: context.scope,
      model: judgeModel(DEFAULT_JUDGE_SPEC),
      instructions: INSTRUCTIONS,
      prompt: CRITERION_PROMPT,
    });

    expect(answered.ok).toBe(false);
    if (answered.ok) throw new Error("unreachable");
    // Joined to `governance`'s published taxonomy, not to a literal: a code this
    // context does not declare cannot reach a transport that has no mapping for
    // it, and `PROVIDERS_*` is exactly such a code.
    expect(GOVERNANCE_ERROR_CODES).toContain(answered.error.code);
    expect(answered.error.code).toBe("GOVERNANCE_JUDGE_UNAVAILABLE");
    expect(answered.error.code.startsWith("PROVIDERS_")).toBe(false);
    // The provider's own words survive where the port allows them to.
    expect(String(answered.error.details?.reason)).toContain("PROVIDERS_");
  });

  it("leaves the route and the cause on the log, which is the only replay the port permits", async () => {
    const { contract, context, logger } = await providersWith({
      text: "{}",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    context.modelRouter.breakProvider("anthropic");
    const judge = createProvidersJudge({ providers: contract, logger });

    await judge.ask({
      scope: context.scope,
      model: judgeModel(DEFAULT_JUDGE_SPEC),
      instructions: INSTRUCTIONS,
      prompt: CRITERION_PROMPT,
    });

    const line = logger.lines.find((entry) => entry.message === "governance.judge.unavailable");
    expect(line?.level).toBe("warn");
    expect(line?.fields.judgeModel).toBe(DEFAULT_JUDGE_SPEC);
    expect(line?.fields.environmentId).toBe(context.scope.environmentId);
    expect(String(line?.fields.causeCode)).toContain("PROVIDERS_");
  });

  it("fingerprints the prompt without putting the conversation in the log", async () => {
    const { contract, context, logger } = await providersWith({
      text: "{}",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    const judge = createProvidersJudge({ providers: contract, logger });
    const secret = `Criterion: X\n\n${"the customer's card number is 4111 1111 1111 1111. ".repeat(8)}`;

    await judge.ask({
      scope: context.scope,
      model: judgeModel(DEFAULT_JUDGE_SPEC),
      instructions: INSTRUCTIONS,
      prompt: secret,
    });

    const line = logger.lines.find((entry) => entry.message === "governance.judge.answered");
    const printed = String(line?.fields.promptFingerprint);
    expect(printed).toContain(String(secret.length));
    expect(printed).not.toContain("4111 1111 1111 1111");
    // Short enough that the middle of a transcript cannot be in it at all.
    expect(printed.length).toBeLessThan(64);
  });
});
