// The outbound half: one Graph call under a deadline, a rate-limit gate, and a
// classifier — and the two routes built on it.
//
// EVERY CALL HAS A DEADLINE for the reason `channel-slack/src/send.ts` gives at
// length: an unbounded post outlives the inbox lease it was made under, a second
// worker claims the row, and the message goes out twice. The deadline is an
// `AbortController` and a timer this module owns, cleared in a `finally`.
//
// THE ROUTES, from Meta's Cloud API reference (see `vendor.ts` for the pages):
//
//   send   POST <phone number id>/messages     the business's access token
//   probe  GET  me                             the token's own node
//
// AND THAT IS ALL OF THEM, WHICH IS ITSELF THE FINDING. There is no edit route
// and no profile route; `adapter.ts` records both among what this directory
// cannot do and why neither absence is worked around.
//
// `fetch` AND `graphUrl` ARE CONSTRUCTION OPTIONS AND NEVER CONFIGURATION, for
// the reason Slack's transport states: an operator-settable host for every
// outbound channel message is an exfiltration primitive.

import {
  adapterRejected,
  adapterUnavailable,
  err,
  ok,
  type DeliveredMessage,
  type Result,
} from "@platos/context-channels/application/ports/index.js";

import {
  classifyUnreadableAnswer,
  classifyWhatsAppStatus,
  classifyWhatsAppThrow,
  DEFAULT_RATE_LIMIT_WAIT_SECONDS,
  type WhatsAppOperation,
} from "./failure.js";
import { WHATSAPP_PROVIDER } from "./provider.js";
import { WhatsAppRateLimits, type WhatsAppLimitScope, type WhatsAppRoute } from "./rate-limit.js";
import {
  WHATSAPP_AUTHORIZATION_SCHEME,
  WHATSAPP_ERROR_CODE,
  WHATSAPP_MESSAGING_PRODUCT,
  WHATSAPP_PREVIEW_URL,
  WHATSAPP_RATE_LIMIT_CODES,
  WHATSAPP_TEXT_MESSAGE_TYPE,
} from "./vendor.js";

/** Ten seconds, matching `channel-slack`'s default and the webhook notifier's. */
export const DEFAULT_SEND_TIMEOUT_MS = 10_000;

export interface WhatsAppTransport {
  readonly graphUrl: string;
  readonly timeoutMs: number;
  readonly fetch: typeof fetch;
  readonly limits: WhatsAppRateLimits;
  readonly now: () => number;
}

/** One call, fully described before anything is sent. */
export interface WhatsAppCall {
  readonly method: "GET" | "POST";
  /** Relative to `graphUrl`, every id already validated. */
  readonly path: string;
  readonly token: string;
  readonly body: Readonly<Record<string, unknown>> | null;
  readonly operation: WhatsAppOperation;
  readonly route: WhatsAppRoute;
}

/** A Graph JSON object body, as it came back. */
export type WhatsAppAnswer = Readonly<Record<string, unknown>>;

export function bearerAuthorization(token: string): string {
  return `${WHATSAPP_AUTHORIZATION_SCHEME} ${token}`;
}

function objectOf(value: unknown): WhatsAppAnswer | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as WhatsAppAnswer) : null;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Meta's `{ error: { code, message, ... } }`, or null when there is no such shape. */
function errorCode(answer: WhatsAppAnswer | null): number | null {
  const error = objectOf(answer?.["error"]);
  const code = error?.["code"];
  return typeof code === "number" ? code : null;
}

/**
 * Which scope a refusal holds back. See `rate-limit.ts` for the three and why.
 * Null for a refusal that is not a throughput limit at all.
 */
export function limitScopeOf(status: number, metaCode: number | null): WhatsAppLimitScope | null {
  if (metaCode === WHATSAPP_ERROR_CODE.pairRateLimit) return "pair";
  if (metaCode === WHATSAPP_ERROR_CODE.rateLimitHit) return "line";
  if (metaCode !== null && WHATSAPP_RATE_LIMIT_CODES.has(metaCode)) return "credential";
  // A bare 429 that named no code: the widest scope, because an unattributed
  // refusal is the one case where holding too much is safer than holding too little.
  return status === 429 ? "credential" : null;
}

/**
 * How long a refusal asked the caller to wait, in seconds.
 *
 * `Retry-After` is read because a proxy or gateway in front of Graph may supply
 * one; Meta itself documents none, so with nothing there the wait is this
 * adapter's own constant and `failure.ts` says so by name.
 */
