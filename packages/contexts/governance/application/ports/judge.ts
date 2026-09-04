// The `Judge` port — a language model asked one question, seen as an interface.
//
// ADR M0.3 §2 bans every provider SDK from `domain/` and `application/`, and
// §5.1 rule (h) pins those SDKs to one adapter directory. The source calls
// `generateText` from inside the eval service and resolves an API key from a
// scoped-environment service in the same function, which is what makes its judge
// pipeline impossible to exercise without a network and a vault.
//
// THIS PORT IS THE WHOLE VENDOR SURFACE. One method, one request, one answer.
// The adapter picks the client, holds the key, and prices the call; this context
// composes the prompt, reads the answer and stores the measurement.
//
// A JUDGE FAILURE IS AN ANSWER, NOT AN EXCEPTION. The source catches its own
// vendor error and writes an eval scoring 0 with the error text as the
// rationale, so a run against an unreachable judge produces rows rather than
// silence. That behaviour is kept and made explicit: the port returns a
// `Result`, and `run-judge.ts` decides which failures become a stored
// zero-scored eval and which are refused outright.
//
// THE COST COMES BACK WITH THE ANSWER AND IS NOT RECORDED HERE. Pricing is
// `providers`' knowledge and the central spend ledger is `cost-monitoring`'s
// table (ADR M0.3 §1 rows 4 and 13), neither of which this context may write or
// import. The adapter prices what it just paid for and hands the number back;
// this context stores it on its own `AgentEval.costCents` column and PUBLISHES
// it on `governance.eval.scored`, so the central ledger can pick judge spend up
// through the event fan-out rather than through a code edge. The source's
// direct `recordAuxiliaryCost` call is therefore NOT reproduced, and that is a
// deliberate narrowing recorded in `contracts/index.ts`.

import type { EnvironmentScope, Result } from "@platos/kernel";

import type { JudgeModel } from "../../domain/index.js";

export interface JudgeRequest {
  readonly scope: EnvironmentScope;
  readonly model: JudgeModel;
  /** The judge's standing instructions. Identical for every criterion. */
  readonly instructions: string;
  /** The criterion, its scale, and the transcript. Stored verbatim on the eval. */
  readonly prompt: string;
}

/** What the adapter observed. Every field is optional because providers differ. */
export interface JudgeUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
  readonly reasoningTokens: number | null;
}

export interface JudgeAnswer {
  readonly text: string;
  readonly usage: JudgeUsage;
  /** Priced by the adapter. Null when it could not price what it was billed for. */
  readonly costCents: number | null;
}

export interface Judge {
  ask(request: JudgeRequest): Promise<Result<JudgeAnswer>>;
}
