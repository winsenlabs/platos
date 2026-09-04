// In-memory doubles for the driven ports that are NOT the repository.
//
// Each one records what it was asked and can be told to fail, because the
// interesting assertions in this context are about what happens when a provider
// says no. `CHANNELS_ADAPTER_UNAUTHORIZED` and `CHANNELS_ADAPTER_UNAVAILABLE`
// must lead to different outcomes — one is terminal, the other is retried — and
// that difference is unprovable against a double that always succeeds.

import { err, ok, type Result } from "@platos/kernel";

import {
  adapterUnauthorized,
  adapterUnavailable,
  appNotFound,
  type SealedEventPayload,
} from "../../domain/index.js";
import type {
  AgentDirectory,
  ChannelAdapter,
  ChannelAdapterRegistry,
  ChannelCredential,
  ChannelCredentialReader,
  ChannelEventCipher,
  ChannelPrincipal,
  DeliveredMessage,
  OutboundMessage,
} from "../ports/index.js";

export class InMemoryChannelAdapter implements ChannelAdapter {
  readonly sent: OutboundMessage[] = [];
  private failure: "unauthorized" | "unavailable" | null = null;
  private counter = 0;

  constructor(readonly provider: string = "slack") {}

  /** Make every later call fail, until `recover()`. */
  failWith(mode: "unauthorized" | "unavailable"): void {
    this.failure = mode;
  }

  recover(): void {
    this.failure = null;
  }

  private currentFailure<Value>(): Result<Value> | null {
    if (this.failure === null) return null;
    return this.failure === "unauthorized"
      ? err(adapterUnauthorized(this.provider, "token revoked"))
      : err(adapterUnavailable(this.provider, "provider down"));
  }

  async send(_credential: ChannelCredential, message: OutboundMessage): Promise<Result<DeliveredMessage>> {
    const failure = this.currentFailure<DeliveredMessage>();
    if (failure !== null) return failure;
    this.sent.push(message);
    this.counter += 1;
    return ok({
      providerMessageId: `msg-${this.counter}`,
      deliveredAt: new Date("2026-01-01T00:00:00.000Z"),
    });
  }

  async describePrincipal(
    _credential: ChannelCredential,
    providerUserId: string,
  ): Promise<Result<ChannelPrincipal>> {
    const failure = this.currentFailure<ChannelPrincipal>();
    if (failure !== null) return failure;
    return ok({ providerUserId, displayName: `user ${providerUserId}`, email: null });
  }

  async verifyCredential(_credential: ChannelCredential): Promise<Result<void>> {
    const failure = this.currentFailure<void>();
    if (failure !== null) return failure;
    return ok(undefined);
  }
}

export class InMemoryAdapterRegistry implements ChannelAdapterRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();

  constructor(...adapters: readonly ChannelAdapter[]) {
    for (const adapter of adapters) this.adapters.set(adapter.provider, adapter);
  }

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  adapterFor(provider: string): Result<ChannelAdapter> {
    const adapter = this.adapters.get(provider);
    // A provider with no adapter is a WIRING defect, so it fails loudly rather
    // than returning undefined for a caller to dereference.
    if (adapter === undefined) return err(appNotFound(`no adapter for provider ${provider}`));
    return ok(adapter);
  }
}

export class InMemoryCredentialReader implements ChannelCredentialReader {
  readonly reads: Array<{ credentialId: string; tokenGeneration: number }> = [];
  private missing = false;

  makeMissing(): void {
    this.missing = true;
  }

  async read(credentialId: string, tokenGeneration: number): Promise<Result<ChannelCredential>> {
    this.reads.push({ credentialId, tokenGeneration });
    if (this.missing) return err(adapterUnauthorized("secrets", "credential is absent"));
    return ok({ token: `token-for-${credentialId}`, tokenGeneration });
  }
}

/**
 * The forged-id guard's double.
 *
 * Deliberately DENIES BY DEFAULT: an empty directory returns no agents, so a
 * test that forgets to register one sees the guard reject rather than pass. A
 * guard double that allowed by default would make every routing test green
 * whether or not the guard was wired at all.
 */
export class InMemoryAgentDirectory implements AgentDirectory {
  private readonly byEnvironment = new Map<string, Set<string>>();

  register(environmentId: string, ...agentIds: readonly string[]): void {
    const existing = this.byEnvironment.get(environmentId) ?? new Set<string>();
    for (const agentId of agentIds) existing.add(agentId);
    this.byEnvironment.set(environmentId, existing);
  }

  async agentsInEnvironment(
    environmentId: string,
    agentIds: readonly string[],
  ): Promise<Result<readonly string[]>> {
    const known = this.byEnvironment.get(environmentId) ?? new Set<string>();
    return ok(agentIds.filter((agentId) => known.has(agentId)));
  }
}

/**
 * A reversible, non-cryptographic stand-in for the payload cipher.
 *
 * It is NOT encryption and must never be mistaken for it — the point is that
 * the use cases never look inside a `SealedEventPayload`, so a double that
 * merely round-trips proves the seal/open contract is honoured without pulling
 * a crypto implementation into a domain test.
 *
 * The transform is a character reversal rather than base64 so this file needs
 * no platform global at all: `application/**` is scanned for framework and
 * runtime reach, and a double is not a reason to be the first file that needs
 * an exception.
 */
export class ReversibleEventCipher implements ChannelEventCipher {
  static readonly FORMAT_VERSION = 1;
  static readonly KEY_VERSION = 7;

  private failing = false;

  failNext(): void {
    this.failing = true;
  }

  async seal(plaintext: string): Promise<Result<SealedEventPayload>> {
    if (this.failing) {
      this.failing = false;
      return err(adapterUnavailable("cipher", "key unavailable"));
    }
    return ok({
      formatVersion: ReversibleEventCipher.FORMAT_VERSION,
      keyVersion: ReversibleEventCipher.KEY_VERSION,
      ciphertext: [...plaintext].reverse().join(""),
    });
  }

  async open(sealed: SealedEventPayload): Promise<Result<string>> {
    if (sealed.formatVersion !== ReversibleEventCipher.FORMAT_VERSION) {
      return err(adapterUnavailable("cipher", `unknown format version ${sealed.formatVersion}`));
    }
    return ok([...sealed.ciphertext].reverse().join(""));
  }
}
