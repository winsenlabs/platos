// Delegation: one agent running part of another's turn.
//
// THE TWO META-TOOLS THAT STAY IN THIS CONTEXT. `domain/tool-catalogue.ts` maps
// every one of the source's thirty-odd meta-tools to the context that owns it
// now, and `spawn_agent` and `delegate_to_sub_agent` are the two that map back
// here — because delegating is RUNNING ANOTHER TURN, and running a turn is this
// context's whole job.
//
// THE DELEGATED STEPS LAND ON THE PARENT'S TURN, and that is the source's
// decision kept for the source's own reason: the spend is work the parent's turn
// caused. `conversation.service.ts` writes the primary model call as step 1 and
// every delegated call at `index + 2` on the SAME `Turn`, and
// `turn-cost.ts` rolls all of them up. So a caller asks for the delegated steps
// and appends them; there is no second turn row and no second bill.
//
// THREE CEILINGS BEFORE ANY MONEY IS SPENT, and `sub-agent.ts` holds all three
// with three codes: the kill switch, the cycle, the depth, the fan-out. The
// cycle check is the one the source has NO equivalent of — A delegating to B
// delegating to A is inside both of its ceilings and runs.
//
// A DELEGATED TURN GETS ITS OWN, SMALLER STEP BUDGET. `subAgentStepCeiling`
// clamps it, and the child is offered `spawn_agent` only while it is still under
// the depth ceiling — which is the source's better mechanism kept: a model
// cannot ask for what it was not given, so the deepest level is bounded by an
// ABSENT capability rather than by a refusal it has to be told about.
//
// THE CHILD INHERITS THE PARENT'S SCOPE AND GRANT AND MAY NARROW ITS TOOLS.
// Never widen: `narrowToParentCatalogue` intersects, so a delegated agent cannot
// reach a tool its parent was not offered. The source narrows too, and the
// intersection is what stops delegation being a privilege-escalation seam.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  admitDelegation,
  buildToolCatalogue,
  mayDelegateFurther,
  subAgentStepCeiling,
  type AgentId,
  type DelegationChain,
  type Step,
  type ProviderKeyId,
  type ThreadId,
  type ToolCatalogue,
  type TurnId,
} from "../domain/index.js";
import type { SecretsRuntimeGrant } from "./authorization.js";
import type { ConversationsDependencies } from "./dependencies.js";
import { generationFailed } from "../domain/index.js";
import { recordSteps } from "./turn-steps.js";
import { executeToolCall, toToolDefinitions } from "./turn-tools.js";
import { buildPrompt } from "./turn-prompt.js";

export interface RunSubAgentCommand {
  readonly authorization: SecretsRuntimeGrant;
  readonly scope: EnvironmentScope;
  /** The turn the delegated steps are appended to. Always the PARENT's. */
  readonly parentTurnId: TurnId;
  readonly threadId: ThreadId;
  readonly chain: DelegationChain;
  readonly childAgentId: AgentId;
  /** How many delegations this turn has already made. */
  readonly fanOutSoFar: number;
  readonly instruction: string;
  readonly systemPrompt: string;
  /** The parent's catalogue. The child's is an intersection of it. */
  readonly parentCatalogue: ToolCatalogue;
  readonly allowedToolNames: readonly string[] | null;
  readonly model: string;
  readonly providerKeyId: ProviderKeyId | null;
  readonly requestedMaxSteps?: number | null;
  /** The sequence the first delegated step takes on the parent's turn. */
  readonly firstStepSequence: number;
  readonly abortSignal?: AbortSignal | null;
}

export interface SubAgentRan {
  readonly text: string;
  /** Appended to the PARENT turn, at `firstStepSequence` and upwards. */
  readonly steps: readonly Step[];
  readonly chain: DelegationChain;
}

