// Use case: score one conversation against one criterion.
//
// SIX GATES BEFORE A JUDGE IS PAID, EACH WITH ITS OWN CODE, IN THIS ORDER. The
// order is chosen so that the cheapest refusal happens first and no gate can be
// reached by routing around another:
//
//   1. THE KILL SWITCH. `policy.evals.enabled` is false -> `EVALS_DISABLED`.
//      Checked before the grant is even verified, so disabling judging disables
//      it for everyone including an operator with a perfect grant.
//   2. THE GRANT. The environment comes from it.
//   3. THE CRITERION EXISTS IN THIS ENVIRONMENT -> `CRITERION_NOT_FOUND`.
//   4. THE CRITERION IS ACTIVE -> `CRITERION_INACTIVE`. Distinct from the
//      previous, because "deactivated" and "wrong id" are different remedies.
//   5. THE JUDGE MODEL PARSES -> `JUDGE_MODEL_INVALID`. Up front, so a typo in a
//      criterion does not cost a transcript read.
//   6. THE JUDGE IS NOT THE MODEL UNDER TEST -> `EVAL_SELF_JUDGED`. On the
//      RESOLVED provider/model pair, not on the raw strings; `judge-model.ts`
//      records why the source's string comparison fails open.
//
// AND ONE GATE AFTER THE TRANSCRIPT AND BEFORE THE JUDGE: a thread that is not
// in this environment answers `TRANSCRIPT_NOT_FOUND`, and a thread that belongs
// to a different agent than the caller named answers the same — the source's own
// "Thread does not belong to the specified agent" check, kept, because scoring
// agent A's conversation and attributing it to agent B corrupts every rollup
// afterwards.
//
// A JUDGE FAILURE IS STORED, NOT THROWN. The source catches its vendor error and
// writes an eval scoring zero with the error text as the rationale, so a run
// against an unreachable judge leaves evidence rather than silence. That is kept
// exactly, and it is the reason `Judge.ask` returns a `Result` rather than
// rejecting: the failure is a value this use case decides what to do with.
//
// THE EVAL IS ATTRIBUTED TO THE VERSION THAT PRODUCED THE TRANSCRIPT, NOT TO THE
// ONE THAT IS LIVE. The source stamps `AgentEval.agentVersionId` from the
// agent's current binding, so judging last week's thread after a promotion files
// the score against the new version — and `aggregateAgentEvals`, filtered by
// version, is exactly how a canary decision reads these rows. `Turn.
// agentVersionId` records which version actually ran, so it travels on the
// transcript and `versionUnderTest` picks it. A conversation spanning a
// promotion is attributed to NEITHER version; see `domain/agent-eval.ts`.
//
// THE LIVE VERSION IS STILL READ, FOR ONE THING ONLY: the self-evaluation gate,
// which asks whether the judge is the model THIS AGENT RUNS. That is a question
// about the agent as configured now, which is what an operator means by "don't
// let it grade itself", and it is the source's own comparison.
//
// THE CENTRAL COST LEDGER IS NOT WRITTEN HERE. The source calls
// `CostService.recordAuxiliaryCost` from inside this path. `Budget` and the
// spend ledger are `cost-monitoring`'s rows (ADR M0.3 §1 row 13), which this
// context is neither the writer of nor permitted to import. The priced number is
// stored on this context's own `AgentEval.costCents` and published on
// `governance.eval.scored`; picking it up is the fan-out's job. That narrowing
// is recorded in `contracts/index.ts` rather than left to be discovered.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  admitEval,
  assembleJudgePrompt,
  criterionInactive,
  criterionNotFound,
  criterionSnapshot,
  evalsDisabled,
  parseJudgeModel,
  readJudgeVerdict,
  renderScaleBlock,
  renderTranscript,
  requireDistinctJudge,
  transcriptNotFound,
  versionUnderTest,
  type AgentEval,
  type AgentId,
  type AgentVersionId,
  type EvalCriterion,
  type EvalCriterionId,
  type JudgeModel,
  type ThreadId,
  type TurnId,
} from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { GovernanceDependencies } from "./dependencies.js";
import type { Transcript } from "./ports/index.js";

/** The judge's standing instructions. Identical for every criterion, by design. */
export const JUDGE_INSTRUCTIONS =
  "You are a strict, impartial judge scoring an AI assistant's conversation against a single criterion. " +
  "Respond ONLY with a JSON object of the shape: " +
  '{"score": <number>, "rationale": "<one or two sentences>", "passed": <boolean>}. ' +
  "No prose outside the JSON.";

export interface RunJudgeCommand {
  readonly authorization: unknown;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly criterionId: EvalCriterionId;
  /** Score one exchange rather than the whole conversation. */
  readonly turnId?: TurnId | null;
}

