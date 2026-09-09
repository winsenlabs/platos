// The `governance` `Judge` port, satisfied HERE and not by an adapter directory.
//
// ---------------------------------------------------------------------------
// WHY THIS IS NOT `packages/adapters/judge-something`, MEASURED THREE WAYS
//
// `apps/core-api/src/composition/context-ports.ts` records `Judge` among the
// five governance driven ports "no adapter directory satisfies", and
// `GOVERNANCE_UNBOUND_PORTS` checks that claim against `ADAPTER_BINDINGS`. The
// claim is TRUE and it will stay true, because no adapter directory CAN satisfy
// this port. Three independent rules say so and each one stands alone:
//
//   1. NO NEW DIRECTORY MAY HOLD A PROVIDER CLIENT. `provider-sdk-only` and
//      `inference-sdk-only` in `scripts/arch/boundary-rules.mjs` pin
//      `node_modules/(openai|@anthropic-ai)` and the cross-vendor inference
//      framework to `^packages/adapters/model-router-providers/` and to nothing
//      else. A `judge-*` directory that opened a model connection would fail the
//      boundary gate on its first import.
//
//   2. `model-router-providers` CANNOT SATISFY IT EITHER, and this is the one
//      that decides the question. Every method on the `ModelRouter` port takes a
//      `ProviderCredential` — "the credential is supplied per call and never
//      stored", says its header, and the adapter "is forbidden from reading an
//      ambient one". `Judge.ask` is handed an `EnvironmentScope` and a
//      `JudgeModel` and NO credential. The one thing in this tree that turns an
//      environment plus a model string into material is
//      `providers/application/resolve-provider-credential.ts`, reachable only
//      through `ProvidersContract`, and an adapter may not import a context
//      contract that does not own one of its ports. `apps/core-api/src/config/
//      providers.ts` declares four variables and not one of them is a key, so
//      there is no configured key to hand it either.
//
//   3. THE PORT REQUIRES A PRICE, AND PRICING IS A CONTEXT'S. `JudgeAnswer.
//      costCents` exists because `judge.ts` says "the adapter prices what it just
//      paid for and hands the number back", and the only pricing surface in the
//      tree is `ProvidersContract.priceModelUsage`. No adapter-facing port prices
//      anything.
//
// So this port belongs where `read-seams.ts` already says its own three belong:
// "the composition root implements it by asking whichever context owns the
// rows". Here the composition root implements it by asking the context that owns
// the keys, the routes and the rate cards. `governance` names no peer it may not
// name, and the day `providers` changes, this file changes.
//
// ---------------------------------------------------------------------------
// THE GRANT THIS MINTS, AND WHAT STANDS BETWEEN IT AND AN ESCALATION
//
// `runModelGeneration` requires a `SecretsRuntimeGrant`; `Judge.ask` carries no
// authorization at all, only the scope. So an implementation over `providers`
// MUST mint one, and that is stated here rather than left to be discovered.
//
// What it mints is the narrowest grant the vault publishes:
// `authorizeEnvironmentRuntime` yields `access: "secret:read"` for ONE
// environment and can never mutate. What bounds the ENVIRONMENT is the caller:
// `run-judge.ts` takes `scope` from `verifyOperator(...).value.scope` — a grant
// it has already verified — and passes that, and nothing else, into this seam.
// This object therefore reads keys for whatever environment it is handed, and
// the guarantee that it is handed the right one lives in the use case, not here.
// `governance-judge.test.ts` pins both halves: the minted grant's ancestry is the
// requested scope field for field, and its access is `secret:read`.
//
// ---------------------------------------------------------------------------
// WHAT CAN BE REPLAYED FROM A STORED SCORE, AND WHAT CANNOT
//
// `run-judge.ts` stores `judgeModel` (the canonical `<provider>:<model>` spec),
// `judgePromptUsed` and `rawResponse` on `AgentEval`, so the question, the model
// and the answer all survive on the row and a score can be re-derived from them.
// TWO THINGS CANNOT, and the port has no field for either:
//
//   * WHICH ROUTE AND WHICH KEY SERVED IT. `runModelGeneration` answers with the
//     resolved `plan` and the `providerKey` that paid, and `JudgeAnswer` carries
//     text, usage and a price. A base URL override or a rotated key changes what
//     a model answers and nothing on the row would say so.
//
//   * WHY A FAILED JUDGE FAILED, IN ITS OWN WORDS. `run-judge.ts` writes
//     `error.message` into the rationale, and this port's refusal is
//     `judgeUnavailable`, whose message is the fixed "the judge could not be
//     reached". The provider's own code and text reach `details.reason`, which
//     nothing stores.
//
// Neither is invented into the port. Both are EMITTED on the `Logger` at the
// moment they are known — the one channel a composition-root object legitimately
// holds — under `governance.judge.answered` and `governance.judge.unavailable`,
// keyed by scope, model spec and a prompt fingerprint, so a stored score can be
// joined to the route that produced it after the fact.
//
// THE FINGERPRINT IS NOT A DIGEST. This file may not reach for a hash: the
// `SecretHasher` port's implementation is `node-crypto-digest`, an ADAPTER, and
// `adapter-bindings.ts` is the one file entitled to name one. It is the prompt's
// length and its first and last few characters, which is enough to tell two
// judge calls in one environment apart and is not enough to reconstruct either.

