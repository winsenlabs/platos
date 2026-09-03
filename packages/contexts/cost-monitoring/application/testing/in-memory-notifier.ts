// In-memory `Notifier` implementations.
//
// TWO OF THEM, NOT ONE, and the reason is the port's own shape: `Notifier` is one
// interface with several adapters, resolved by kind. A single double that claimed
// every kind would never exercise `notifierFor`, and the case a real installation
// hits first — a channel whose transport was not composed at the root — would be
// untestable here and a runtime surprise there.
//
// NEITHER ONE HOLDS A SECRET. They receive a `CredentialRef` and record that they
// were given one; resolving it is the real adapter's job, and a double that
// resolved one would have to hold material this package is not allowed to see.

import { err, ok, type Result } from "@platos/kernel";

import {
  delivered,
  notDelivered,
  repositoryUnavailable,
  type ChannelKind,
  type DeliveryOutcome,
} from "../../domain/index.js";
import type { Notifier, NotificationProbe, NotificationRequest } from "../ports/index.js";

/** One recorded send, with only what a double may legitimately observe. */
export interface RecordedSend {
  readonly kind: ChannelKind;
  readonly idempotencyKey: string;
  /** Whether a credential reference travelled. Never its value. */
  readonly usedCredential: boolean;
  readonly threshold: number | null;
  readonly text: string;
}

/**
 * A notifier that succeeds, or fails on command.
 *
 * `failFor` is keyed by idempotency key rather than by channel, so a test can
 * make ONE recipient of a fan-out fail and watch the others still be attended
 * to — which is the property that stops a single bad channel from blocking every
 * alert behind it.
 */
export class InMemoryNotifier implements Notifier {
  readonly sends: RecordedSend[] = [];
  readonly probes: RecordedSend[] = [];
  readonly failFor = new Set<string>();
  /** Set to have this notifier return an ERROR rather than a failed outcome. */
  raiseFor = new Set<string>();
  private nextStatusCode: number | null = 200;

  constructor(readonly kinds: readonly ChannelKind[]) {}

  /** What the next successful send reports as its status code. */
  respondWith(statusCode: number | null): void {
    this.nextStatusCode = statusCode;
  }

  async deliver(request: NotificationRequest): Promise<Result<DeliveryOutcome>> {
    this.sends.push({
      kind: request.target.kind,
      idempotencyKey: request.idempotencyKey,
      usedCredential: request.target.kind !== "EMAIL" && request.target.credential !== null,
      threshold: request.alert.threshold,
      text: request.alert.subjectLabel,
    });
    if (this.raiseFor.has(request.idempotencyKey)) {
      return err(repositoryUnavailable("notifier raised"));
    }
    if (this.failFor.has(request.idempotencyKey)) {
      return ok(notDelivered("transport_error", "the transport refused", 502));
    }
    return ok(delivered(this.nextStatusCode));
  }

  async probe(request: NotificationProbe): Promise<Result<DeliveryOutcome>> {
    this.probes.push({
      kind: request.target.kind,
      idempotencyKey: request.idempotencyKey,
      usedCredential: request.target.kind !== "EMAIL" && request.target.credential !== null,
      threshold: null,
      text: request.message,
    });
    if (this.failFor.has(request.idempotencyKey)) {
      return ok(notDelivered("transport_error", "the transport refused", 502));
    }
    return ok(delivered(this.nextStatusCode));
  }
}

/** The three transports, each on its own notifier, as a root would compose them. */
export function allNotifiers(): readonly InMemoryNotifier[] {
  return [
    new InMemoryNotifier(["EMAIL"]),
    new InMemoryNotifier(["SLACK"]),
    new InMemoryNotifier(["WEBHOOK"]),
  ];
}