export async function runJudge(
  dependencies: GovernanceDependencies,
  command: RunJudgeCommand,
): Promise<Result<AgentEval>> {
  if (!dependencies.policy.evals.enabled) return err(evalsDisabled());
  const grant = verifyOperator(dependencies, command.authorization);
  if (!grant.ok) return err(grant.error);
  const scope = grant.value.scope;

  const criterion = await loadActiveCriterion(dependencies, scope, command.criterionId);
  if (!criterion.ok) return err(criterion.error);

  const model = parseJudgeModel(criterion.value.judgeModel ?? dependencies.policy.evals.defaultJudgeModel);
  if (!model.ok) return err(model.error);

  const live = await liveVersion(dependencies, command.authorization, command.agentId);
  if (!live.ok) return err(live.error);
  const distinct = requireDistinctJudge(model.value, live.value.model);
  if (!distinct.ok) return err(distinct.error);

  const transcript = await loadTranscript(dependencies, scope, command);
  if (!transcript.ok) return err(transcript.error);

  return score(dependencies, scope, {
    criterion: criterion.value,
    model: model.value,
    agentId: command.agentId,
    agentVersionId: versionUnderTest(transcript.value.turns),
    threadId: command.threadId,
    turnId: command.turnId ?? null,
    transcript: transcript.value,
  });
}

interface ScoreInput {
  readonly criterion: EvalCriterion;
  readonly model: JudgeModel;
  readonly agentId: AgentId;
  readonly agentVersionId: AgentVersionId | null;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  readonly transcript: Transcript;
}

/**
 * Ask the judge and write the measurement.
 *
 * `latencyMs` is measured across the judge call ALONE, not across the whole use
 * case: a transcript read that was slow is not a judge that was slow, and the
 * column is read as a judge's latency.
 */
async function score(
  dependencies: GovernanceDependencies,
  scope: EnvironmentScope,
  input: ScoreInput,
): Promise<Result<AgentEval>> {
  const snapshot = criterionSnapshot(input.criterion);
  const rendered = renderTranscript(input.transcript.turns);
  const judgePromptUsed = assembleJudgePrompt(snapshot.judgePrompt, rendered);
  const prompt = `Criterion: ${snapshot.name}${
    snapshot.description === null ? "" : `\n\n${snapshot.description}`
  }${renderScaleBlock(snapshot)}\n\n${judgePromptUsed}`;

  const started = dependencies.clock.now().getTime();
  const answered = await dependencies.judge.ask({
    scope,
    model: input.model,
    instructions: JUDGE_INSTRUCTIONS,
    prompt,
  });
  const latencyMs = dependencies.clock.now().getTime() - started;

  const rawResponse = answered.ok ? answered.value.text : `[judge-error] ${answered.error.message}`;
  const verdict = answered.ok
    ? readJudgeVerdict(rawResponse, snapshot, dependencies.policy.evals.passMarkPercent)
    : ({ score: 0, rationale: answered.error.message, passed: false, parsedFrom: "unreadable", clamped: false } as const);

  const admitted = admitEval(
    {
      agentId: input.agentId,
      agentVersionId: input.agentVersionId,
      threadId: input.threadId,
      turnId: input.turnId,
      criterionId: input.criterion.evalCriterionId,
      criterionSnapshot: snapshot,
      judgeModel: input.model.spec,
      judgePromptUsed,
      rawResponse,
      verdict,
      costCents: answered.ok ? answered.value.costCents : null,
      latencyMs,
    },
    dependencies.policy.evals.maxRawResponseLength,
  );
  return dependencies.evals.append(scope, admitted, null);
}

async function loadActiveCriterion(
  dependencies: GovernanceDependencies,
  scope: EnvironmentScope,
  criterionId: EvalCriterionId,
): Promise<Result<EvalCriterion>> {
  const found = await dependencies.criteria.findById(scope, criterionId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(criterionNotFound(criterionId));
  if (!found.value.isActive) return err(criterionInactive(criterionId));
  return ok(found.value);
}

/** The live version and the model it runs, from `agents`. Both or neither. */
async function liveVersion(
  dependencies: GovernanceDependencies,
  authorization: unknown,
  agentId: AgentId,
): Promise<Result<{ readonly versionId: AgentVersionId; readonly model: string }>> {
  const described = await dependencies.agents.describeAgent({ authorization, agentId });
  if (!described.ok) return err(described.error);
  return ok({
    versionId: described.value.currentVersionId as AgentVersionId,
    model: described.value.configuration.model,
  });
}

/**
 * Read the conversation, and refuse one that is not this agent's.
 *
 * A named turn that the reader did not return produces an EMPTY transcript
 * rather than the whole thread — the port says so — so a mistyped turn id scores
 * an empty conversation instead of silently widening what the judge reads.
 */
async function loadTranscript(
  dependencies: GovernanceDependencies,
  scope: EnvironmentScope,
  command: RunJudgeCommand,
): Promise<Result<Transcript>> {
  const read = await dependencies.transcripts.read(scope, command.threadId, command.turnId ?? null);
  if (!read.ok) return err(read.error);
  if (read.value === null) return err(transcriptNotFound(command.threadId));
  if (read.value.agentId !== command.agentId) return err(transcriptNotFound(command.threadId));
  return ok(read.value);
}