/**
 * The child's catalogue: the parent's, intersected with what it was allowed.
 *
 * A null allow-list means "everything the parent had" and is still an
 * intersection, not a widening. There is deliberately no parameter that could
 * ADD a tool: a delegated agent reaching a tool its parent was not offered would
 * make delegation a way around the four-tier gate.
 */
export function narrowToParentCatalogue(
  parent: ToolCatalogue,
  allowedToolNames: readonly string[] | null,
  maxTools: number,
): Result<ToolCatalogue> {
  const allowed = allowedToolNames === null ? null : new Set(allowedToolNames);
  const kept = parent.tools.filter((tool) => allowed === null || allowed.has(tool.name));
  return buildToolCatalogue(kept, maxTools);
}

export async function runSubAgent(
  dependencies: ConversationsDependencies,
  command: RunSubAgentCommand,
): Promise<Result<SubAgentRan>> {
  const chain = admitDelegation(
    {
      chain: command.chain,
      childAgentId: command.childAgentId,
      fanOutSoFar: command.fanOutSoFar,
    },
    dependencies.policy.subAgent,
  );
  if (!chain.ok) return err(chain.error);

  const catalogue = narrowToParentCatalogue(
    command.parentCatalogue,
    command.allowedToolNames,
    dependencies.policy.turn.maxToolsPerTurn,
  );
  if (!catalogue.ok) return err(catalogue.error);

  const offered = mayDelegateFurther(chain.value, dependencies.policy.subAgent)
    ? ok(catalogue.value)
    : withoutDelegation(catalogue.value, dependencies.policy.turn.maxToolsPerTurn);
  if (!offered.ok) return err(offered.error);

  const built = buildPrompt({
    systemPrompt: command.systemPrompt,
    transcript: { entries: [], summary: null, truncated: false },
    memoryBlock: null,
    userText: command.instruction,
    attachments: [],
  });
  if (!built.ok) return err(built.error);

  const startedAt = dependencies.clock.now();
  const generation = await dependencies.providers.runModelGeneration({
    authorization: command.authorization,
    scope: command.scope,
    model: command.model,
    providerKeyId: command.providerKeyId,
    prompt: built.value,
    tools: toToolDefinitions(offered.value),
    executeTool: (call) =>
      executeToolCall(
        dependencies,
        {
          scope: command.scope,
          vaultAuthorization: command.authorization,
          agentId: command.childAgentId,
          threadId: command.threadId,
          endUserId: null,
          catalogue: offered.value,
        },
        call,
      ),
    output: { kind: "text" },
    sampling: { maxOutputTokens: null, temperature: null },
    maxSteps: subAgentStepCeiling(command.requestedMaxSteps ?? null, dependencies.policy.subAgent),
    abortSignal: command.abortSignal ?? null,
  });
  if (!generation.ok) return err(generationFailed(generation.error.code));

  const completedAt = dependencies.clock.now();
  const steps = await recordSteps(
    dependencies,
    command.parentTurnId,
    command.model,
    generation.value.generation.steps,
    command.firstStepSequence,
    startedAt,
    completedAt,
  );
  if (!steps.ok) return err(steps.error);

  return ok({
    text: generation.value.generation.text,
    steps: steps.value,
    chain: chain.value,
  });
}

/**
 * The catalogue a child at the depth ceiling gets: everything but delegation.
 *
 * The ceiling is enforced here by ABSENCE. A model that is never given a
 * delegation tool cannot call one, so the deepest level needs no refusal at all
 * — which is both cheaper and, more importantly, not something a model can
 * argue with.
 */
function withoutDelegation(catalogue: ToolCatalogue, maxTools: number): Result<ToolCatalogue> {
  const kept = catalogue.tools.filter((tool) => !DELEGATION_TOOL_NAMES.has(tool.name));
  return buildToolCatalogue(kept, maxTools);
}

/** The two names this context owns, from `domain/tool-catalogue.ts`'s map. */
export const DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "spawn_agent",
  "delegate_to_sub_agent",
]);
