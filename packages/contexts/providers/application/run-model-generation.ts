// Use case: run a generation against a model this environment pays for.
//
// This is the seam ADR M0.3 §1 row 16 needs. `conversations` composes a turn —
// decides what goes in the prompt, what to do with the answer, what to persist
// — and calls this to make the model calls happen. It never learns which
// provider served the turn, never holds a credential, and never imports an
// inference framework, which is what `inference-sdk-only` in
// scripts/arch/boundary-rules.mjs makes non-negotiable rather than aspirational.
//
// FOUR THINGS THIS DOES THAT THE PORT CANNOT DO FOR ITSELF, in order:
//
//   1. RE-CHECK THE GRANT. Running a generation spends a tenant's key, which is
//      the same material read `checkProviderHealth` demands a runtime grant
//      for. The grant is verified against the scope it was called with, not
//      just unwrapped, so a grant minted for a re-parented environment is
//      refused rather than silently honoured.
//
//   2. VALIDATE THE REQUEST BEFORE ANY MATERIAL MOVES. The step budget, the
//      tool names, and the prompt's own cache-breakpoint count are all checked
//      here. Every one of them is a defect a provider would otherwise charge a
//      round trip to discover, and one of them — too many breakpoints — the
//      provider does not report at all: it silently drops the newest one and
//      the turn quietly reverts to full price.
//
//   3. REFUSE AN EXPIRED BINDING, USING THE CLOCK PORT. The port lets an
//      implementation hand back a handle it minted earlier -- and expects it to,
//      because constructing a client per call is waste. That is exactly why
//      `expiresAt` has to be READ by somebody: a cached handle whose provider
//      credential has aged out would otherwise be used, and the call it made
//      would be billed before it failed. Checked here, against the clock port,
//      so it is deterministic at any instant, and under its own code so it is
//      not confused with "no key" or "unknown provider".
//
//   4. SUPPLY THE PER-STEP CACHE PLACEMENT. `rewritePrompt` is bound HERE, from
//      this context's own domain function and this environment's policy, so the
//      adapter holds no placement rule and `conversations` needs no knowledge of
//      one. A turn gets the cheaper bill without anybody upstream asking for it.
//
// WHY `stream` AND `generate` SHARE EVERYTHING BUT THE LAST LINE. They differ in
// delivery and in nothing else — same grant, same validation, same route, same
// placement. Building the request once and branching at the call is what keeps
// them from drifting into two subtly different admission policies.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  DEFAULT_PROMPT_CACHE_POLICY,
  modelSessionExpired,
  placeCacheBreakpoints,
  stepBudget,
  toolCatalogue,
  withinCacheBudget,
  type GenerationEvent,
  type ModelGeneration,
  type ModelRoutePlan,
  type OutputMode,
  type Prompt,
  type PromptCachePolicy,
  type ProviderKey,
  type SamplingLimits,
  type ToolDefinition,
} from "../domain/index.js";
import { verifyRuntimeGrant, type SecretsRuntimeGrant } from "./authorization.js";
import type { ProvidersDependencies } from "./dependencies.js";
import { resolveModelRoute } from "./open-model-route.js";
import type { ModelGenerationRequest, ModelSession, ToolExecutor } from "./ports/index.js";

export interface RunModelGenerationCommand {
  readonly authorization: SecretsRuntimeGrant;
  readonly scope: EnvironmentScope;
  /** `<provider>:<model>`, or a bare model name routed to the default provider. */
  readonly model: string;
  /** An agent version's pinned key. Absent means "use the environment default". */
  readonly providerKeyId?: ProviderKey["providerKeyId"] | null;
  readonly prompt: Prompt;
  readonly tools: readonly ToolDefinition[];
  readonly executeTool: ToolExecutor;
  readonly output: OutputMode;
  readonly sampling: SamplingLimits;
  readonly maxSteps: number;
  readonly abortSignal?: AbortSignal | null;
  /**
   * Absent means the default, which is what every caller should pass.
   *
   * Present so a test can exercise the stride rule on a short prompt, and so an
   * installation whose provider raises the limit can say so without a code
   * change.
   */
  readonly cachePolicy?: PromptCachePolicy;
}

