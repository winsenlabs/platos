// Use case: take one UNTRUSTED inbound HTTP delivery and turn it into an inbox
// row — or refuse it (WIN-271, M4.5).
//
// THIS IS THE SEAM THAT MOVED. Until this file, `admitChannelEvent` took a body
// that was "already signature-verified by the transport" and its own header said
// so. That put the single security decision protecting a public endpoint outside
// the context that owns channels, where it was implemented twice — once by hand
// in a controller and once by delegating to a vendor SDK inside a service. This
// use case takes the RAW BYTES instead, so verification happens exactly once,
// inside the boundary, behind `ChannelRuntime`.
//
// THE ORDER OF THE FOUR STEPS IS LOAD-BEARING.
//
//   1. RESOLVE THE APP FIRST, because the app names the PROVIDER and no adapter
//      can be chosen without it. It is also the only step that touches the
//      store, so a delivery for an app that does not exist costs one indexed
//      lookup and no cryptography.
//   2. VERIFY BEFORE PARSING. The signature covers the exact received octets. A
//      body parsed into an object can no longer be verified, so nothing may read
//      the body before this step — including to decide whether it is worth
//      verifying.
//   3. ANSWER A HANDSHAKE WITHOUT ADMITTING IT. A provider's endpoint challenge
//      carries no event and must not become an inbox row; it must be echoed
//      back verbatim or the provider marks the endpoint dead.
//   4. ADMIT ONLY A MESSAGE, through `admitChannelEvent`, which is idempotent on
//      `[appId, eventId]`. A redelivery of a verified message therefore comes
//      back `admitted: false` and the transport still answers 2xx — which is the
//      only thing that makes a provider stop retrying.
//
// AN IGNORABLE DELIVERY IS ACKNOWLEDGED AND DROPPED. It verified, so it really
// came from the provider; this build simply has no behaviour for it. Admitting
// it would fill the inbox with rows no turn will ever run and would make the
// retry cap meaningless. Refusing it would make the provider retry a delivery
// that is not going to be handled on the tenth try either.

import { err, ok, type Result } from "@platos/kernel";

import {
  appNotFound,
  eventPayloadInvalid,
  type ChannelAppId,
  type ChannelEvent,
} from "../domain/index.js";
import type { ChannelsDependencies } from "./dependencies.js";
import type { InboundVerificationSecret, SignedDelivery } from "./ports/index.js";
import { admitChannelEvent } from "./admit-channel-event.js";

export interface AdmitSignedDeliveryCommand {
  readonly appId: ChannelAppId;
  readonly delivery: SignedDelivery;
  /**
   * The material this delivery is authenticated against.
   *
   * ON THE COMMAND, AND NOT READ FROM THE APP ROW. Two reasons, and the first is
   * simply that there is no such column: `ChannelApp` carries ONE nullable
   * `credentialId`, which is the app's OAuth client secret, and a signing secret
   * is a different secret with a different rotation story. The second is the
   * design already in the tree — `apps/core-api/src/config/channels.ts` anchors
   * the whole channels section on `PLATOS_CHANNELS_SLACK_SIGNING_SECRET` and
   * says why: "This section holds the APP's identity, which is one per
   * deployable; not the INSTALLATIONS', which are one per customer."
   *
   * So it arrives the same way `EnvironmentScope` arrives on every other command
   * in this context: established by the layer that owns it and handed in, rather
   * than re-derived here. A hosted multi-app build that stores a secret per app
   * fills the same slot from a row and no signature in this file moves.
   */
  readonly secret: InboundVerificationSecret;
}

/**
 * What the transport must do next. A DISCRIMINATED UNION and not a nullable
 * pair, because the three outcomes need three different HTTP responses and a
 * transport that had to reconstruct which one it was holding would get it wrong.
 */
export type SignedDeliveryOutcome =
  | { readonly kind: "admitted"; readonly event: ChannelEvent; readonly duplicate: boolean }
  | { readonly kind: "handshake"; readonly echo: string }
  | { readonly kind: "ignored"; readonly reason: string };

type Dependencies = Pick<
  ChannelsDependencies,
  "repository" | "runtimes" | "cipher" | "clock" | "ids" | "unitOfWork"
>;

export async function admitSignedDelivery(
  dependencies: Dependencies,
  command: AdmitSignedDeliveryCommand,
): Promise<Result<SignedDeliveryOutcome>> {
  const found = await dependencies.repository.findAppById(command.appId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(appNotFound(command.appId));
  const app = found.value;

  const runtime = dependencies.runtimes.runtimeFor(app.provider);
  if (!runtime.ok) return err(runtime.error);

  const verified = await runtime.value.verifyInbound(command.secret, command.delivery);
  if (!verified.ok) return err(verified.error);

  const delivery = verified.value;

  if (delivery.kind === "handshake") {
    // `handshakeEcho` is non-null exactly when `kind` is `"handshake"` — the
    // port says so — but the union is structural, so an adapter that returned
    // the pair inconsistently would otherwise put `null` in a response body and
    // silently kill the endpoint. Checked rather than asserted.
    if (delivery.handshakeEcho === null) {
      return err(eventPayloadInvalid("adapter reported a handshake with nothing to echo"));
    }
    return ok({ kind: "handshake", echo: delivery.handshakeEcho });
  }

  if (delivery.kind === "ignorable") {
    return ok({ kind: "ignored", reason: "verified delivery has no behaviour in this build" });
  }

  if (delivery.providerEventId === null) {
    return err(eventPayloadInvalid("adapter reported a message with no provider event id"));
  }

  const admitted = await admitChannelEvent(dependencies, {
    appId: command.appId,
    eventId: delivery.providerEventId,
    // THE VERIFIED BYTES, not the ones on the command. Two reads of "the body"
    // are two chances for what is stored to differ from what was authenticated.
    body: delivery.verifiedBody,
  });
  if (!admitted.ok) return err(admitted.error);

  return ok({
    kind: "admitted",
    event: admitted.value.event,
    duplicate: !admitted.value.admitted,
  });
}
