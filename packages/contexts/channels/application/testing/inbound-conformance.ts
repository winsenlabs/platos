// The inbound-admission harness an ADAPTER's suite drives (WIN-271, M4.5).
//
// WHY IT IS PUBLISHED FROM HERE. `admitSignedDelivery` lives in
// `application/`, which this package's manifest does NOT publish — a context's
// use cases are reached through its contract and the composition root, not
// imported by name. But the one thing worth proving about that use case is that
// it is correct WITH A REAL RUNTIME BEHIND THE PORT, and a real runtime lives in
// an adapter package that this context may not import (ADR M0.3 §2). Neither
// side can reach the other, and testing the use case against an in-memory
// runtime told to accept would prove only that it was told to.
//
// So the seam runs the other way, the way `postgres-tenancy` already drives this
// context's repository conformance: the CONTEXT publishes a harness from its
// testing entry point, and the ADAPTER supplies the real runtime and its own
// provider fixtures. The use-case import stays inside this package; the
// cryptography stays inside the adapter; and the join happens in the adapter's
// suite, where both are legitimately in scope.
//
// IT ASSERTS NOTHING. It returns a REPORT and lets the caller assert, so this
// package publishes no test framework and an adapter's suite keeps its failures
// where a reader can see them. A harness that asserted would also have to decide
// what "correct" means for every provider, and the whole point is that a
// provider's fixtures are the provider's.

import type { ChannelAppId } from "../../domain/index.js";
import { admitSignedDelivery, type SignedDeliveryOutcome } from "../admit-signed-delivery.js";
import type { ChannelsDependencies } from "../dependencies.js";
import type { InboundVerificationSecret, SignedDelivery } from "../ports/index.js";

/** What one delivery did, flattened so a suite can assert on it in one line. */
export interface InboundAdmissionReport {
  /** `null` when the delivery was accepted. */
  readonly refusedWith: string | null;
  /** `null` when the delivery was refused. */
  readonly outcome: SignedDeliveryOutcome["kind"] | null;
  /** The inbox row's id, for an admitted delivery. Null otherwise. */
  readonly inboxId: string | null;
  /** True when this delivery duplicated one already admitted. */
  readonly duplicate: boolean;
  /** What the transport must echo, for a handshake. Null otherwise. */
  readonly echo: string | null;
}

export interface InboundHarnessOptions {
  readonly dependencies: ChannelsDependencies;
  readonly appId: ChannelAppId;
  readonly secret: InboundVerificationSecret;
}

/**
 * Drive `admitSignedDelivery` for one app, against whatever runtime the
 * dependencies were built with.
 *
 * The app and the secret are fixed at construction because they are properties
 * of the INSTALL rather than of a delivery, and a harness that took them per
 * call would let a suite accidentally prove a redelivery is deduplicated by
 * sending it to a different app.
 */
export function inboundHarness(options: InboundHarnessOptions) {
  return {
    async admit(delivery: SignedDelivery): Promise<InboundAdmissionReport> {
      const result = await admitSignedDelivery(options.dependencies, {
        appId: options.appId,
        delivery,
        secret: options.secret,
      });
      if (!result.ok) {
        return Object.freeze({
          refusedWith: result.error.code,
          outcome: null,
          inboxId: null,
          duplicate: false,
          echo: null,
        });
      }
      const outcome = result.value;
      return Object.freeze({
        refusedWith: null,
        outcome: outcome.kind,
        inboxId: outcome.kind === "admitted" ? outcome.event.inboxId : null,
        duplicate: outcome.kind === "admitted" ? outcome.duplicate : false,
        echo: outcome.kind === "handshake" ? outcome.echo : null,
      });
    },
  };
}