import type { ActorId } from "@platos/context-secrets";
import { authorizeEnvironmentRuntime } from "@platos/context-secrets";
import type { ProvidersContract, TokenUsage } from "@platos/context-providers";
import {
  NO_SAMPLING_LIMITS,
  prompt as assemblePrompt,
  promptMessage,
  TEXT_OUTPUT,
  textPart,
} from "@platos/context-providers";
import type {
  Judge,
  JudgeAnswer,
  JudgeRequest,
  JudgeUsage,
} from "@platos/context-governance/application/ports/index.js";
import { judgeUnavailable } from "@platos/context-governance/application/ports/index.js";
import { asIdentifier, err, ok, type DomainError, type Logger, type Result } from "@platos/kernel";

/**
 * The actor every judge call is attributed to.
 *
 * A constant rather than a parameter because it is not a person and must not be
 * mistakable for one: a `CredentialAudit` row naming an operator for a score
 * nobody asked that operator for would be a false audit trail. It is spelled as
 * a URN so it cannot collide with a `User.id`, which is a UUID.
 */
export const JUDGE_ACTOR_ID: ActorId = asIdentifier<ActorId>("urn:platos:system:governance-judge");

/** One tool round trip is one too many: a judge answers, it does not act. */
const JUDGE_MAX_STEPS = 1;

/** No tools, and a callable that proves it by refusing to be called. */
const NO_TOOLS = Object.freeze([]);

export interface ProvidersJudgeOptions {
  readonly providers: ProvidersContract;
  readonly logger: Logger;
  /** Overridable so a suite can pin the attribution it asserts on. */
  readonly actorId?: ActorId;
}

/**
 * A judge that is the `providers` context, seen through `governance`'s port.
 *
 * Returns `Result` on every path and rejects on none: `run-judge.ts` turns a
 * refusal into a stored zero-scored eval, and a thrown error there would lose
 * the row the source's own catch was written to leave behind.
 */
export function createProvidersJudge(options: ProvidersJudgeOptions): Judge {
  const actorId = options.actorId ?? JUDGE_ACTOR_ID;
  return {
    async ask(request: JudgeRequest): Promise<Result<JudgeAnswer>> {
      const composed = composePrompt(request);
      if (!composed.ok) return err(refuse(options.logger, request, composed.error));

      const generated = await options.providers.runModelGeneration({
        authorization: authorizeEnvironmentRuntime({
          ancestry: {
            organizationId: request.scope.organizationId,
            projectId: request.scope.projectId,
            environmentId: request.scope.environmentId,
          },
          actorId,
        }),
        scope: request.scope,
        model: request.model.spec,
        prompt: composed.value,
        tools: NO_TOOLS,
        // A generation with no catalogue makes no round trips, so this is
        // unreachable rather than merely unused. It rejects rather than
        // answering, because a judge that silently ran a tool would have scored
        // a conversation it also participated in.
        executeTool: () => Promise.reject(new Error("the judge runs no tools")),
        output: TEXT_OUTPUT,
        sampling: NO_SAMPLING_LIMITS,
        maxSteps: JUDGE_MAX_STEPS,
      });
      if (!generated.ok) return err(refuse(options.logger, request, generated.error));

      const usage = readUsage(generated.value.generation);
      const costCents = await price(options.providers, request, generated.value.generation.totalUsage);
      options.logger.log("info", "governance.judge.answered", {
        ...identify(request),
        // The two facts `JudgeAnswer` has no field for. See the header.
        provider: generated.value.plan.reference.provider,
        modelName: generated.value.plan.reference.modelName,
        dialect: generated.value.plan.dialect,
        baseUrl: generated.value.plan.baseUrl ?? null,
        providerKeyId: generated.value.providerKey.providerKeyId,
        // The BARE REFERENCE NAME, which is the only handle on a credential this
        // context's contract publishes: `contracts/index.ts` withholds the
        // credential id outright, "because an id is a handle into another
        // context's store".
        credentialName: generated.value.providerKey.credentialName,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costCents,
        priced: costCents !== null,
      });
      return ok({ text: generated.value.generation.text, usage, costCents });
    },
  };
}

