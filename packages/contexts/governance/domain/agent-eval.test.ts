import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  TRANSCRIPT_PLACEHOLDER,
  admitEval,
  assembleJudgePrompt,
  renderScaleBlock,
  renderTranscript,
  type EvalDraft,
  type TranscriptTurn,
} from "./agent-eval.js";
import type { CriterionSnapshot } from "./criterion.js";
import type { AgentId, EvalCriterionId, ThreadId, TurnId } from "./identifiers.js";

function turn(id: string, input: string | null, output: string | null): TranscriptTurn {
  return { turnId: asIdentifier<TurnId>(id), input, output };
}

const SNAPSHOT: CriterionSnapshot = {
  name: "grounded",
  description: null,
  judgePrompt: "score it",
  rubric: null,
  judgeModel: null,
  scoreScaleMin: 0,
  scoreScaleMax: 100,
};

describe("renderTranscript", () => {
  it("labels each half of a turn and separates turns with a blank line", () => {
    expect(renderTranscript([turn("t1", "hello", "hi"), turn("t2", "bye", "goodbye")])).toBe(
      "USER: hello\n\nASSISTANT: hi\n\nUSER: bye\n\nASSISTANT: goodbye",
    );
  });

  it("omits a half that is absent rather than emitting a blank labelled line", () => {
    // A judge asked to score empty `USER:` lines will score them.
    expect(renderTranscript([turn("t1", null, "hi")])).toBe("ASSISTANT: hi");
    expect(renderTranscript([turn("t1", "hello", null)])).toBe("USER: hello");
  });

  it("omits a half that is an empty string, not only one that is null", () => {
    expect(renderTranscript([turn("t1", "", "hi")])).toBe("ASSISTANT: hi");
  });

  it("renders an empty conversation as an empty string", () => {
    expect(renderTranscript([])).toBe("");
    expect(renderTranscript([turn("t1", null, null)])).toBe("");
  });
});

describe("assembleJudgePrompt", () => {
  it("substitutes the placeholder where the operator put it", () => {
    expect(assembleJudgePrompt(`before ${TRANSCRIPT_PLACEHOLDER} after`, "TRANSCRIPT")).toBe(
      "before TRANSCRIPT after",
    );
  });

  it("substitutes EVERY occurrence, not only the first", () => {
    // `String.replace` with a string pattern replaces once, which would leave a
    // literal `{conversation}` in the prompt a judge is paid to read.
    expect(
      assembleJudgePrompt(`${TRANSCRIPT_PLACEHOLDER} and ${TRANSCRIPT_PLACEHOLDER}`, "X"),
    ).toBe("X and X");
  });

  it("appends the transcript under a separator when no placeholder is present", () => {
    expect(assembleJudgePrompt("score it", "TRANSCRIPT")).toBe(
      "score it\n\n---\n\nConversation to score:\n\nTRANSCRIPT",
    );
  });

  it("substitutes an empty transcript rather than leaving the placeholder in", () => {
    expect(assembleJudgePrompt(`a${TRANSCRIPT_PLACEHOLDER}b`, "")).toBe("ab");
  });
});

describe("renderScaleBlock", () => {
  it("renders the rubric with the scale when there is one", () => {
    expect(renderScaleBlock({ ...SNAPSHOT, rubric: "0 bad, 100 good" })).toBe(
      "\n\nScoring rubric (0..100):\n0 bad, 100 good",
    );
  });

  it("renders the bare scale when there is not", () => {
    expect(renderScaleBlock(SNAPSHOT)).toBe("\n\nScoring scale: 0..100.");
  });

  it("treats an empty rubric as no rubric", () => {
    expect(renderScaleBlock({ ...SNAPSHOT, rubric: "" })).toBe("\n\nScoring scale: 0..100.");
  });

  it("renders the SNAPSHOT's scale, so a re-render matches what was scored", () => {
    expect(renderScaleBlock({ ...SNAPSHOT, scoreScaleMin: 1, scoreScaleMax: 5 })).toBe(
      "\n\nScoring scale: 1..5.",
    );
  });
});

describe("admitEval", () => {
  function draft(overrides: Partial<EvalDraft> = {}): EvalDraft {
    return {
      agentId: asIdentifier<AgentId>("agent-1"),
      agentVersionId: null,
      threadId: asIdentifier<ThreadId>("thread-1"),
      turnId: null,
      criterionId: asIdentifier<EvalCriterionId>("criterion-1"),
      criterionSnapshot: SNAPSHOT,
      judgeModel: "openai:gpt-5",
      judgePromptUsed: "score it",
      rawResponse: '{"score": 80}',
      verdict: { score: 80, rationale: "fine", passed: true, parsedFrom: "fenced-json", clamped: false },
      costCents: 12,
      latencyMs: 340,
      ...overrides,
    };
  }

  it("carries the verdict onto the stored fields", () => {
    const admitted = admitEval(draft(), 100);
    expect(admitted.score).toBe(80);
    expect(admitted.rationale).toBe("fine");
    expect(admitted.passed).toBe(true);
  });

  it("keeps a raw response at EXACTLY the ceiling whole", () => {
    const admitted = admitEval(draft({ rawResponse: "0123456789" }), 10);
    expect(admitted.rawResponse).toBe("0123456789");
    expect(admitted.rawResponseTruncated).toBe(false);
  });

  it("cuts one character over the ceiling to EXACTLY the ceiling and says so", () => {
    const admitted = admitEval(draft({ rawResponse: "0123456789X" }), 10);
    expect(admitted.rawResponse).toBe("0123456789");
    expect(admitted.rawResponseTruncated).toBe(true);
  });

  it("REFUSES NOTHING — a judge has already been paid for by this point", () => {
    const admitted = admitEval(draft({ rawResponse: "x".repeat(100_000), latencyMs: 0 }), 10);
    expect(admitted.rawResponse).toHaveLength(10);
    expect(admitted.latencyMs).toBe(0);
  });

  it("carries the snapshot through by identity, so the frozen question is stored", () => {
    const admitted = admitEval(draft(), 100);
    expect(admitted.criterionSnapshot).toBe(SNAPSHOT);
  });

  it("keeps a null cost null rather than storing zero", () => {
    // Zero cents is "we priced it and it was free"; null is "we could not price
    // what we were billed for". A rollup must be able to tell them apart.
    expect(admitEval(draft({ costCents: null }), 100).costCents).toBeNull();
    expect(admitEval(draft({ costCents: 0 }), 100).costCents).toBe(0);
  });
});
