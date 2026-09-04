import { describe, expect, it } from "vitest";

import {
  cacheReadTokens,
  cacheWriteTokens,
  readStepCounts,
  reasoningTokens,
  usageDraft,
  type FrameworkUsage,
} from "./usage.js";

// EXACT NUMBERS, ONE PER PROVIDER, AND ALL DIFFERENT.
//
// Every assertion below names a specific integer rather than a shape, because a
// shape assertion is exactly the test that would still pass if the whole chain
// read zero — which is the failure this file exists to prevent, and which costs
// 300 cents a turn when it happens. The numbers are deliberately distinct per
// provider so a chain that reached the wrong link cannot accidentally agree.
const NORMALISED_READ = 11_111;
const ANTHROPIC_RAW_READ = 22_222;
const ANTHROPIC_READ = 33_333;
const OPENAI_READ = 44_444;
const GOOGLE_READ = 55_555;
const VERTEX_READ = 66_666;

const NORMALISED_WRITE = 1_100;
const ANTHROPIC_RAW_WRITE = 2_200;
const ANTHROPIC_WRITE = 3_300;
const VERTEX_WRITE = 4_400;

const NORMALISED_REASONING = 710;
const OPENAI_REASONING = 720;
const GOOGLE_REASONING = 730;
const VERTEX_REASONING = 740;

/** A usage blob that reports a prompt total and NOTHING about caching. */
function bareUsage(inputTokens = 100_000, outputTokens = 500): FrameworkUsage {
  return { inputTokens, outputTokens };
}

describe("the cache-read chain", () => {
  it("prefers the framework's own normalised figure over every provider shape", () => {
    const usage: FrameworkUsage = { inputTokens: 1, inputTokenDetails: { cacheReadTokens: NORMALISED_READ } };
    const meta = {
      anthropic: { usage: { cache_read_input_tokens: ANTHROPIC_RAW_READ }, cacheReadInputTokens: ANTHROPIC_READ },
      openai: { cachedPromptTokens: OPENAI_READ },
      google: { usageMetadata: { cachedContentTokenCount: GOOGLE_READ } },
      vertex: { usageMetadata: { cachedContentTokenCount: VERTEX_READ } },
    };

    expect(cacheReadTokens(usage, meta)).toBe(NORMALISED_READ);
  });

  it("reads Anthropic's RAW passthrough shape, which the shorter chain misses", () => {
    // This is the link the extraction source's non-streaming readers do not
    // have. A response carrying only this shape reads ZERO under those readers,
    // and a zero cache read is a well-formed usage record: the turn succeeds,
    // the trace looks fine, and the whole prompt is billed at the full rate.
    const meta = { anthropic: { usage: { cache_read_input_tokens: ANTHROPIC_RAW_READ } } };

    expect(cacheReadTokens(bareUsage(), meta)).toBe(ANTHROPIC_RAW_READ);
  });

  it("reads Anthropic's normalised shape", () => {
    expect(cacheReadTokens(bareUsage(), { anthropic: { cacheReadInputTokens: ANTHROPIC_READ } })).toBe(
      ANTHROPIC_READ,
    );
  });

  it("reads OpenAI's shape", () => {
    expect(cacheReadTokens(bareUsage(), { openai: { cachedPromptTokens: OPENAI_READ } })).toBe(OPENAI_READ);
  });

  it("reads direct Gemini's shape", () => {
    expect(
      cacheReadTokens(bareUsage(), { google: { usageMetadata: { cachedContentTokenCount: GOOGLE_READ } } }),
    ).toBe(GOOGLE_READ);
  });

  it("reads the SAME model served through Vertex under its own key", () => {
    // Vertex has its own key rather than sharing Google's. Collapsing the two
    // would zero one of the two routes, and it is not obvious which.
    expect(
      cacheReadTokens(bareUsage(), { vertex: { usageMetadata: { cachedContentTokenCount: VERTEX_READ } } }),
    ).toBe(VERTEX_READ);
  });

  it("walks PAST a zero rather than reporting it, which `??` would not", () => {
    // A provider that reports a cache read of zero has reported nothing useful.
    // With `??` the chain would stop at the zero and the later shape carrying
    // the real figure would never be consulted.
    const usage: FrameworkUsage = { inputTokens: 1, inputTokenDetails: { cacheReadTokens: 0 } };

    expect(cacheReadTokens(usage, { openai: { cachedPromptTokens: OPENAI_READ } })).toBe(OPENAI_READ);
  });

  it("is zero when no shape carries anything", () => {
    expect(cacheReadTokens(bareUsage(), undefined)).toBe(0);
    expect(cacheReadTokens(undefined, {})).toBe(0);
  });

  it("reads a malformed figure as absent rather than letting NaN reach the bill", () => {
    // The extraction source's chains end in a bare `Number(...)`, so a string or
    // a NaN in the last position yields NaN and NaN flows into the accounting.
    const meta = {
      anthropic: { cacheReadInputTokens: "lots" },
      openai: { cachedPromptTokens: Number.NaN },
      google: { usageMetadata: { cachedContentTokenCount: -5 } },
      vertex: { usageMetadata: { cachedContentTokenCount: VERTEX_READ } },
    };

    expect(cacheReadTokens(bareUsage(), meta)).toBe(VERTEX_READ);
  });

  it("does not read a cache WRITE figure as a read", () => {
    const meta = { anthropic: { cacheCreationInputTokens: ANTHROPIC_WRITE } };

    expect(cacheReadTokens(bareUsage(), meta)).toBe(0);
  });
});

