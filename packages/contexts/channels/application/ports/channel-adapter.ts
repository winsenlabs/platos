// `ChannelAdapter` — the adapter-facing port this context OWNS (ADR M0.3 §13).
//
// ADR M0.3 §1 makes `channels` the "sole holder of Slack/etc SDKs behind
// `ChannelAdapter`", and §5.1(h) pins each vendor client to one adapter
// directory. This interface is the seam: `packages/adapters/channel-slack` and
// its siblings implement it and have exactly one import edge, to this
// entrypoint. Nothing above this line may name a provider SDK, and nothing below
// it may name a Platos aggregate.
//
// EVERY METHOD RETURNS `Result`, NEVER THROWS. A vendor exception escaping into
// a use case would drag the SDK's error taxonomy across the boundary that exists
// to contain it, and would make the failure paths invisible in the type. An
// adapter maps its client's errors onto the three `CHANNELS_ADAPTER_*` codes,
// and the distinction between them is what a caller acts on:
//
//   UNAUTHORIZED  the credential is dead — refresh or re-authorize; never retry.
//   UNAVAILABLE   the provider is down — retry with backoff.
//   REJECTED      the message is bad — retrying sends the same bad message.
//
// Collapsing those three into one is how a revoked installation becomes an
// infinite retry loop.

import type { Result } from "@platos/kernel";

import type { ChannelThreadKey, EndUserId } from "../../domain/index.js";

/** What the adapter needs to reach one workspace. Opaque, and never logged. */
export interface ChannelCredential {
  /**
   * The decrypted token material, as the provider expects it. Handed to the
   * adapter per call rather than cached inside it, so a rotation takes effect
   * on the next send instead of on the next process restart.
   */
  readonly token: string;
  /**
   * The generation this token was read at. Carried so an adapter can report a
   * rejection against the exact credential version that failed, which is what
   * lets the refresh fence tell a stale token from a revoked installation.
   */
  readonly tokenGeneration: number;
}

/** One message to post back into a channel conversation. */
export interface OutboundMessage {
  readonly channelThreadKey: ChannelThreadKey;
  readonly text: string;
  /**
   * Set when the provider supports editing: the adapter replaces this message
   * rather than posting a new one. Streaming a turn back into a channel is an
   * edit loop, not a message flood.
   */
  readonly replacesProviderMessageId: string | null;
}

/** What the provider assigned to a delivered message. */
export interface DeliveredMessage {
  readonly providerMessageId: string;
  readonly deliveredAt: Date;
}

/** A provider-side author, as far as the provider will describe one. */
export interface ChannelPrincipal {
  readonly providerUserId: string;
  readonly displayName: string | null;
  /** Null unless the provider both knows it and the app was granted the scope. */
  readonly email: string | null;
}

export interface ChannelAdapter {
  /** The provider this adapter speaks for — one adapter, one provider. */
  readonly provider: string;

  /**
   * Post or edit a message. Idempotency is the CALLER's: the provider offers
   * none, so a redelivery is prevented by the inbox lease, not here.
   */
  send(credential: ChannelCredential, message: OutboundMessage): Promise<Result<DeliveredMessage>>;

  /**
   * Describe a provider-side author, for linking to an `EndUserId`.
   *
   * `channels` never writes the identity row — that is `identity-access` — so
   * this returns a description and the linking decision is made above it.
   */
  describePrincipal(credential: ChannelCredential, providerUserId: string): Promise<Result<ChannelPrincipal>>;

  /**
   * Confirm a credential is still live, without sending anything.
   *
   * Separate from `send` because the refresh fence needs to distinguish "this
   * token is dead" from "this message was bad", and a failed send cannot tell
   * them apart.
   */
  verifyCredential(credential: ChannelCredential): Promise<Result<void>>;
}

/**
 * The adapter for a provider, chosen at the composition root.
 *
 * A registry rather than a map so a use case's dependency list stays one entry
 * as providers are added, and so an unknown provider is a `Result` failure at
 * the call site rather than an `undefined` dereference.
 */
export interface ChannelAdapterRegistry {
  adapterFor(provider: string): Result<ChannelAdapter>;
}

/**
 * Where a decrypted channel credential comes from.
 *
 * `channels` is NOT the sole writer of `Credential` — `secrets` owns that row,
 * and the §1 DAG does not grant `channels` an edge to it. So the vault is
 * reached through this narrow reader port (reader-port inversion, ADR M0.3 §2)
 * and wired at the composition root, rather than by importing a context this
 * one is not allowed to see.
 */
export interface ChannelCredentialReader {
  read(credentialId: string, tokenGeneration: number): Promise<Result<ChannelCredential>>;
}

/**
 * The forged-id guard's port.
 *
 * Routing rules name agents, and a stored table must never point at an agent
 * outside the environment that owns the row. `channels` has no DAG edge to
 * `agents`, so the check travels through this reader port and is wired at the
 * composition root — the same inversion `tenancy` uses for `OperatorDirectory`.
 */
export interface AgentDirectory {
  /**
   * The subset of `agentIds` that exist inside `environmentId`. Returning the
   * FOUND set rather than a boolean lets the caller name exactly which ids were
   * rejected, which is the difference between a usable error and a shrug.
   */
  agentsInEnvironment(environmentId: string, agentIds: readonly string[]): Promise<Result<readonly string[]>>;
}

/**
 * Seals and opens an inbox payload.
 *
 * The provider body is encrypted BEFORE insertion and signatures and headers are
 * never persisted. The cipher itself is infrastructure, so it sits behind a port
 * and the domain only ever handles a `SealedEventPayload`.
 */
export interface ChannelEventCipher {
  seal(plaintext: string): Promise<Result<{ readonly formatVersion: number; readonly keyVersion: number; readonly ciphertext: string }>>;
  open(sealed: { readonly formatVersion: number; readonly keyVersion: number; readonly ciphertext: string }): Promise<Result<string>>;
}
