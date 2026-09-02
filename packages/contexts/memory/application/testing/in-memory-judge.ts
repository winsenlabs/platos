// An in-memory `ExtractionJudge`.
//
// IT ANSWERS WITH WHATEVER A TEST QUEUED, VERBATIM. That is the point: the
// envelope parser has to survive fenced JSON, prose around JSON, malformed JSON
// and a judge that answered with nothing at all, and every one of those is a
// STRING a test can state exactly. A double that returned a structured envelope
// would skip the parsing this context actually owns.
//
// USAGE TRAVELS BACK, so the pricing seam is exercised. A test that queues an
// answer with no usage proves the "nothing to price" path; one that queues real
// counts proves the translation from this context's `cacheCreationInputTokens`
// to the rate card's `cacheWriteInputTokens`.
//
// EVERY CALL IS RECORDED, which is what lets an extraction test assert the
// TRANSCRIPT the judge was shown — the ordering, the window, and the fact that
// a turn with no output text contributed one message and not two.

import { err, ok, type Result } from "@platos/kernel";

import { extractionJudgeUnavailable, type ExtractionPolicy } from "../../domain/index.js";
import { NO_JUDGE_USAGE, type ExtractionJudge, type JudgeAnswer, type JudgeUsage } from "../ports/index.js";

export interface QueuedAnswer {
  readonly text: string;
  readonly usage?: Partial<JudgeUsage>;
  readonly model?: string;
}

export class InMemoryExtractionJudge implements ExtractionJudge {
  /** Every transcript this judge was shown, in order. */
  readonly extractions: { readonly transcript: string; readonly policy: ExtractionPolicy }[] = [];
  readonly syntheses: string[] = [];

  private extractionAnswers: QueuedAnswer[] = [];
  private synthesisAnswers: QueuedAnswer[] = [];
  private extractionFailure: string | null = null;
  private synthesisFailure: string | null = null;

  answerExtractionWith(...answers: readonly QueuedAnswer[]): void {
    this.extractionAnswers = [...answers];
  }

  answerSynthesisWith(...answers: readonly QueuedAnswer[]): void {
    this.synthesisAnswers = [...answers];
  }

  failExtraction(reason: string | null): void {
    this.extractionFailure = reason;
  }

  failSynthesis(reason: string | null): void {
    this.synthesisFailure = reason;
  }

  async extract(transcript: string, policy: ExtractionPolicy): Promise<Result<JudgeAnswer>> {
    this.extractions.push({ transcript, policy });
    if (this.extractionFailure !== null) {
      return err(extractionJudgeUnavailable(this.extractionFailure));
    }
    return ok(answerOf(this.extractionAnswers.shift()));
  }

  async synthesize(atoms: string): Promise<Result<JudgeAnswer>> {
    this.syntheses.push(atoms);
    if (this.synthesisFailure !== null) {
      return err(extractionJudgeUnavailable(this.synthesisFailure));
    }
    return ok(answerOf(this.synthesisAnswers.shift()));
  }
}

/** A queue that ran dry answers with an EMPTY string, not with a failure. */
function answerOf(queued: QueuedAnswer | undefined): JudgeAnswer {
  return {
    text: queued?.text ?? "",
    usage: { ...NO_JUDGE_USAGE, ...(queued?.usage ?? {}) },
    model: queued?.model ?? "test:judge-1",
  };
}
