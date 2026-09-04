import { describe, expect, it } from "vitest";

import { DEFAULT_JUDGE_PROVIDER, JUDGE_PROVIDERS, isJudgeProvider, parseJudgeModel, requireDistinctJudge } from "./judge-model.js";

describe("parseJudgeModel", () => {
  it("splits `<provider>:<model>`", () => {
    const parsed = parseJudgeModel("openai:gpt-5");
    expect(parsed.ok && parsed.value).toEqual({ provider: "openai", model: "gpt-5", spec: "openai:gpt-5" });
  });

  it("resolves a bare model to the default provider and CANONICALISES the spec", () => {
    const parsed = parseJudgeModel("claude-haiku-4-5-20251001");
    expect(parsed.ok && parsed.value.provider).toBe(DEFAULT_JUDGE_PROVIDER);
    expect(parsed.ok && parsed.value.spec).toBe("anthropic:claude-haiku-4-5-20251001");
  });

  it("keeps everything after the FIRST colon as the model name", () => {
    const parsed = parseJudgeModel("google:models/gemini:2");
    expect(parsed.ok && parsed.value.model).toBe("models/gemini:2");
  });

  it("REFUSES a leading colon rather than reading it as no provider segment", () => {
    // `colonIdx > 0 ? slice(0, colonIdx) : "anthropic"` sends `":gpt-4o"` to
    // anthropic as a model literally beginning with a colon.
    const parsed = parseJudgeModel(":gpt-4o");
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error.details).toEqual({ spec: ":gpt-4o", reason: "leading-separator" });
  });

  it("REFUSES a blank specification", () => {
    const parsed = parseJudgeModel("   ");
    expect(!parsed.ok && parsed.error.details).toMatchObject({ reason: "blank" });
  });

  it("REFUSES a provider with no model after it", () => {
    const parsed = parseJudgeModel("openai:");
    expect(!parsed.ok && parsed.error.details).toMatchObject({ reason: "empty-model" });
  });

  it("REFUSES an unsupported provider UP FRONT, before a transcript is read", () => {
    const parsed = parseJudgeModel("cohere:command-r");
    expect(!parsed.ok && parsed.error.code).toBe("GOVERNANCE_JUDGE_MODEL_INVALID");
    expect(!parsed.ok && parsed.error.details).toMatchObject({ reason: "unsupported-provider" });
  });

  it("admits every declared provider, so the closed set is not narrower than it says", () => {
    for (const provider of JUDGE_PROVIDERS) {
      expect(parseJudgeModel(`${provider}:some-model`).ok).toBe(true);
    }
    expect(isJudgeProvider("anthropic")).toBe(true);
    expect(isJudgeProvider("Anthropic")).toBe(false);
  });
});

describe("requireDistinctJudge — the no-self-evaluation invariant", () => {
  function judge(spec: string) {
    const parsed = parseJudgeModel(spec);
    if (!parsed.ok) throw new Error("unreachable");
    return parsed.value;
  }

  it("admits a judge that is a different model", () => {
    expect(requireDistinctJudge(judge("openai:gpt-5"), "anthropic:claude-sonnet-4-6").ok).toBe(true);
  });

  it("REFUSES the same model spelled the same way", () => {
    const checked = requireDistinctJudge(judge("anthropic:claude-x"), "anthropic:claude-x");
    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.error.code).toBe("GOVERNANCE_EVAL_SELF_JUDGED");
  });

  it("REFUSES the same model spelled DIFFERENTLY — the defect this replaces", () => {
    // The source compares the raw strings, so an agent whose model column reads
    // `claude-x` and a criterion whose judge reads `anthropic:claude-x` are the
    // same model and that comparison says they differ: the guard passes and the
    // model grades its own homework. Failing OPEN is the worst direction for
    // this particular invariant.
    const checked = requireDistinctJudge(judge("anthropic:claude-x"), "claude-x");
    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.error.code).toBe("GOVERNANCE_EVAL_SELF_JUDGED");
  });

  it("REFUSES the mirror image: an unprefixed judge against a prefixed agent", () => {
    expect(requireDistinctJudge(judge("claude-x"), "anthropic:claude-x").ok).toBe(false);
  });

  it("still admits two models that differ only by provider", () => {
    expect(requireDistinctJudge(judge("openai:shared-name"), "google:shared-name").ok).toBe(true);
  });

  it("REFUSES rather than proceeding when the agent's model cannot be read", () => {
    // "We could not tell whether this is self-evaluation" must never resolve to
    // "carry on".
    const checked = requireDistinctJudge(judge("openai:gpt-5"), ":broken");
    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.error.code).toBe("GOVERNANCE_JUDGE_MODEL_INVALID");
    expect(!checked.ok && checked.error.details).toMatchObject({ reason: "agent-model-unreadable" });
  });

  it("names BOTH models in the refusal, in canonical form", () => {
    const checked = requireDistinctJudge(judge("anthropic:claude-x"), "claude-x");
    expect(!checked.ok && checked.error.details).toEqual({
      judgeModel: "anthropic:claude-x",
      agentModel: "anthropic:claude-x",
    });
  });
});