describe("the cache-write chain", () => {
  it("prefers the framework's normalised figure", () => {
    const usage: FrameworkUsage = { inputTokens: 1, inputTokenDetails: { cacheWriteTokens: NORMALISED_WRITE } };
    const meta = { anthropic: { usage: { cache_creation_input_tokens: ANTHROPIC_RAW_WRITE } } };

    expect(cacheWriteTokens(usage, meta)).toBe(NORMALISED_WRITE);
  });

  it("reads Anthropic's raw passthrough shape", () => {
    expect(
      cacheWriteTokens(bareUsage(), { anthropic: { usage: { cache_creation_input_tokens: ANTHROPIC_RAW_WRITE } } }),
    ).toBe(ANTHROPIC_RAW_WRITE);
  });

  it("reads Anthropic's normalised shape", () => {
    expect(cacheWriteTokens(bareUsage(), { anthropic: { cacheCreationInputTokens: ANTHROPIC_WRITE } })).toBe(
      ANTHROPIC_WRITE,
    );
  });

  it("reads Vertex's shape", () => {
    expect(cacheWriteTokens(bareUsage(), { vertex: { cacheCreationInputTokens: VERTEX_WRITE } })).toBe(
      VERTEX_WRITE,
    );
  });

  it("has no OpenAI or Google link, because neither bills a cache write", () => {
    const meta = {
      openai: { cachedPromptTokens: OPENAI_READ, cacheCreationInputTokens: 999 },
      google: { usageMetadata: { cachedContentTokenCount: GOOGLE_READ } },
    };

    expect(cacheWriteTokens(bareUsage(), meta)).toBe(0);
  });

  it("does not read a cache READ figure as a write", () => {
    expect(cacheWriteTokens(bareUsage(), { anthropic: { cacheReadInputTokens: ANTHROPIC_READ } })).toBe(0);
  });
});

