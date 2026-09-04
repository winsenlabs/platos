// Running one turn: the use case ADR M0.3 §1 row 16 exists for.
//
// THE WHOLE ORCHESTRATION IS BELOW AND IT IS UNDER TWO HUNDRED LINES, because
// admission, preparation, the tool loop and the pricing are each their own file
// and each is testable without the others. The method it replaces is 1,891 lines
// and cannot be entered without a provider, a Redis, a Prisma and eleven
// optional Nest dependencies.
//
// THE STEP LOOP IS BEHIND THE PORT, AND THAT IS THE CENTRAL DESIGN FACT. This
// file makes ONE call — `providers.runModelGeneration` — and hands it the tool
// catalogue and a function that runs one tool. `providers` runs the model, calls
// that function when the model asks for a tool, re-places the cache breakpoints
// before every step, and stops at `maxSteps`. Everything between the steps
// happens on the far side of a boundary this context is forbidden from crossing,
// which is exactly why the context can be extracted at all: `inference-sdk-only`
// bans `ai` and `@ai-sdk/*` here, so a turn that needed to drive the loop itself
// could not be written.
//
// A TURN ROW EXISTS BEFORE THE MODEL IS CALLED. `createTurn` happens first, with
// the user's side written and the status PENDING. So a turn that crashes mid
// generation is a FAILED row with its input intact rather than nothing at all,
// and the caller's idempotency key is already claimed — which is what makes a
// redelivery during a long generation answer the turn in flight instead of
// starting a second one.
//
// EVERY EXIT SETTLES THE TURN AND EVERY EXIT ROLLS UP THE STEPS. Success,
// provider failure and abandonment all go through `settleTurn`, which takes the
// steps and derives the cost from them. The source's failure path writes the
// primary step's cost alone and loses everything a failed turn delegated; there
// is no path here that can, because there is no parameter to pass a different
// number to.
//
// THE LEDGER IS NOT WRITTEN HERE. `conversations.turn.settled` carries the usage
// and the exact cost, appended to the kernel outbox INSIDE the same transaction
// as the settlement, and `cost-monitoring` subscribes. That inversion is what
// makes this context a DAG sink: the source calls `CostService.recordUsage`,
// `recordUserSpend` and a Prometheus fan-out from inside the request, which are
// three edges out of the deepest node in the graph.

import { err, moneyToCentsString, ok, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  abandonTurn,
  beginTurn,
  generationFailed,
  openTurn,
  settleTurn,
  stepCeiling,
  type AttachmentCandidate,
  type EndUserId,
  type IdempotencyKey,
  type Step,
  type ThreadId,
  type Turn,
  type TurnId,
  type AgentVersionId,
  PRIMARY_STEP_SEQUENCE,
} from "../domain/index.js";
import type { SecretsRuntimeGrant } from "./authorization.js";
import type { ConversationsDependencies } from "./dependencies.js";
import { admitTurn } from "./turn-admission.js";
import { prepareTurn } from "./turn-preparation.js";
import { buildPrompt } from "./turn-prompt.js";
import { recordSteps } from "./turn-steps.js";
import { executeToolCall, toToolDefinitions } from "./turn-tools.js";

export interface RunTurnCommand {
  readonly authorization: SecretsRuntimeGrant;
  readonly scope: EnvironmentScope;
  readonly threadId: ThreadId;
  readonly endUserId: EndUserId;
  readonly inputText: string;
  readonly idempotencyKey?: IdempotencyKey | null;
  readonly attachments?: readonly AttachmentCandidate[];
  readonly environmentSkillIds?: readonly string[];
  readonly basePrompt?: string;
  readonly toolQuery?: string;
  /** The agent version's own step budget. Clamped to the installation ceiling. */
  readonly requestedMaxSteps?: number | null;
  /** A draw in `[0, 1)` for the canary split. Supplied, never generated. */
  readonly canaryDraw: number;
  readonly abortSignal?: AbortSignal | null;
}

export interface RanTurn {
  readonly turn: Turn;
  readonly steps: readonly Step[];
  /** True when this call answered a turn a previous delivery had already made. */
  readonly replayed: boolean;
}