/**
 * The judge's two messages: standing instructions, then the criterion.
 *
 * They are SEPARATE messages rather than one concatenated block because
 * `role: "system"` is what a provider treats as instructions it may not be
 * argued out of, and a transcript pasted into a system prompt is a transcript
 * that can rewrite the rubric it is being scored against.
 */
function composePrompt(request: JudgeRequest): Result<Parameters<ProvidersContract["runModelGeneration"]>[0]["prompt"]> {
  const instructions = promptMessage({ role: "system", content: [textPart(request.instructions)] });
  if (!instructions.ok) return err(instructions.error);
  const criterion = promptMessage({ role: "user", content: [textPart(request.prompt)] });
  if (!criterion.ok) return err(criterion.error);
  return assemblePrompt([instructions.value, criterion.value]);
}

/**
 * Translate a refusal, and leave the provider's own words somewhere.
 *
 * The port's refusal is `GOVERNANCE_JUDGE_UNAVAILABLE` — `judge.ts` says so, and
 * a `PROVIDERS_*` code answered here would be a code from a context `governance`
 * may not import, reaching a transport that has no mapping for it. The original
 * survives in `details.reason` and on the log line, which is the whole of what
 * the port allows.
 */
function refuse(logger: Logger, request: JudgeRequest, cause: DomainError): DomainError {
  logger.log("warn", "governance.judge.unavailable", {
    ...identify(request),
    causeCode: cause.code,
    causeMessage: cause.message,
  });
  return judgeUnavailable(`${cause.code}: ${cause.message}`);
}

/** What identifies one judge call in a log, and what it deliberately omits. */
function identify(request: JudgeRequest): Record<string, string | number> {
  return {
    organizationId: request.scope.organizationId,
    projectId: request.scope.projectId,
    environmentId: request.scope.environmentId,
    judgeModel: request.model.spec,
    promptLength: request.prompt.length,
    promptFingerprint: fingerprint(request.prompt),
  };
}

/**
 * Enough of a prompt to tell two judge calls apart; not enough to read either.
 *
 * Sixteen characters from each end and the length. A transcript is thousands of
 * characters of a tenant's own conversation and none of it belongs in a log
 * line, so this takes the framing the criterion renderer puts there and stops.
 */
function fingerprint(value: string): string {
  const edge = 16;
  if (value.length <= edge * 2) return `${value.length}:${value}`;
  return `${value.length}:${value.slice(0, edge)}…${value.slice(-edge)}`;
}

/**
 * `TokenUsage` as `JudgeUsage`, and the two places the shapes disagree.
 *
 * `cacheCreationInputTokens` is `providers`' `cacheWriteInputTokens` — one fact,
 * two vendors' spellings — and `reasoningTokens` is not on `TokenUsage` at all:
 * `generation.ts` says a step's reasoning tokens are "already inside
 * `usage.outputTokens`" and reports them per STEP, so the total is summed from
 * the steps rather than left null. Every field is a number here because
 * `providers` has already normalised them; the port types them nullable because
 * an implementation over a raw client might not have them.
 */
function readUsage(generation: { readonly totalUsage: TokenUsage; readonly steps: readonly { readonly reasoningTokens: number }[] }): JudgeUsage {
  return {
    inputTokens: generation.totalUsage.inputTokens,
    outputTokens: generation.totalUsage.outputTokens,
    cacheReadInputTokens: generation.totalUsage.cacheReadInputTokens,
    cacheCreationInputTokens: generation.totalUsage.cacheWriteInputTokens,
    reasoningTokens: generation.steps.reduce((total, step) => total + step.reasoningTokens, 0),
  };
}

/**
 * Price what was just paid for, or answer null.
 *
 * NULL IS A REAL ANSWER AND NOT A SWALLOWED ERROR. The port says `costCents` is
 * "null when it could not price what it was billed for", and the commonest cause
 * is an install with no rate card for the judge's model —
 * `PROVIDERS_MODEL_PRICING_UNAVAILABLE`. Refusing the whole judge call over a
 * missing price would throw away a score that was already paid for.
 *
 * THE NARROWING IS THE PORT'S, NOT THIS FILE'S. `PricedUsageView.costCents` is a
 * canonical `Decimal(18, 6)` STRING — "never a number", says the view — and
 * `JudgeAnswer.costCents` is a `number`. `AgentEval.costCents` is
 * `Decimal(18, 6)` again in the canonical schema, so the float is a round trip
 * through this port and not the stored precision. A value that does not parse
 * finitely is answered as null rather than as a wrong number.
 */
async function price(
  providers: ProvidersContract,
  request: JudgeRequest,
  usage: TokenUsage,
): Promise<number | null> {
  const priced = await providers.priceModelUsage({ model: request.model.spec, usage });
  if (!priced.ok) return null;
  const cents = Number(priced.value.costCents);
  return Number.isFinite(cents) ? cents : null;
}
