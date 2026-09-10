// The ONE `ChannelRuntime` implementation for Slack, and its constructor.
//
// WHAT THIS FILE REPLACED. Until WIN-271 it was the generated placeholder
// `scripts/arch/gen-v1-skeleton.mjs` emits: an interface extending the port,
// carrying the directory's own name, exporting no factory. A composition root
// cannot construct an interface, so `channel-slack` sat on
// `UNIMPLEMENTED_ADAPTERS` and `/readyz` told an operator, correctly, that the
// directory was work that had not happened. It has now happened, and rule (C7)
// is what makes the removal from that list honest rather than optimistic: it
// reads the list back and joins it to this directory's own source, so a
// directory that gained a `create*Adapter` and stayed on the list fails, and one
// dropped from the list without gaining one fails too.
//
// IT SATISFIES BOTH PORTS BECAUSE THERE IS ONE OBJECT. `ChannelRuntime` extends
// `ChannelAdapter`, so `channel-slack:ChannelAdapter` and
// `channel-slack:ChannelRuntime` are two obligations on one directory — stated
// as two in `PORT_SATISFACTION` for the reason `keyring-envelope`'s three are
// stated as three: a missing obligation is not a wrong one, and collapsing them
// would leave the compiler silent the day `verifyInbound` changed shape.
//
// IT HOLDS NO CREDENTIAL. The bot token arrives per call, as `ChannelAdapter`
// requires and for the reason it gives — a rotation takes effect on the next
// send rather than on the next process restart — and the app's signing secret
// arrives per call too, on the command. What this object holds is the process's
// TRANSPORT policy: where Slack is, how long a call may take, and which `fetch`
// to make it with.

import {
  adapterRejected,
  err,
  ok,
  type ChannelCredential,
  type ChannelPrincipal,
  type ChannelRuntime,
  type DeliveredMessage,
  type InboundVerificationSecret,
  type OutboundMessage,
  type Result,
  type SignedDelivery,
  type VerifiedDelivery,
} from "@platos/context-channels/application/ports/index.js";

import { classifySlackFailure } from "./failure.js";
import { normalizeSlackDelivery } from "./normalize.js";
import { SLACK_PROVIDER } from "./provider.js";
import { DEFAULT_SEND_TIMEOUT_MS, SLACK_API_URL, sendSlackMessage, type SlackTransportOptions } from "./send.js";
import { callSlackApi } from "./vendor.js";
import { DEFAULT_REQUEST_MAX_AGE_SECONDS, verifySlackDelivery } from "./verify.js";

export interface ChannelSlackAdapter extends ChannelRuntime {
  readonly adapterName: "channel-slack";
  readonly provider: typeof SLACK_PROVIDER;
}

export interface ChannelSlackOptions {
  /**
   * How old a signed request may be before it is refused as a replay.
   *
   * Defaults to five minutes. An install widens it deliberately through
   * `PLATOS_CHANNELS_SLACK_REQUEST_MAX_AGE_S`, because it is a trade against
   * clock skew rather than a constant.
   */
  readonly requestMaxAgeSeconds?: number;
  /** How long one outbound call may take before it is abandoned. */
  readonly timeoutMs?: number;
  /** Slack's API host. In-process only; see `send.ts`. */
  readonly apiUrl?: string;
  /** The `fetch` every outbound call is made with. In-process only. */
  readonly fetch?: typeof fetch;
}

class SlackRuntime implements ChannelSlackAdapter {
  readonly adapterName = "channel-slack" as const;
  readonly provider = SLACK_PROVIDER;

  constructor(
    private readonly transport: SlackTransportOptions,
    private readonly requestMaxAgeSeconds: number,
  ) {}

  async verifyInbound(
    secret: InboundVerificationSecret,
    delivery: SignedDelivery,
  ): Promise<Result<VerifiedDelivery>> {
    const verified = await verifySlackDelivery(secret.secret, delivery, this.requestMaxAgeSeconds);
    if (!verified.ok) return err(verified.error);
    // NORMALIZE THE BYTES THAT VERIFIED, not the ones on the delivery. They are
    // the same string today; keeping the dependency explicit is what stops a
    // later edit from parsing one thing and authenticating another.
    return normalizeSlackDelivery(delivery.rawBody, delivery.receivedAt);
  }

  async send(credential: ChannelCredential, message: OutboundMessage): Promise<Result<DeliveredMessage>> {
    return sendSlackMessage(this.transport, credential, message);
  }

  async describePrincipal(
    credential: ChannelCredential,
    providerUserId: string,
  ): Promise<Result<ChannelPrincipal>> {
    const called = await this.call("users.info", credential, { user: providerUserId });
    if (!called.ok) return err(called.error);
    const user = called.value["user"];
    if (typeof user !== "object" || user === null) {
      return err(adapterRejected(SLACK_PROVIDER, "users.info returned no user"));
    }
    const profile = (user as { readonly profile?: Record<string, unknown> }).profile ?? {};
    return ok({
      providerUserId,
      displayName: readString(user, "real_name") ?? readString(user, "name"),
      // NULL UNLESS THE PROVIDER BOTH KNOWS IT AND THE APP WAS GRANTED THE
      // SCOPE, exactly as `ChannelPrincipal` requires. Slack simply omits the
      // field when `users:read.email` was not granted, so absence is the answer
      // and not an error.
      email: readString(profile, "email"),
    });
  }

  async verifyCredential(credential: ChannelCredential): Promise<Result<void>> {
    const called = await this.call("auth.test", credential, {});
    return called.ok ? ok(undefined) : err(called.error);
  }

  /**
   * One vendor API call under the same deadline and the same classifier the
   * send path uses.
   *
   * Shared rather than duplicated because the two READ methods have the same
   * three failure modes as the write one, and a second `catch` would be a second
   * chance to decide that a timeout is retryable.
   */
  private async call(
    method: string,
    credential: ChannelCredential,
    body: Record<string, unknown>,
  ): Promise<Result<Record<string, unknown>>> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.transport.timeoutMs);
    try {
      const base = this.transport.fetch;
      const response = await callSlackApi(method, body, {
        token: credential.token,
        apiUrl: this.transport.apiUrl,
        fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          base(input, { ...init, signal: controller.signal })) as typeof fetch,
      });
      return ok(response as unknown as Record<string, unknown>);
    } catch (error) {
      return err(classifySlackFailure(error, timedOut));
    } finally {
      clearTimeout(timer);
    }
  }
}

function readString(source: Record<string, unknown> | object, key: string): string | null {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Build the adapter. Total over its options — there is nothing to parse and no
 * credential to validate, so there is no `Result` a construction failure could
 * arrive on.
 */
export function createChannelSlackAdapter(options: ChannelSlackOptions = {}): ChannelSlackAdapter {
  return new SlackRuntime(
    Object.freeze({
      apiUrl: options.apiUrl ?? SLACK_API_URL,
      timeoutMs: options.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
      // BOUND AT CONSTRUCTION, and bound to `globalThis`. An unbound `fetch`
      // reference throws "Illegal invocation" the moment it is called through a
      // property, and the failure would surface as an unclassifiable transport
      // error on every single outbound message.
      fetch: options.fetch ??
        (((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          globalThis.fetch(input, init)) as typeof fetch),
    }),
    options.requestMaxAgeSeconds ?? DEFAULT_REQUEST_MAX_AGE_SECONDS,
  );
}
