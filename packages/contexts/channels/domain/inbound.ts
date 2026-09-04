// The inbound message, and the turn job it becomes.
//
// THIS MODULE IS THE REVERSE-EDGE INVERSION, IN THE DOMAIN. ADR M0.3 §3 forbids
// `channels` from importing `conversations` in either direction: inbound writes
// `ChannelEventInbox` and ENQUEUES A TURN JOB through the kernel's
// `DurableRuntime`; outbound SUBSCRIBES to an event. So the thing this context
// hands to the runtime is a plain, versioned JSON payload named by a
// Platos-owned job name — not a call, not an imported command type.
//
// That is why `InboundTurnJobPayload` extends `JsonValue`-compatible shapes and
// carries no branded types at its edges once serialized: it crosses a durable
// boundary, may be decoded by a binary built months later, and M0.4 §2 fixes
// that an in-flight job decodes at the payload version it was ENQUEUED with.
// A payload that could only be understood by importing this package would make
// that guarantee unimplementable.

import type { AgentId, ChannelEventInboxId, ChannelThreadKey, EndUserId, ThreadId } from "./identifiers.js";

/**
 * The Platos-owned job name. Never a vendor task identifier (ADR M0.3 §4).
 * Renaming it strands every in-flight job, so it is fixed here, once.
 */
export const INBOUND_TURN_JOB_NAME = "channels.inbound-turn";

/**
 * Payload schema version, frozen for the life of this job name (M0.4 §2). Bump
 * it only alongside a decoder that still understands version 1.
 */
export const INBOUND_TURN_PAYLOAD_VERSION = 1;

/** One message as the adapter rendered it, before any routing decision. */
export interface InboundMessage {
  readonly channelThreadKey: ChannelThreadKey;
  /** The platform channel/group id, when the provider exposes one. */
  readonly platformChannelId: string | null;
  readonly text: string;
  /** The provider-side author, mapped to a Platos end user when one is linked. */
  readonly endUserId: EndUserId | null;
  readonly receivedAt: Date;
}

/**
 * What the turn job carries. Flat, string-keyed and JSON-safe by construction.
 *
 * It names the INBOX ROW rather than embedding the payload: the event body is
 * encrypted at rest and must not be copied in cleartext into a job queue, and
 * naming the row keeps the inbox the single source of truth for what was
 * delivered.
 */
export interface InboundTurnJobPayload {
  readonly inboxId: string;
  readonly threadId: string;
  /**
   * The routing decision — present ONLY on first contact.
   *
   * Null means "this conversation already has a thread, so run on the agent
   * that thread is already pinned to". `conversations` owns `Thread.agentId`
   * and this context may not read it, so null is how the absence of a decision
   * is expressed rather than a guess this context is not entitled to make.
   */
  readonly agentId: string | null;
  readonly channelThreadKey: string;
  readonly endUserId: string | null;
  readonly text: string;
  readonly [key: string]: string | null;
}

export interface BuildInboundTurnJobInput {
  readonly inboxId: ChannelEventInboxId;
  readonly threadId: ThreadId;
  /** Null for an existing conversation. See {@link InboundTurnJobPayload}. */
  readonly agentId: AgentId | null;
  readonly message: InboundMessage;
}

export function buildInboundTurnPayload(input: BuildInboundTurnJobInput): InboundTurnJobPayload {
  return Object.freeze({
    inboxId: input.inboxId,
    threadId: input.threadId,
    agentId: input.agentId,
    channelThreadKey: input.message.channelThreadKey,
    endUserId: input.message.endUserId,
    text: input.message.text,
  });
}

/**
 * The idempotency key for the turn job.
 *
 * Computed over the INBOX ROW ID alone — a version-stable subset of the input,
 * never the whole body, as the kernel's `JobRequest` requires. The inbox id is
 * already unique per provider event, so a redelivery that finds the row and
 * re-dispatches produces the same key and therefore the same job, rather than a
 * second turn for one message.
 */
export function inboundTurnIdempotencyKey(inboxId: ChannelEventInboxId): string {
  return `${INBOUND_TURN_JOB_NAME}:${inboxId}`;
}

/**
 * The platform channel id encoded in a composite thread key.
 *
 * Keys are rendered by the adapter as `<kind>:<channel>[:<thread>]`, so the
 * channel is the second segment. Returns null rather than throwing for a key
 * with no second segment: a `channel` routing rule then simply does not match,
 * which is the correct outcome for a provider that does not expose one.
 */
export function extractPlatformChannelId(channelThreadKey: string): string | null {
  const parts = channelThreadKey.split(":");
  const channel = parts[1];
  return channel !== undefined && channel !== "" ? channel : null;
}
