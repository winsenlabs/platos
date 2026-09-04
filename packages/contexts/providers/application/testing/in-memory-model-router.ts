// An in-memory `ModelRouter`.
//
// It holds no client and calls nothing. What it DOES do is record every request
// it was handed, which is what lets a test assert the two properties the port's
// contract exists to guarantee and that no other double can check:
//
//   * the credential reached the router as material and NOT as a fingerprint;
//   * the plan the router received is the one the domain built, root and all.
//
// Programmable per provider, so a test can make one provider refuse a credential
// and another time out without either of them being a special case in the code
// under test.

import { err, ok, type Result } from "@platos/kernel";

import {
  modelGeneration,
  providerRequestFailed,
  tokenUsage,
  type FinishReason,
  type GenerationEvent,
  type GenerationStep,
  type ModelGeneration,
  type ProbeFailure,
  type Prompt,
  type PromptMessage,
  type ProviderId,
  type TokenUsageDraft,
  type ToolCallPart,
  type ToolResultPart,
} from "../../domain/index.js";
import type {
  ListModelsRequest,
  ModelGenerationRequest,
  ModelRouter,
  ModelSession,
  OpenModelRequest,
  ProbeModelRequest,
  ProbeOutcome,
} from "../ports/index.js";

export interface RecordedProbe {
  readonly provider: ProviderId;
  readonly model: string;
  readonly baseUrl: string | null;
  /** What the router was actually given. A test asserts the real material here. */
  readonly revealed: string;
  readonly fingerprint: string;
  readonly timeoutMs: number;
}

export interface RecordedOpen {
  readonly provider: ProviderId;
  readonly model: string;
  readonly baseUrl: string | null;
  readonly chatCompletionsOnly: boolean;
  readonly revealed: string;
}

/** One model call this double will pretend to make. */
export interface ScriptedStep {
  readonly text?: string;
  readonly toolCalls?: readonly Omit<ToolCallPart, "kind">[];
  readonly usage: TokenUsageDraft;
  readonly reasoningTokens?: number;
  readonly finishReason?: FinishReason;
}

/**
 * What the double saw at the top of one step.
 *
 * The cache-breakpoint indices are recorded per step because that is the only
 * way to prove the property the placement rule exists for: that the marker
 * MOVES as the message array grows, rather than accumulating or standing still.
 * A test asserting only the final prompt could not tell those three apart.
 */
export interface RecordedStep {
  readonly messageCount: number;
  readonly breakpointIndices: readonly number[];
  readonly toolNames: readonly string[];
}

export interface RecordedGeneration {
  readonly provider: ProviderId;
  readonly model: string;
  /** What the router was actually given. A test asserts the real material here. */
  readonly revealed: string;
  readonly sessionId: string;
  readonly maxSteps: number;
  readonly outputKind: string;
  readonly steps: readonly RecordedStep[];
}

export class InMemoryModelRouter implements ModelRouter {
  readonly probes: RecordedProbe[] = [];
  readonly opens: RecordedOpen[] = [];
  readonly listCalls: string[] = [];
  readonly generations: RecordedGeneration[] = [];

  private readonly probeFailures = new Map<string, ProbeFailure>();
  private readonly unreachable = new Set<string>();
  private readonly published = new Map<string, readonly string[]>();
  private readonly scripts = new Map<string, readonly ScriptedStep[]>();
  private sequence = 0;
  private expiry: Date | null = null;

  /** Make this provider refuse or fail the next liveness call. */
  failProbe(provider: string, failure: ProbeFailure): void {
    this.probeFailures.set(provider, failure);
  }

  /** Make this provider unreachable — an `err`, not a refusal. */
  breakProvider(provider: string): void {
    this.unreachable.add(provider);
  }

  /** What this provider will publish when asked for its model list. */
  publishModels(provider: string, models: readonly string[]): void {
    this.published.set(provider, models);
  }

  /** The steps this provider will answer a generation with, in order. */
  scriptGeneration(provider: string, steps: readonly ScriptedStep[]): void {
    this.scripts.set(provider, steps);
  }

  /** Hand out sessions that have already expired, to exercise that refusal. */
  expireSessionsAt(instant: Date | null): void {
    this.expiry = instant;
  }

  async open(request: OpenModelRequest): Promise<Result<ModelSession>> {
    this.opens.push({
      provider: request.plan.reference.provider,
      model: request.plan.reference.modelName,
      baseUrl: request.plan.baseUrl,
      chatCompletionsOnly: request.plan.chatCompletionsOnly,
      revealed: request.credential.reveal(),
    });
    if (this.unreachable.has(request.plan.reference.provider)) {
      return err(providerRequestFailed("in-memory provider is unreachable"));
    }
    return ok({
      sessionId: `session-${(this.sequence += 1)}`,
      plan: request.plan,
      expiresAt: this.expiry,
    });
  }

  async probe(request: ProbeModelRequest): Promise<Result<ProbeOutcome>> {
    const provider = request.plan.reference.provider;
    this.probes.push({
      provider,
      model: request.plan.reference.modelName,
      baseUrl: request.plan.baseUrl,
      revealed: request.credential.reveal(),
      fingerprint: request.credential.fingerprint,
      timeoutMs: request.timeoutMs,
    });
    if (this.unreachable.has(provider)) {
      return err(providerRequestFailed("in-memory provider is unreachable"));
    }
    const failure = this.probeFailures.get(provider) ?? null;
    return ok({ failure, model: request.plan.reference.modelName });
  }

