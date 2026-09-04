// The `Notifier` port — ADR M0.3 §13 assigns it to THIS context.
//
// It is published from `application/ports/` rather than from `contracts/` because
// it is ADAPTER-facing, not context-facing: `packages/adapters/notifier-email` and
// `packages/adapters/notifier-webhook` each have exactly one import edge, to this
// entrypoint, and no other context ever names it.
//
// THIS IS THE SEAM THAT KEEPS `cost-monitoring` OUT OF `channels`.
//
// ADR §1 row 13 spells it out: "alerts via `Notifier` (never imports channels)".
// The two are easy to confuse and must not be joined. `channels` is a
// conversational surface an END USER talks to, with threads, installations and
// inbound webhooks; this is a one-way operational alert an OPERATOR subscribed
// to. Routing budget alerts through `channels` would put a cost-monitoring
// dependency on the whole channel platform and give every alert an inbound
// surface it has no use for.
//
// THE ADAPTER RESOLVES THE CREDENTIAL, AND THAT IS WHY THE PORT LOOKS LIKE THIS.
//
// `secrets` is NOT on this context's ADR §1 row 13 allow-list, so a use case here
// cannot read material. A request therefore carries a `CredentialRef` — a NAME
// for a secret — and the adapter, which is wired at the composition root and does
// hold a vault grant, resolves it at dispatch. Two things follow and both are
// deliberate:
//
//   No secret ever enters this package, so no test double here can leak one and
//   no log line here can print one.
//
//   Resolution happens at DISPATCH, not at configuration time. A secret rotated
//   between the crossing and the send is used in its rotated form.
//
// THE ADAPTER ALSO RE-CHECKS THE DESTINATION. Whether a URL resolves to a
// private, loopback or metadata address is a property of the network at the
// instant of the call. The domain checks the string's shape; only the adapter can
// check the resolution, and only at the moment it dials. A name that resolved
// publicly at configuration time and privately at send time is the attack this
// split exists for.
//
// EVERY CALL RETURNS A `DeliveryOutcome`, NEVER A REJECTED PROMISE. A failed send
// is a durable business fact the ledger records, not an exception that aborts a
// dispatcher mid-batch and leaves the remaining recipients unreached.

import type { Result } from "@platos/kernel";

import type {
  BudgetAlert,
  ChannelKind,
  CredentialRef,
  DeliveryOutcome,
} from "../../domain/index.js";

/** Where one message is going, and what opens it. */
export type NotificationTarget =
  | { readonly kind: "EMAIL"; readonly email: string }
  | {
      readonly kind: "SLACK";
      readonly channelId: string;
      /** Null means the channel was configured without a token: undeliverable. */
      readonly credential: CredentialRef | null;
    }
  | {
      readonly kind: "WEBHOOK";
      readonly url: string;
      /** The signing secret. A webhook is never sent unsigned. */
      readonly credential: CredentialRef;
    };

/**
 * One message to send.
 *
 * `idempotencyKey` is the DELIVERY's id, and it is passed to the transport as
 * well as being the ledger's key. That is what lets a recipient that receives the
 * same alert twice — because a lease expired mid-flight and the row was re-sent —
 * recognise it as one alert rather than two.
 *
 * The alert travels as the DOMAIN value, not as pre-rendered text. Each transport
 * renders it with the one renderer in `domain/alert-message.ts`, so the plain-text
 * body and the structured document cannot state different numbers.
 */
export interface NotificationRequest {
  readonly target: NotificationTarget;
  readonly idempotencyKey: string;
  readonly alert: BudgetAlert;
}

/** A synthetic send an operator asked for, to prove a channel works. */
export interface NotificationProbe {
  readonly target: NotificationTarget;
  readonly idempotencyKey: string;
  readonly message: string;
  readonly channelName: string;
  readonly sentAt: Date;
}

export interface Notifier {
  /** Which transports this adapter serves. The root composes one per kind. */
  readonly kinds: readonly ChannelKind[];

  deliver(request: NotificationRequest): Promise<Result<DeliveryOutcome>>;

  /**
   * Send the operator's test message.
   *
   * A separate method, not a flag on `deliver`: a probe carries free text an
   * operator typed and no budget facts at all, and folding the two would make
   * every budget alert carry an optional operator string it must never render.
   */
  probe(request: NotificationProbe): Promise<Result<DeliveryOutcome>>;
}
