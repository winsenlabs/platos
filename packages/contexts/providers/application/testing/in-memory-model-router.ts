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

import { providerRequestFailed, type ProbeFailure, type ProviderId } from "../../domain/index.js";
import type {
  ListModelsRequest,
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

export class InMemoryModelRouter implements ModelRouter {
  readonly probes: RecordedProbe[] = [];
  readonly opens: RecordedOpen[] = [];
  readonly listCalls: string[] = [];

  private readonly probeFailures = new Map<string, ProbeFailure>();
  private readonly unreachable = new Set<string>();
  private readonly published = new Map<string, readonly string[]>();
  private sequence = 0;

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
      expiresAt: null,
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
}