  async listModels(request: ListModelsRequest): Promise<Result<readonly string[]>> {
    const provider = request.plan.reference.provider;
    this.listCalls.push(provider);
    if (this.unreachable.has(provider)) {
      return err(providerRequestFailed("in-memory provider is unreachable"));
    }
    return ok(this.published.get(provider) ?? []);
  }

  async generate(request: ModelGenerationRequest): Promise<Result<ModelGeneration>> {
    // Nothing listens on the non-streaming path, so the events go nowhere. The
    // loop still produces them, which is what keeps the two paths from being
    // two different loops that can disagree.
    return this.run(request, () => {});
  }

  async stream(request: ModelGenerationRequest): Promise<Result<AsyncIterable<GenerationEvent>>> {
    const events: GenerationEvent[] = [];
    const outcome = await this.run(request, (event) => events.push(event));
    if (!outcome.ok) return err(outcome.error);
    events.push({ kind: "finished", generation: outcome.value });
    return ok({
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
      },
    });
  }

  /**
   * The scripted round trips, run honestly.
   *
   * "Honestly" means three things a lazier double would skip, each of which a
   * test in this package depends on:
   *
   *   * `rewritePrompt` is called at the top of EVERY step, on the prompt that
   *     step would actually send, including the messages the previous steps
   *     added. Anything less and the per-step cache placement would look like it
   *     worked while never having been exercised past the first call.
   *   * a scripted tool call really goes through the caller's executor, and its
   *     answer really goes back into the prompt as a `tool-result` part, so the
   *     round trip is a round trip rather than a recorded shape.
   *   * every step's usage goes through `tokenUsage`, so a script whose cache
   *     counts exceed its input count is refused here exactly as it would be by
   *     a real provider's reading.
   */
  private async run(
    request: ModelGenerationRequest,
    emit: (event: GenerationEvent) => void,
  ): Promise<Result<ModelGeneration>> {
    const provider = request.session.plan.reference.provider;
    if (this.unreachable.has(provider)) {
      return err(providerRequestFailed("in-memory provider is unreachable"));
    }
    const script = (this.scripts.get(provider) ?? [{ usage: {} }]).slice(0, request.maxSteps);
    const seen: RecordedStep[] = [];
    const steps: GenerationStep[] = [];
    let messages: readonly PromptMessage[] = request.prompt.messages;
    let text = "";

    for (const scripted of script) {
      const prepared = request.rewritePrompt({ messages });
      messages = prepared.messages;
      seen.push({
        messageCount: messages.length,
        breakpointIndices: messages.flatMap((message, index) => (message.cacheBreakpoint ? [index] : [])),
        toolNames: request.tools.map((tool) => tool.name),
      });

      const step = await this.runStep(request, scripted, messages, emit);
      if (!step.ok) return err(step.error);
      messages = step.value.messages;
      text = scripted.text ?? text;
      steps.push(step.value.step);
      emit({ kind: "step-finished", step: step.value.step });
    }

    this.generations.push({
      provider,
      model: request.session.plan.reference.modelName,
      revealed: request.credential.reveal(),
      sessionId: request.session.sessionId,
      maxSteps: request.maxSteps,
      outputKind: request.output.kind,
      steps: seen,
    });
    return modelGeneration({
      text,
      object: request.output.kind === "object" ? { text } : undefined,
      steps,
      finishReason: steps[steps.length - 1]?.finishReason ?? "stop",
    });
  }

  private async runStep(
    request: ModelGenerationRequest,
    scripted: ScriptedStep,
    messages: readonly PromptMessage[],
    emit: (event: GenerationEvent) => void,
  ): Promise<Result<{ readonly step: GenerationStep; readonly messages: readonly PromptMessage[] }>> {
    const usage = tokenUsage(scripted.usage);
    if (!usage.ok) return err(usage.error);

    const calls: ToolCallPart[] = (scripted.toolCalls ?? []).map((call) => ({ ...call, kind: "tool-call" }));
    const results: ToolResultPart[] = [];
    const next = [...messages];
    if (scripted.text !== undefined) emit({ kind: "text-delta", text: scripted.text });
    if (calls.length > 0) {
      next.push({ role: "assistant", content: calls, cacheBreakpoint: false });
      for (const call of calls) {
        emit({ kind: "tool-call", call });
        const result = await request.executeTool(call);
        results.push(result);
        emit({ kind: "tool-result", result });
      }
      next.push({ role: "tool", content: results, cacheBreakpoint: false });
    } else if (scripted.text !== undefined) {
      next.push({ role: "assistant", content: [{ kind: "text", text: scripted.text }], cacheBreakpoint: false });
    }

    return ok({
      messages: next,
      step: {
        text: scripted.text ?? "",
        toolCalls: calls,
        toolResults: results,
        usage: usage.value,
        reasoningTokens: scripted.reasoningTokens ?? 0,
        finishReason: scripted.finishReason ?? (calls.length > 0 ? "tool-calls" : "stop"),
      },
    });
  }
}

/** Read a prompt's marked indices, for a test that has one in hand. */
export function breakpointIndicesOf(prompt: Prompt): readonly number[] {
  return prompt.messages.flatMap((message, index) => (message.cacheBreakpoint ? [index] : []));
}
