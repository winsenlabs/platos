// Use case: deliver an assistant message back into the channel it came from.
//
// THE OTHER HALF OF THE ADR M0.3 §3 INVERSION. The row reads: "channels
// SUBSCRIBES to the `OutboundAssistantMessage`/`TurnMessage` event." So this
// context learns that a turn produced text by receiving an EVENT off the kernel
// bus — never by importing `conversations`, and never by `conversations`
// importing this.
//
// THE EVENT IS PARSED DEFENSIVELY, AND THAT IS NOT PARANOIA. A `DomainEvent`
// arrives as an opaque `JsonValue` payload, minted by a context this one cannot
// see, possibly by an older binary (M0.4 §1.1: readers ignore unknown fields and
// unknown event names). Trusting its shape would be reaching across the boundary
// the event exists to create. A payload this binary cannot read is DROPPED with
// a log line rather than throwing, because throwing inside a bus handler
// poisons the subscription for every other tenant's messages too.
//
// HANDLERS MUST BE IDEMPOTENT — the kernel's `EventBus` says so explicitly:
// delivery is at-least-once and a redelivery after a partial failure is normal.
// The provider offers no idempotency for posting a message, so the guard is
// `replacesProviderMessageId`: a streaming turn EDITS one message rather than
// posting a flood, and a redelivered edit is harmless.

import type { DomainEvent, EnvironmentScope, JsonValue, Result, Unsubscribe } from "@platos/kernel";
import { err } from "@platos/kernel";

import {
  adapterRejected,
  admitChannelThreadKey,
  connectionNotFound,
  type ChannelConnectionId,
  type ChannelThreadKey,
} from "../domain/index.js";
import type { DeliveredMessage } from "./ports/index.js";
import type { ChannelsDependencies } from "./dependencies.js";

/**
 * The event names this context subscribes to (ADR M0.3 §3).
 *
 * Both, not one: `TurnMessage` carries incremental text while a turn streams
 * and `OutboundAssistantMessage` carries the settled result. A channel that
 * subscribed only to the final message would show nothing until the turn ended.
 */
export const OUTBOUND_EVENT_NAMES = Object.freeze([
  "conversations.outbound-assistant-message",
  "conversations.turn-message",
] as const);

/** What this context needs off an outbound event. Everything else is ignored. */
export interface OutboundMessageEvent {
  readonly connectionId: string;
  readonly channelThreadKey: ChannelThreadKey;
  readonly text: string;
  readonly replacesProviderMessageId: string | null;
}

type Dependencies = Pick<
  ChannelsDependencies,
  "repository" | "adapters" | "credentials" | "eventBus" | "logger"
>;

function readString(payload: Record<string, JsonValue>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Read an untrusted event payload into this context's shape.
 *
 * Returns null rather than a `Result` because an unreadable event is not a
 * failure to report to anybody — there is no caller to report it to — it is an
 * event this binary does not understand and must ignore.
 */
export function parseOutboundEvent(event: DomainEvent): OutboundMessageEvent | null {
  const payload = event.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;

  const connectionId = readString(payload, "connectionId");
  const rawKey = readString(payload, "channelThreadKey");
  if (connectionId === null || rawKey === null) return null;

  const key = admitChannelThreadKey(rawKey);
  if (!key.ok) return null;

  const text = payload["text"];
  if (typeof text !== "string") return null;

  return {
    connectionId,
    channelThreadKey: key.value,
    text,
    replacesProviderMessageId: readString(payload, "replacesProviderMessageId"),
  };
}

export async function deliverOutboundMessage(
  dependencies: Dependencies,
  scope: EnvironmentScope,
  message: OutboundMessageEvent,
): Promise<Result<DeliveredMessage>> {
  const found = await dependencies.repository.findConnection(scope, message.connectionId as ChannelConnectionId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(connectionNotFound(message.connectionId));

  const connection = found.value;
  if (connection.credentialId === null) {
    return err(adapterRejected(connection.provider, "connection has no credential"));
  }

  const adapter = dependencies.adapters.adapterFor(connection.provider);
  if (!adapter.ok) return err(adapter.error);

  const credential = await dependencies.credentials.read(connection.credentialId, 0);
  if (!credential.ok) return err(credential.error);

  return adapter.value.send(credential.value, {
    channelThreadKey: message.channelThreadKey,
    text: message.text,
    replacesProviderMessageId: message.replacesProviderMessageId,
  });
}

/**
 * Wire the subscription. Called once, at the composition root.
 *
 * A handler that rejects would make the bus retry the whole delivery, so a
 * failure is logged and swallowed here. That is the correct trade for a
 * best-effort outbound surface: the turn already happened and its record is in
 * the inbox, and a channel post that cannot be made is not worth stalling every
 * other subscriber for.
 */
export function subscribeOutboundMessages(dependencies: Dependencies, scope: EnvironmentScope): Unsubscribe {
  const unsubscribes = OUTBOUND_EVENT_NAMES.map((name) =>
    dependencies.eventBus.subscribe(name, async (event) => {
      const parsed = parseOutboundEvent(event);
      if (parsed === null) {
        dependencies.logger.log("debug", "channels: ignoring unreadable outbound event", { name: event.name });
        return;
      }
      const delivered = await deliverOutboundMessage(dependencies, scope, parsed);
      if (!delivered.ok) {
        dependencies.logger.log("warn", "channels: outbound delivery failed", {
          code: delivered.error.code,
          connectionId: parsed.connectionId,
        });
      }
    }),
  );
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