export async function runTurn(
  dependencies: ConversationsDependencies,
  command: RunTurnCommand,
): Promise<Result<RanTurn>> {
  const admitted = await admitTurn(dependencies, {
    authorization: command.authorization,
    scope: command.scope,
    threadId: command.threadId,
    endUserId: command.endUserId,
    inputText: command.inputText,
    idempotencyKey: command.idempotencyKey ?? null,
  });
  if (!admitted.ok) return err(admitted.error);
  if (admitted.value.kind === "replayed") {
    return ok({ turn: admitted.value.turn, steps: [], replayed: true });
  }

  const thread = admitted.value.thread;
  const prepared = await prepareTurn(dependencies, {
    authorization: command.authorization,
    scope: command.scope,
    thread,
    userText: command.inputText,
    canaryDraw: command.canaryDraw,
    attachments: command.attachments ?? [],
    environmentSkillIds: command.environmentSkillIds ?? [],
    basePrompt: command.basePrompt ?? "",
    toolQuery: command.toolQuery ?? "",
  });
  if (!prepared.ok) return err(prepared.error);

  const built = buildPrompt({
    systemPrompt: prepared.value.surface.systemPrompt,
    transcript: prepared.value.transcript,
    memoryBlock: prepared.value.memoryBlock,
    userText: command.inputText,
    attachments: prepared.value.attachments,
  });
  if (!built.ok) return err(built.error);

  const sequence = await dependencies.threads.allocateTurnSequence(command.scope, thread.threadId);
  if (!sequence.ok) return err(sequence.error);

  const startedAt = dependencies.clock.now();
  const opened = openTurn(
    {
      turnId: dependencies.ids.uuid() as unknown as TurnId,
      threadId: thread.threadId,
      agentVersionId: prepared.value.agentVersionId as AgentVersionId,
      versionBucket: prepared.value.versionBucket,
      sequence: sequence.value,
      inputText: command.inputText,
      idempotencyKey: command.idempotencyKey ?? null,
      at: startedAt,
    },
    dependencies.policy.turn,
  );
  if (!opened.ok) return err(opened.error);

  const created = await dependencies.turns.createTurn(command.scope, opened.value);
  if (!created.ok) return err(created.error);
  const running = beginTurn(created.value, startedAt);
  if (!running.ok) return err(running.error);

  const generation = await dependencies.providers.runModelGeneration({
    authorization: command.authorization,
    scope: command.scope,
    model: prepared.value.model,
    providerKeyId: prepared.value.providerKeyId,
    prompt: built.value,
    tools: toToolDefinitions(prepared.value.surface.catalogue),
    executeTool: (call) =>
      executeToolCall(
        dependencies,
        {
          scope: command.scope,
          vaultAuthorization: command.authorization,
          agentId: thread.agentId,
          threadId: thread.threadId,
          endUserId: thread.endUserId,
          catalogue: prepared.value.surface.catalogue,
        },
        call,
      ),
    output: { kind: "text" },
    sampling: { maxOutputTokens: null, temperature: null },
    maxSteps: stepCeiling(command.requestedMaxSteps ?? null, dependencies.policy.turn),
    abortSignal: command.abortSignal ?? null,
  });

  if (!generation.ok) {
    return settleFailure(dependencies, command.scope, running.value, generation.error.code);
  }

  const completedAt = dependencies.clock.now();
  const steps = await recordSteps(
    dependencies,
    running.value.turnId,
    prepared.value.model,
    generation.value.generation.steps,
    PRIMARY_STEP_SEQUENCE,
    startedAt,
    completedAt,
  );
  if (!steps.ok) return err(steps.error);

  const aborted = generation.value.generation.finishReason === "aborted";
  const settled = aborted
    ? abandonTurn(running.value, steps.value, completedAt)
    : settleTurn(running.value, {
        status: "SUCCEEDED",
        outputText: generation.value.generation.text,
        steps: steps.value,
        completedAt,
      });
  if (!settled.ok) return err(settled.error);

  return persist(dependencies, command.scope, settled.value, steps.value, aborted);
}

/**
 * Settle a turn the provider refused, and keep whatever it had already spent.
 *
 * The steps are empty here only because a refusal from `runModelGeneration`
 * means the generation never produced one. When it produces some and then fails,
 * the failure arrives inside `steps` and the success path above rolls those up —
 * which is the case the source loses.
 */
async function settleFailure(
  dependencies: ConversationsDependencies,
  scope: EnvironmentScope,
  turn: Turn,
  cause: string,
): Promise<Result<RanTurn>> {
  const completedAt = dependencies.clock.now();
  const settled = settleTurn(turn, { status: "FAILED", steps: [], completedAt });
  if (!settled.ok) return err(settled.error);
  const persisted = await persist(dependencies, scope, settled.value, [], false);
  if (!persisted.ok) return err(persisted.error);
  return err(generationFailed(cause));
}

/**
 * Write the settlement and its event in ONE transaction.
 *
 * The outbox append takes the same `TransactionScope` as the write it describes,
 * so there is no window in which a turn is settled and the ledger has not been
 * told. The event carries the EXACT cost — a canonical `Decimal(18, 6)` cent
 * string, never a number, because six decimal places do not survive a JSON
 * float — and the usage the steps hold, which is the same usage the turn holds,
 * because both are `sumStepUsage` over the same rows.
 */
async function persist(
  dependencies: ConversationsDependencies,
  scope: EnvironmentScope,
  turn: Turn,
  steps: readonly Step[],
  aborted: boolean,
): Promise<Result<RanTurn>> {
  const name = aborted
    ? "conversations.turn.abandoned"
    : turn.status === "FAILED"
      ? "conversations.turn.failed"
      : "conversations.turn.settled";

  return dependencies.unitOfWork.run(async (transaction) => {
    const saved = await dependencies.turns.saveSettlement(scope, { turn, steps });
    if (!saved.ok) return err(saved.error);
    await dependencies.outbox.append(
      {
        name,
        schemaVersion: 1,
        scope,
        requestId: null,
        payload: {
          threadId: turn.threadId,
          turnId: turn.turnId,
          agentVersionId: turn.agentVersionId,
          versionBucket: turn.versionBucket,
          status: turn.status,
          costCents: moneyToCentsString(turn.cost.amount),
          costComplete: turn.cost.complete,
          stepCount: turn.cost.stepCount,
          inputTokens: turn.usage.inputTokens,
          outputTokens: turn.usage.outputTokens,
          cacheReadInputTokens: turn.usage.cacheReadInputTokens,
          cacheCreationInputTokens: turn.usage.cacheCreationInputTokens,
          reasoningTokens: turn.usage.reasoningTokens,
        },
      },
      transaction,
    );
    return ok({ turn: saved.value.turn, steps: saved.value.steps, replayed: false });
  });
}