export function requestedWaitSeconds(header: (name: string) => string | null): number {
  const value = header("retry-after");
  if (value !== null && /^\d+(?:\.\d+)?$/u.test(value.trim())) return Math.max(1, Math.ceil(Number(value)));
  return DEFAULT_RATE_LIMIT_WAIT_SECONDS;
}

/**
 * Make one call. The rate-limit gate is consulted BEFORE the socket and fed AFTER
 * it; the deadline covers the whole exchange including reading the body, because
 * a server that sends headers and then stalls the body has not answered either.
 */
export async function whatsappCall(
  transport: WhatsAppTransport,
  call: WhatsAppCall,
): Promise<Result<WhatsAppAnswer>> {
  const gate = transport.limits.admit(call.route);
  if (!gate.admitted) {
    return err(
      adapterUnavailable(WHATSAPP_PROVIDER, `rate limited before sending: ${gate.reason}`, gate.retryAfterSeconds),
    );
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, transport.timeoutMs);
  try {
    const headers: Record<string, string> = { authorization: bearerAuthorization(call.token) };
    if (call.body !== null) headers["content-type"] = "application/json";
    const response = await transport.fetch(new URL(call.path, transport.graphUrl), {
      method: call.method,
      headers,
      body: call.body === null ? undefined : JSON.stringify(call.body),
      signal: controller.signal,
    });
    const answer = objectOf(await readJson(response));

    if (response.status < 200 || response.status > 299) {
      const metaCode = errorCode(answer);
      const wait = requestedWaitSeconds((name) => response.headers.get(name));
      const scope = limitScopeOf(response.status, metaCode);
      if (scope !== null) transport.limits.hold(call.route, scope, wait);
      return err(classifyWhatsAppStatus(response.status, metaCode, call.operation, wait));
    }
    if (answer === null) return err(classifyUnreadableAnswer(response.status, call.operation));
    // GRAPH CAN ANSWER 200 WITH AN ERROR BODY. A batched or partially applied
    // Graph call carries `{ error: { code } }` under a success status; treating
    // that as a delivered message would report a send that never happened.
    const code = errorCode(answer);
    if (code !== null) {
      const wait = requestedWaitSeconds((name) => response.headers.get(name));
      const scope = limitScopeOf(response.status, code);
      if (scope !== null) transport.limits.hold(call.route, scope, wait);
      return err(classifyWhatsAppStatus(response.status, code, call.operation, wait));
    }
    return ok(answer);
  } catch (error) {
    return err(classifyWhatsAppThrow(error, timedOut, call.operation));
  } finally {
    clearTimeout(timer);
  }
}

/** The JSON a text send carries. See `vendor.ts` for `preview_url`. */
export function textMessageBody(to: string, text: string): Readonly<Record<string, unknown>> {
  return {
    messaging_product: WHATSAPP_MESSAGING_PRODUCT,
    recipient_type: "individual",
    to,
    type: WHATSAPP_TEXT_MESSAGE_TYPE,
    text: { preview_url: WHATSAPP_PREVIEW_URL, body: text },
  };
}

/**
 * The sent message's id, and the instant this process read the answer.
 *
 * `deliveredAt` IS THIS PROCESS'S CLOCK, AND THAT IS A DEVIATION WORTH NAMING.
 * A Discord snowflake encodes the instant the far side minted it, so that
 * adapter reports the PROVIDER's time; Graph's send answer is
 * `{ messaging_product, contacts, messages: [ { id } ] }` and carries no
 * timestamp at all. So this is an upper bound on when the message was accepted,
 * measured here, and it is the honest available answer rather than a fabricated
 * provider time.
 */
export function deliveredFrom(answer: WhatsAppAnswer, at: number): Result<DeliveredMessage> {
  const messages = answer["messages"];
  const first = Array.isArray(messages) ? objectOf(messages[0]) : null;
  const id = first?.["id"];
  if (typeof id !== "string" || id === "") {
    // It answered 2xx and named no message. Whether a message exists is not
    // knowable from here, so this is the far side's defect reported as one.
    return err(adapterRejected(WHATSAPP_PROVIDER, "success answer carried no message id"));
  }
  return ok({ providerMessageId: id, deliveredAt: new Date(at) });
}
