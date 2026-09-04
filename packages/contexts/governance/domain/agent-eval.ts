// One judged score, frozen.
//
// An `AgentEval` is written once and never updated. It carries the criterion it
// was judged against as a SNAPSHOT, the exact prompt the judge was sent, the
// judge's raw answer, and the normalised score — so an eval read a year later
// can be re-checked without depending on a criterion that has since been edited
// or deleted.
//
// THE PROMPT IS ASSEMBLED HERE, NOT AT THE CALL SITE. `{conversation}` inside a
// judge prompt is substituted with the transcript; a prompt that names no
// placeholder gets the transcript appended under a separator. That is the
// source's rule and it is kept, but it lives in the domain rather than beside
// the vendor call, because "what exactly was this judge asked" is the single
// most important field for auditing an eval and it should be derivable without a
// network client in scope.
//
// THE RUN GROUPING THE SOURCE REFUSES IS STILL REFUSED, DIFFERENTLY. The
// canonical model has no run column, and the source throws when a caller
// supplies `runId` or `baselineVersionId` rather than claiming a grouping it
// cannot persist losslessly. That honesty is kept and moved up: this context
// never accepts a run identifier on a stored row at all — a golden-set run is
// identified by the SET of eval ids it produced, which is what
// `regression.ts` compares and what the queued run carries.

import type { CriterionSnapshot } from "./criterion.js";
import type {
  AgentEvalId,
  AgentId,
  AgentVersionId,
  EvalCriterionId,
  ThreadId,
  TurnId,
} from "./identifiers.js";
import type { JudgeVerdict } from "./judge-verdict.js";

/** The placeholder a judge prompt may use to position the transcript. */
export const TRANSCRIPT_PLACEHOLDER = "{conversation}";

export interface AgentEval {
  readonly agentEvalId: AgentEvalId;
  readonly environmentId: string;
  readonly agentId: AgentId;
  /** The version that was live when the conversation ran. */
  readonly agentVersionId: AgentVersionId | null;
  readonly threadId: ThreadId;
  /** Null when the whole thread was scored rather than one turn. */
  readonly turnId: TurnId | null;
  readonly criterionId: EvalCriterionId;
  readonly criterionSnapshot: CriterionSnapshot;
  readonly judgeModel: string;
  readonly judgePromptUsed: string;
  readonly rawResponse: string | null;
  /** Normalised 0..100. See `judge-verdict.ts`. */
  readonly score: number;
  readonly rationale: string | null;
  readonly passed: boolean;
  /** Null when the judge reported no usage the adapter could price. */
  readonly costCents: number | null;
  readonly latencyMs: number | null;
  readonly createdAt: Date;
}

/** One line of a conversation, as this context reads it. */
export interface TranscriptTurn {
  readonly turnId: TurnId;
  readonly input: string | null;
  readonly output: string | null;
}

/**
 * Render a transcript.
 *
 * A turn with neither half contributes nothing rather than an empty labelled
 * line: a judge asked to score blank `USER:` lines will score them.
 */
export function renderTranscript(turns: readonly TranscriptTurn[]): string {
  const lines: string[] = [];
  for (const turn of turns) {
    if (turn.input !== null && turn.input !== "") lines.push(`USER: ${turn.input}`);
    if (turn.output !== null && turn.output !== "") lines.push(`ASSISTANT: ${turn.output}`);
  }
  return lines.join("\n\n");
}

/** Substitute the transcript into the criterion's prompt, or append it. */
export function assembleJudgePrompt(judgePrompt: string, transcript: string): string {
  if (judgePrompt.includes(TRANSCRIPT_PLACEHOLDER)) {
    return judgePrompt.split(TRANSCRIPT_PLACEHOLDER).join(transcript);
  }
  return `${judgePrompt}\n\n---\n\nConversation to score:\n\n${transcript}`;
}

/**
 * The scale block appended to the judge's instructions.
 *
 * Separate from the prompt assembly because it is derived from the SNAPSHOT
 * rather than from the live criterion: an eval re-rendered from its own stored
 * fields must produce the same block it was scored with.
 */
export function renderScaleBlock(criterion: CriterionSnapshot): string {
  if (criterion.rubric !== null && criterion.rubric !== "") {
    return `\n\nScoring rubric (${criterion.scoreScaleMin}..${criterion.scoreScaleMax}):\n${criterion.rubric}`;
  }
  return `\n\nScoring scale: ${criterion.scoreScaleMin}..${criterion.scoreScaleMax}.`;
}

export interface EvalDraft {
  readonly agentId: AgentId;
  readonly agentVersionId: AgentVersionId | null;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  readonly criterionId: EvalCriterionId;
  readonly criterionSnapshot: CriterionSnapshot;
  readonly judgeModel: string;
  readonly judgePromptUsed: string;
  readonly rawResponse: string;
  readonly verdict: JudgeVerdict;
  readonly costCents: number | null;
  readonly latencyMs: number;
}

/** The stored fields a draft becomes. `rawResponse` is truncated, never dropped. */
export interface AdmittedEval {
  readonly agentId: AgentId;
  readonly agentVersionId: AgentVersionId | null;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  readonly criterionId: EvalCriterionId;
  readonly criterionSnapshot: CriterionSnapshot;
  readonly judgeModel: string;
  readonly judgePromptUsed: string;
  readonly rawResponse: string;
  readonly rawResponseTruncated: boolean;
  readonly score: number;
  readonly rationale: string | null;
  readonly passed: boolean;
  readonly costCents: number | null;
  readonly latencyMs: number;
}

/**
 * Freeze a draft into the row that will be stored.
 *
 * Nothing is refused here. By this point a judge has been paid for and an answer
 * exists; discarding it because it is long or odd would spend the money and keep
 * no record. The over-long raw response loses its tail and says so.
 */
export function admitEval(draft: EvalDraft, maxRawResponseLength: number): AdmittedEval {
  const truncated = draft.rawResponse.length > maxRawResponseLength;
  return {
    agentId: draft.agentId,
    agentVersionId: draft.agentVersionId,
    threadId: draft.threadId,
    turnId: draft.turnId,
    criterionId: draft.criterionId,
    criterionSnapshot: draft.criterionSnapshot,
    judgeModel: draft.judgeModel,
    judgePromptUsed: draft.judgePromptUsed,
    rawResponse: truncated ? draft.rawResponse.slice(0, maxRawResponseLength) : draft.rawResponse,
    rawResponseTruncated: truncated,
    score: draft.verdict.score,
    rationale: draft.verdict.rationale,
    passed: draft.verdict.passed,
    costCents: draft.costCents,
    latencyMs: draft.latencyMs,
  };
}
