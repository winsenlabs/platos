// The tool half of a turn: what is offered, and what happens when one is called.
//
// TWO JOBS, AND THEY ARE THE TWO HALVES OF ONE AUTHORIZATION DECISION.
//
//   ASSEMBLY collects the catalogue from the contexts that own the tools —
//   `tools` for the registry and `skills` for the composed loadout — and hands it
//   to `providers` as `ToolDefinition[]`.
//   EXECUTION runs one call the model made. The FIRST thing it does is check
//   that the name was in the catalogue it just built, because the catalogue IS
//   the decision: a name in it went through its owner's gate, and a name that is
//   not in it went through nothing.
//
// A MODEL CAN ASK FOR A TOOL IT WAS NOT OFFERED. Providers hallucinate names,
// and a name that arrives out of nowhere must not be dispatched on the strength
// of the model having said it. The source routes on the name and lets the
// downstream registry decide, so an unoffered name reaches the dispatcher.
//
// ---------------------------------------------------------------------------
// THE EXECUTOR MUST NEVER REJECT. THIS IS THE MOST IMPORTANT LINE IN THE FILE.
// ---------------------------------------------------------------------------
// `providers`' `ToolExecutor` contract says it plainly: a tool that FAILED is a
// `ToolResultPart` with `failed: true`, because the model has to be told and is
// often able to recover on the next step; a REJECTED promise is a defect in the
// caller and ends the generation. So every path out of `executeToolCall` is a
// resolved `ToolResultPart` — the refusal, the peer's error, and any exception
// an adapter let escape. A turn does not die because one tool did.
//
// AND THE RESULT IS SCRUBBED BEFORE IT GOES BACK. `sanitizeToolResult` is why:
// an `undefined` on a required field produces a message-schema error on the NEXT
// round trip, which surfaces as a failure of the turn rather than of the tool
// that caused it, and only ever on tool turns.
//
// APPROVAL IS A RESULT, NOT A BLOCK. `tools.executeTool` can answer
// `awaiting_approval`, and that comes back to the model as a failed result
// saying so. The source blocks the turn on a Redis `BLPOP` against a duplicated
// connection for up to five minutes; `jobs` owns the suspension seam and the
// durable form of that wait is its `AgentApproval`.

import type { ToolCallPart, ToolDefinition, ToolResultPart } from "@platos/context-providers";
import { asIdentifier, err, ok, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  buildToolCatalogue,
  requireOffered,
  sanitizeToolResult,
  type AgentId,
  type OfferedTool,
  type ThreadId,
  type ToolCatalogue,
} from "../domain/index.js";
import type { ConversationsDependencies } from "./dependencies.js";
import type { SecretsRuntimeGrant } from "./authorization.js";

export interface CatalogueRequest {
  readonly authorization: unknown;
  readonly scope: EnvironmentScope;
  readonly agentId: AgentId;
  /** The bindings the agent's loadout has switched on, in loadout order. */
  readonly environmentSkillIds: readonly string[];
  readonly basePrompt: string;
  /** What to search the registry for. Empty offers no registry tools. */
  readonly toolQuery: string;
}

export interface ComposedTurnSurface {
  readonly systemPrompt: string;
  readonly catalogue: ToolCatalogue;
}

/**
 * Compose the system prompt and the tool catalogue in one pass.
 *
 * They are one call because they are one answer: `skills.composeRuntime` returns
 * the joined prompt AND the tools its blocks provide, and splitting them would
 * let an installation ship a prompt that describes tools the catalogue does not
 * contain. The source rebuilds both by hand in two places that have drifted —
 * the streaming path caches the prompt and registers skill tools unconditionally;
 * the non-streaming path caches nothing and has no tool index at all.
 */
export async function composeTurnSurface(
  dependencies: ConversationsDependencies,
  request: CatalogueRequest,
): Promise<Result<ComposedTurnSurface>> {
  const runtime = await dependencies.skills.composeRuntime({
    scope: { environment: request.scope },
    environmentSkillIds: request.environmentSkillIds.map((id) => asIdentifier(id)),
    basePrompt: request.basePrompt,
  });
  if (!runtime.ok) return err(runtime.error);

  const offers: OfferedTool[] = runtime.value.tools.map((tool) => ({
    name: String(tool.name),
    description: tool.description,
    inputSchema: (tool.inputSchema ?? {}) as Readonly<Record<string, unknown>>,
    source: "skills" as const,
  }));

  if (request.toolQuery !== "") {
    const found = await dependencies.tools.findTools({
      authorization: request.authorization,
      query: request.toolQuery,
    });
    if (!found.ok) return err(found.error);
    for (const tool of found.value) {
      offers.push({
        name: tool.toolName,
        description: tool.description,
        inputSchema: tool.paramSchema,
        source: "tools" as const,
      });
    }
  }

  const catalogue = buildToolCatalogue(offers, dependencies.policy.turn.maxToolsPerTurn);
  if (!catalogue.ok) return err(catalogue.error);
  return ok({ systemPrompt: runtime.value.systemPrompt, catalogue: catalogue.value });
}

/** The catalogue, as `providers` wants it. Order is the catalogue's order. */
export function toToolDefinitions(catalogue: ToolCatalogue): readonly ToolDefinition[] {
  return catalogue.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export interface ToolExecutionContext {
  readonly scope: EnvironmentScope;
  readonly vaultAuthorization: SecretsRuntimeGrant;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly endUserId: string | null;
  readonly catalogue: ToolCatalogue;
}

function failure(call: ToolCallPart, message: string): ToolResultPart {
  return {
    kind: "tool-result",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output: { error: message },
    failed: true,
  };
}

/**
 * Run one tool the model asked for, and answer it. Never rejects.
 *
 * FOUR OUTCOMES, ALL RESOLVED: the tool ran and answered; the name was not
 * offered; the peer refused; the answer would not serialize. The last is not
 * pedantry — a `Map`, a `bigint` or an `undefined` on a required field breaks
 * the NEXT round trip rather than this one, which is what makes it so hard to
 * attribute when it happens in the running system.
 */
export async function executeToolCall(
  dependencies: ConversationsDependencies,
  context: ToolExecutionContext,
  call: ToolCallPart,
): Promise<ToolResultPart> {
  const offered = requireOffered(context.catalogue, call.toolName);
  if (!offered.ok) return failure(call, offered.error.code);

  const executed = await dependencies.tools.executeTool({
    scope: context.scope,
    toolName: asIdentifier(call.toolName),
    arguments: (call.input ?? {}) as Readonly<Record<string, unknown>>,
    agentId: asIdentifier(context.agentId),
    threadId: asIdentifier(context.threadId),
    endUserId: context.endUserId === null ? null : asIdentifier(context.endUserId),
    vaultAuthorization: context.vaultAuthorization,
    canPark: false,
  } as Parameters<ConversationsDependencies["tools"]["executeTool"]>[0]);

  if (!executed.ok) return failure(call, executed.error.code);
  if (executed.value.kind === "awaiting_approval") {
    return failure(call, `approval required: ${executed.value.reason}`);
  }

  const sanitized = sanitizeToolResult(executed.value.result);
  if (!sanitized.ok) return failure(call, sanitized.error ?? "unserializable tool result");

  return {
    kind: "tool-result",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output: sanitized.value,
    failed: false,
  };
}
