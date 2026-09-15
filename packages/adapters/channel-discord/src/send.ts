// The outbound half: one REST call under a deadline, a rate-limit gate, and a
// classifier — and the four Discord routes built on it.
//
// EVERY CALL HAS A DEADLINE for the reason `channel-slack/src/send.ts` gives at
// length: an unbounded post outlives the inbox lease it was made under, a second
// worker claims the row, and the message goes out twice. The deadline is an
// `AbortController` and a timer this module owns, cleared in a `finally`.
//
// THE ROUTES, from `discord/discord-api-docs` (see `vendor.ts` for the commit):
//
//   create   POST  channels/{channel}/messages                bot token
//   edit     PATCH channels/{channel}/messages/{message}      bot token
//   followup POST  webhooks/{application}/{token}?wait=true   interaction token
//   refollow PATCH webhooks/{application}/{token}/messages/{message | @original}
//   read     GET   users/{user}, users/@me                     bot token
//
// A FOLLOWUP PRESENTS NO BOT TOKEN. The interaction token in the path IS the
// authorization ("Interaction tokens are valid for 15 minutes"), and sending the
// bot token beside it would hand a credential to an endpoint that does not ask
// for one.
//
// `fetch` AND `apiUrl` ARE CONSTRUCTION OPTIONS AND NEVER CONFIGURATION, for the
// reason Slack's transport states: an operator-settable host for every outbound
// channel message is an exfiltration primitive.

import {
  err,
  ok,
  adapterRejected,
  adapterUnavailable,
  type DeliveredMessage,
  type Result,
} from "@platos/context-channels/application/ports/index.js";

import {
  classifyDiscordStatus,
  classifyDiscordThrow,
  classifyUnreadableAnswer,
  type DiscordOperation,
} from "./failure.js";
import { DISCORD_PROVIDER, isSnowflake } from "./provider.js";
import {
  DiscordRateLimits,
  requestedWaitSeconds,
  type ObservedResponse,
  type RateLimitRoute,
} from "./rate-limit.js";
import {
  DISCORD_BOT_AUTHORIZATION_SCHEME,
  DISCORD_EPOCH_MS,
  DISCORD_NO_MENTIONS,
  DISCORD_USER_AGENT,
} from "./vendor.js";

/** Ten seconds, matching `channel-slack`'s default and the webhook notifier's. */
export const DEFAULT_SEND_TIMEOUT_MS = 10_000;

export interface DiscordTransport {
  readonly apiUrl: string;
  readonly timeoutMs: number;
  readonly fetch: typeof fetch;
  readonly limits: DiscordRateLimits;
}

/** One call, fully described before anything is sent. */
export interface DiscordCall {
  readonly method: "GET" | "POST" | "PATCH";
  /** Relative to `apiUrl`, every id already validated. */
  readonly path: string;
  /** `Bot <token>`, or null for an interaction webhook route. */
  readonly authorization: string | null;
  readonly body: Readonly<Record<string, unknown>> | null;
  readonly operation: DiscordOperation;
  readonly route: RateLimitRoute;
}

/** A Discord JSON object body, as it came back. */
export type DiscordAnswer = Readonly<Record<string, unknown>>;

export function botAuthorization(token: string): string {
  return `${DISCORD_BOT_AUTHORIZATION_SCHEME} ${token}`;
}

/** An interaction token is URL-safe base64-ish; anything else is not one. */
export function isInteractionToken(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,500}$/u.test(value);
}

function headerReader(response: Response): (name: string) => string | null {
  return (name) => response.headers.get(name);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function objectOf(value: unknown): DiscordAnswer | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as DiscordAnswer) : null;
}

/**
 * Make one call. The rate-limit gate is consulted BEFORE the socket and fed AFTER
 * it; the deadline covers the whole exchange including reading the body, because
 * a server that sends headers and then stalls the body has not answered either.
 */
export async function discordCall(transport: DiscordTransport, call: DiscordCall): Promise<Result<DiscordAnswer>> {
  const gate = transport.limits.admit(call.route);
  if (!gate.admitted) {
    return err(adapterUnavailable(DISCORD_PROVIDER, `rate limited before sending: ${gate.reason}`, gate.retryAfterSeconds));
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, transport.timeoutMs);
  try {
    const headers: Record<string, string> = { "user-agent": DISCORD_USER_AGENT };
    if (call.authorization !== null) headers["authorization"] = call.authorization;
    if (call.body !== null) headers["content-type"] = "application/json";
    const response = await transport.fetch(new URL(call.path, transport.apiUrl), {
      method: call.method,
      headers,
      body: call.body === null ? undefined : JSON.stringify(call.body),
      signal: controller.signal,
    });
    const parsed = await readJson(response);
    const answer = objectOf(parsed);
    const observed: ObservedResponse = {
      status: response.status,
      header: headerReader(response),
      retryAfter: typeof answer?.["retry_after"] === "number" ? answer["retry_after"] : null,
      global: answer?.["global"] === true,
    };
    transport.limits.observe(call.route, observed);

    if (response.status < 200 || response.status > 299) {
      const discordCode = typeof answer?.["code"] === "number" ? answer["code"] : null;
      const wait = Math.max(1, Math.ceil(requestedWaitSeconds(observed)));
      return err(classifyDiscordStatus(response.status, discordCode, call.operation, wait));
    }
    if (answer === null) return err(classifyUnreadableAnswer(response.status, call.operation));
    return ok(answer);
  } catch (error) {
    return err(classifyDiscordThrow(error, timedOut, call.operation));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The instant a snowflake was minted, per `developers/reference.mdx`:
 * `(snowflake >> 22) + 1420070400000`. It is the provider's own creation time for
 * the message, which is what `deliveredAt` means — not this process's clock.
 */
export function snowflakeInstant(snowflake: string): Date {
  return new Date(Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH_MS));
}

/** A created or edited message's id and instant, or a REJECTED for a body without one. */
export function deliveredFrom(answer: DiscordAnswer): Result<DeliveredMessage> {
  const id = answer["id"];
  if (!isSnowflake(id)) {
    // It answered 2xx and named no message. Whether a message exists is not
    // knowable from here, so this is the far side's defect reported as one.
    return err(adapterRejected(DISCORD_PROVIDER, "success answer carried no message id"));
  }
  return ok({ providerMessageId: id, deliveredAt: snowflakeInstant(id) });
}

/** The JSON every write sends: the text, and no mention parsing. */
export function messageBody(text: string): Readonly<Record<string, unknown>> {
  return { content: text, allowed_mentions: DISCORD_NO_MENTIONS };
}
