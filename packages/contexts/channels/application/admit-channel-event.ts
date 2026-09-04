// Use case: admit one verified provider event into the durable inbox.
//
// THE ENTRY POINT OF THE WHOLE INBOUND PATH, and the only place a provider
// delivery becomes durable. Everything after this reads the inbox.
//
// ADMISSION IS IDEMPOTENT, AND RETURNS SUCCESS ON A REPEAT. Providers retry
// deliveries they did not see acknowledged, so a redelivery is normal operation
// rather than an error. Returning the EXISTING row (with `admitted: false`)
// rather than failing is what lets a webhook transport answer 2xx to a
// redelivery — which is the only thing that makes the provider stop retrying.
// Failing would keep the retry loop alive forever on a duplicate this system has
// already handled correctly.
//
// THE PAYLOAD IS SEALED BEFORE IT IS STORED. The provider body may contain
// message text, so it is encrypted through `ChannelEventCipher` before the row
// is written and never persisted in cleartext. Request signatures and headers
// are not persisted at all: they authenticate one delivery and have no use after
// verification, and keeping them would be a standing credential in a table.
//
// SIGNATURE VERIFICATION IS NOT HERE. It happens in the transport, against the
// raw bytes, before this is called — a body that has been parsed into an object
// can no longer be verified, so verification cannot live behind a use case that
// takes a parsed command.

import { err, ok, type Result } from "@platos/kernel";

import {
  admitEvent,
  type ChannelAppId,
  type ChannelEvent,
  type ChannelEventInboxId,
  type ProviderEventId,
} from "../domain/index.js";
import type { ChannelsDependencies } from "./dependencies.js";

export interface AdmitChannelEventCommand {
  readonly appId: ChannelAppId;
  /** The provider's own event id — the idempotency key. */
  readonly eventId: ProviderEventId;
  /** The raw provider body, already signature-verified by the transport. */
  readonly body: string;
}

export interface AdmittedChannelEvent {
  readonly event: ChannelEvent;
  /** False when this delivery was a duplicate of one already admitted. */
  readonly admitted: boolean;
}

type Dependencies = Pick<
  ChannelsDependencies,
  "repository" | "cipher" | "clock" | "ids" | "unitOfWork"
>;

/**
 * The duplicate probe runs BEFORE the seal.
 *
 * Sealing is the expensive half and a redelivery is common, so probing first
 * keeps the hot path cheap. It is not a correctness mechanism — two concurrent
 * first-deliveries can both pass it — which is why `insertEvent` still fails on
 * the `[appId, eventId]` unique and that failure is handled below.
 */
async function findExisting(
  dependencies: Dependencies,
  command: AdmitChannelEventCommand,
): Promise<Result<ChannelEvent | null>> {
  return dependencies.repository.findEventByProviderId(command.appId, command.eventId);
}

export async function admitChannelEvent(
  dependencies: Dependencies,
  command: AdmitChannelEventCommand,
): Promise<Result<AdmittedChannelEvent>> {
  const existing = await findExisting(dependencies, command);
  if (!existing.ok) return err(existing.error);
  if (existing.value !== null) return ok({ event: existing.value, admitted: false });

  const sealed = await dependencies.cipher.seal(command.body);
  if (!sealed.ok) return err(sealed.error);

  const event = admitEvent({
    inboxId: dependencies.ids.uuid() as unknown as ChannelEventInboxId,
    appId: command.appId,
    eventId: command.eventId,
    payload: sealed.value,
    now: dependencies.clock.now(),
  });

  const inserted = await dependencies.unitOfWork.run((transaction) =>
    dependencies.repository.insertEvent(event, transaction),
  );

  // The unique lost a race. The winner's row is the truth, and this delivery is
  // a duplicate of it — the same answer the fast probe would have given had it
  // run a moment later.
  if (!inserted.ok) {
    const raced = await findExisting(dependencies, command);
    if (raced.ok && raced.value !== null) return ok({ event: raced.value, admitted: false });
    return err(inserted.error);
  }

  return ok({ event: inserted.value, admitted: true });
}