export interface ModelGenerationOutcome {
  readonly generation: ModelGeneration;
  readonly plan: ModelRoutePlan;
  /** Which key paid for it. The caller records this against the turn. */
  readonly providerKey: ProviderKey;
}

export interface ModelStreamOutcome {
  readonly events: AsyncIterable<GenerationEvent>;
  readonly plan: ModelRoutePlan;
  readonly providerKey: ProviderKey;
}

interface AdmittedRequest {
  readonly request: ModelGenerationRequest;
  readonly plan: ModelRoutePlan;
  readonly providerKey: ProviderKey;
}

/**
 * Everything between the caller's command and the port call.
 *
 * Returns the finished request rather than making the call, so the two entry
 * points below cannot diverge in what they admit — only in how they deliver.
 */
async function admit(
  dependencies: ProvidersDependencies,
  command: RunModelGenerationCommand,
): Promise<Result<AdmittedRequest>> {
  const granted = verifyRuntimeGrant(command.authorization, command.scope);
  if (!granted.ok) return err(granted.error);

  const policy = command.cachePolicy ?? DEFAULT_PROMPT_CACHE_POLICY;
  const budget = stepBudget(command.maxSteps);
  if (!budget.ok) return err(budget.error);
  const tools = toolCatalogue(command.tools);
  if (!tools.ok) return err(tools.error);
  const admissible = withinCacheBudget(command.prompt, policy);
  if (!admissible.ok) return err(admissible.error);

  const route = await resolveModelRoute(dependencies, {
    authorization: command.authorization,
    scope: command.scope,
    model: command.model,
    providerKeyId: command.providerKeyId ?? null,
  });
  if (!route.ok) return err(route.error);

  const opened = await dependencies.modelRouter.open({
    plan: route.value.plan,
    credential: route.value.credential,
  });
  if (!opened.ok) return err(opened.error);
  const usable = requireUnexpired(opened.value, dependencies.clock.now());
  if (!usable.ok) return err(usable.error);

  const rewritePrompt = (prompt: Prompt): Prompt =>
    placeCacheBreakpoints(prompt, route.value.plan, policy);

  return ok({
    plan: route.value.plan,
    providerKey: route.value.providerKey,
    request: {
      session: usable.value,
      credential: route.value.credential,
      prompt: rewritePrompt(admissible.value),
      tools: tools.value,
      executeTool: command.executeTool,
      output: command.output,
      sampling: command.sampling,
      maxSteps: budget.value,
      rewritePrompt,
      abortSignal: command.abortSignal ?? null,
    },
  });
}

/**
 * A binding whose expiry has passed is refused rather than used.
 *
 * `expiresAt === null` means the binding does not expire, which is not the same
 * as "expired long ago" and must not be treated as one. The comparison is `<=`,
 * so a handle expiring at exactly this instant is already gone: a binding is
 * valid up to its expiry, not through it.
 */
function requireUnexpired(session: ModelSession, now: Date): Result<ModelSession> {
  if (session.expiresAt !== null && session.expiresAt.getTime() <= now.getTime()) {
    return err(modelSessionExpired(session.sessionId, session.expiresAt.toISOString()));
  }
  return ok(session);
}

export async function runModelGeneration(
  dependencies: ProvidersDependencies,
  command: RunModelGenerationCommand,
): Promise<Result<ModelGenerationOutcome>> {
  const admitted = await admit(dependencies, command);
  if (!admitted.ok) return err(admitted.error);

  const generated = await dependencies.modelRouter.generate(admitted.value.request);
  if (!generated.ok) return err(generated.error);
  return ok({
    generation: generated.value,
    plan: admitted.value.plan,
    providerKey: admitted.value.providerKey,
  });
}

export async function streamModelGeneration(
  dependencies: ProvidersDependencies,
  command: RunModelGenerationCommand,
): Promise<Result<ModelStreamOutcome>> {
  const admitted = await admit(dependencies, command);
  if (!admitted.ok) return err(admitted.error);

  const started = await dependencies.modelRouter.stream(admitted.value.request);
  if (!started.ok) return err(started.error);
  return ok({
    events: started.value,
    plan: admitted.value.plan,
    providerKey: admitted.value.providerKey,
  });
}