describe("the reasoning chain", () => {
  it("prefers the framework's normalised figure", () => {
    const usage: FrameworkUsage = {
      inputTokens: 1,
      outputTokenDetails: { reasoningTokens: NORMALISED_REASONING },
    };

    expect(reasoningTokens(usage, { openai: { reasoningTokens: OPENAI_REASONING } })).toBe(
      NORMALISED_REASONING,
    );
  });

  it("reads OpenAI, direct Gemini and Vertex under their own keys", () => {
    expect(reasoningTokens(bareUsage(), { openai: { reasoningTokens: OPENAI_REASONING } })).toBe(
      OPENAI_REASONING,
    );
    expect(
      reasoningTokens(bareUsage(), { google: { usageMetadata: { thoughtsTokenCount: GOOGLE_REASONING } } }),
    ).toBe(GOOGLE_REASONING);
    expect(
      reasoningTokens(bareUsage(), { vertex: { usageMetadata: { thoughtsTokenCount: VERTEX_REASONING } } }),
    ).toBe(VERTEX_REASONING);
  });
});

describe("one step's counts", () => {
  it("carries every figure through at its exact value", () => {
    const usage: FrameworkUsage = {
      inputTokens: 1_684_498,
      outputTokens: 12_345,
      inputTokenDetails: { cacheReadTokens: 198_224, cacheWriteTokens: 4_096 },
      outputTokenDetails: { reasoningTokens: 6_000 },
    };

    // The production trace this whole surface exists for, read back exactly.
    expect(readStepCounts(usage, undefined)).toEqual({
      inputTokens: 1_684_498,
      outputTokens: 12_345,
      cacheReadInputTokens: 198_224,
      cacheWriteInputTokens: 4_096,
      reasoningTokens: 6_000,
    });
  });

  it("mixes a normalised read with a provider-metadata write", () => {
    // Real responses are not uniform: one figure can be normalised while the
    // other is only in provider metadata, and a reader that consults one source
    // per step loses whichever half the provider did not normalise.
    const usage: FrameworkUsage = {
      inputTokens: 90_000,
      outputTokens: 100,
      inputTokenDetails: { cacheReadTokens: NORMALISED_READ },
    };
    const meta = { anthropic: { cacheCreationInputTokens: ANTHROPIC_WRITE } };

    expect(readStepCounts(usage, meta)).toEqual({
      inputTokens: 90_000,
      outputTokens: 100,
      cacheReadInputTokens: NORMALISED_READ,
      cacheWriteInputTokens: ANTHROPIC_WRITE,
      reasoningTokens: 0,
    });
  });

  it("keeps a reading admissible when the provider reported cache tokens and no total", () => {
    // `tokenUsage` refuses a reading whose cache counts exceed its input count.
    // A provider that omits the prompt total while reporting a cache read would
    // produce exactly that refusal and fail an otherwise fine turn, so the total
    // becomes the smallest number consistent with the reading — never larger,
    // so a bill cannot be inflated by this.
    const meta = { anthropic: { cacheReadInputTokens: 40_000, cacheCreationInputTokens: 2_000 } };

    const counts = readStepCounts({ outputTokens: 7 }, meta);

    expect(counts.inputTokens).toBe(42_000);
    expect(counts.cacheReadInputTokens + counts.cacheWriteInputTokens).toBeLessThanOrEqual(counts.inputTokens);
  });

  it("leaves a reported total alone when it already covers the cache figures", () => {
    const counts = readStepCounts(
      { inputTokens: 100_000 },
      { anthropic: { cacheReadInputTokens: 40_000 } },
    );

    expect(counts.inputTokens).toBe(100_000);
  });

  it("reports zero for every figure a provider genuinely did not send", () => {
    expect(readStepCounts(undefined, undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningTokens: 0,
    });
  });

  it("drops the reasoning count from the four the card charges for", () => {
    // Reasoning tokens are already inside `outputTokens`, and `RATE_NAMES`
    // charges four rates, not five. Carrying them into the draft would charge
    // for the same tokens twice.
    const draft = usageDraft({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 3,
      cacheWriteInputTokens: 4,
      reasoningTokens: 9,
    });

    expect(draft).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 3,
      cacheWriteInputTokens: 4,
    });
    expect(Object.keys(draft)).not.toContain("reasoningTokens");
  });
});
