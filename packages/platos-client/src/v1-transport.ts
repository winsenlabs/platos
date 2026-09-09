// THE HAND-WRITTEN HALF OF THE V1 CLIENT: AUTH, RETRY, AND THE ONE RULE A
// RETRYING CLIENT MUST NOT GET WRONG.
//
// WIN-270 (M4.4). `src/generated/v1.ts` decides the method, the path, the body
// and — read off core-api's own policy table — whether the operation is bound to
// an `Idempotency-Key`. It is emitted and cannot drift. This file decides the
// three things a generator has no business deciding, and each is here because
// getting it wrong has a name:
//
//   A MINT THAT RETRIES WITHOUT A KEY MINTS TWICE.
//   ADR M0.4 section 2 requires `Idempotency-Key` on the one-time-secret mints,
//   and the reason is a retry: the first try hands back a credential nobody
//   ever sees again, the socket drops before the response lands, and the client
//   tries again. With a STABLE key the server replays the first answer and the
//   caller recovers the secret it already created. With a FRESH key per try
//   — or with none — it creates a second live credential nobody knows about.
//   So the key is minted ONCE PER LOGICAL CALL, before the first try, and
//   every retry of that call carries the same value. `_fetchWithRetry` in
//   `client.ts` predates this rule and reaches no mint; nothing here is routed
//   through it.
//
//   A REFUSAL IS A CODE, NOT A SENTENCE.
//   Every non-2xx answer from the V1 surface is ADR M0.4 section 2's envelope:
//   `{ error: { code, title, body, errorId, traceRef, version, ... } }`. A
//   client that renders `title` and drops `code` gives the caller a string to
//   regex; `PlatosRefusal` carries the code, and `WIRE_ERROR_CODES` — emitted
//   from the same document — is the closed set it is drawn from.
//
//   AN UNAUTHENTICATED CALLER GETS A REFUSAL, NOT A PARTIAL ANSWER.
//   `send` returns the decoded body or throws. There is no branch that returns
//   `undefined`, an empty collection, or a half-populated envelope on a refusal,
//   because a public surface that answers `{ data: [] }` to a caller it rejected
//   is a surface whose emptiness cannot be distinguished from an empty result.

import {
  PlatosAuthError,
  PlatosError,
  PlatosNetworkError,
  PlatosRateLimitError,
  PlatosRefusal,
  PlatosServerError,
  errorFromResponse,
  isRetryableError,
} from "./errors.js";
import {
  IDEMPOTENCY_KEY_HEADER,
  V1Api,
  type V1Request,
  type V1Transport,
} from "./generated/v1.js";

/** M0.4 section 2's replay marker, as the middleware spells it. */
export const IDEMPOTENCY_REPLAYED_HEADER = "idempotency-replayed";

/**
 * The classes an `Idempotency-Key` is sent for.
 *
 * `required` and `accepted` are the two M0.4 section 2 puts the header on: the
 * mints where its ABSENCE is a refusal, and every other side-effecting
 * operation, where a key is honoured when one is sent. `exempt` operations are
 * the ones the rule cannot bind — an OAuth token exchange, an inbound webhook —
 * and sending one a key would be inventing a contract the server does not have.
 * `not-applicable` is a read.
 */
const SENDS_IDEMPOTENCY_KEY: ReadonlySet<string> = new Set(["required", "accepted"]);

export type IdempotencyKeyFactory = (request: V1Request) => string;

export interface V1ClientOptions {
  /** The Platos service, e.g. `https://platos.example.com`. A trailing slash is stripped. */
  readonly baseUrl: string;
  /**
   * The operator credential, sent as `Authorization: Bearer`.
   *
   * `transports/rest/operator.ts` accepts the session COOKIE or this header, and
   * names the header form as what "a script and this repository's own
   * integration suite send". A browser that already holds the `__Host-` cookie
   * omits this and passes `credentials: "include"` through `fetchOptions`.
   */
  readonly operatorToken?: string;
  /** Overrides `globalThis.fetch`; the seam every test in this package drives. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Mints the `Idempotency-Key` for one logical call.
   *
   * Defaults to `crypto.randomUUID()`. Supply your own when the caller can
   * recover the key across a process restart — a key held only in memory cannot
   * replay a mint whose response was lost to a crash rather than to a socket.
   */
  readonly idempotencyKey?: IdempotencyKeyFactory;
  /** Retries after the first try. Default 3. */
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Per-try timeout. Default 30s. */
  readonly timeoutMs?: number;
  /** Merged into every `fetch` init — `credentials`, `mode`, `keepalive`. */
  readonly fetchOptions?: RequestInit;
  /** Injected so a test can assert the backoff without sleeping. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  maxRetries: 3,
  baseDelayMs: 250,
  maxDelayMs: 10_000,
  timeoutMs: 30_000,
};

function defaultKeyFactory(): string {
  const random = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (random !== undefined) return random();
  // No WebCrypto (an old Node, a stripped runtime). The key only has to be
  // unique to this caller — the reservation is scoped by the credential and the
  // operation as well — so a timestamp plus entropy is within the contract, and
  // refusing to run would be worse than a slightly weaker key.
  return `plx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * One V1 request, retried, with the key held still.
 *
 * `send` is the whole transport: it is what the generated namespaces call, and
 * `V1Api` is the only thing built on top of it.
 */
export class V1HttpTransport implements V1Transport {
  private readonly baseUrl: string;
  private readonly options: V1ClientOptions;
  private readonly keyFactory: IdempotencyKeyFactory;

  /** The `Idempotency-Replayed` verdict of the most recent completed call. */
  lastResponseWasReplay = false;

  constructor(options: V1ClientOptions) {
    if (!options.baseUrl) throw new Error("V1HttpTransport: baseUrl is required");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.options = options;
    this.keyFactory = options.idempotencyKey ?? defaultKeyFactory;
  }

  headersFor(request: V1Request, idempotencyKey: string | null): Record<string, string> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (request.body !== undefined) headers["content-type"] = "application/json";
    if (this.options.operatorToken) headers["authorization"] = `Bearer ${this.options.operatorToken}`;
    if (idempotencyKey !== null) headers[IDEMPOTENCY_KEY_HEADER] = idempotencyKey;
    return headers;
  }

  urlFor(request: V1Request): string {
    const query =
      request.query === undefined || Object.keys(request.query).length === 0
        ? ""
        : `?${new URLSearchParams(request.query).toString()}`;
    return `${this.baseUrl}${request.path}${query}`;
  }

  /**
   * The key this call will carry on EVERY try, or null when the operation
   * is a read or an exemption.
   */
  keyFor(request: V1Request): string | null {
    if (!SENDS_IDEMPOTENCY_KEY.has(request.operation.idempotency)) return null;
    const key = this.keyFactory(request);
    if (typeof key !== "string" || key.length === 0) {
      throw new Error(
        `V1: the idempotency key factory returned no key for ${request.operation.operationId}; ` +
          "a mint cannot be sent without one",
      );
    }
    return key;
  }

  async send<T>(request: V1Request): Promise<T> {
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const maxRetries = this.options.maxRetries ?? DEFAULTS.maxRetries;
    // MINTED ONCE, HERE, OUTSIDE THE LOOP. Moving this line inside the loop is
    // the two-credential bug; `tests/v1-contract.test.ts` asserts every try of
    // one call carries the same value, so the move fails a named case.
    const idempotencyKey = this.keyFor(request);
    const url = this.urlFor(request);
    const headers = this.headersFor(request, idempotencyKey);
    const init: RequestInit = {
      ...(this.options.fetchOptions ?? {}),
      method: request.operation.method,
      headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    };

    let last: PlatosError | null = null;
    for (let retryCount = 0; retryCount <= maxRetries; retryCount += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULTS.timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(url, { ...init, signal: controller.signal });
      } catch (cause) {
        clearTimeout(timer);
        last = new PlatosNetworkError(cause);
        if (retryCount < maxRetries) {
          await sleep(this.backoffMs(retryCount));
          continue;
        }
        throw last;
      }
      clearTimeout(timer);

      if (response.ok) {
        this.lastResponseWasReplay = response.headers.get(IDEMPOTENCY_REPLAYED_HEADER) === "true";
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        return (text === "" ? undefined : JSON.parse(text)) as T;
      }

      const refusal = await errorFromResponse(response);
      last = refusal;
      if (retryCount < maxRetries && isRetryableError(refusal)) {
        const delay =
          refusal instanceof PlatosRateLimitError && refusal.retryAfterMs !== undefined
            ? refusal.retryAfterMs
            : this.backoffMs(retryCount);
        await sleep(delay);
        continue;
      }
      throw refusal;
    }
    throw last ?? new PlatosServerError(0, "exhausted retries");
  }

  private backoffMs(retryCount: number): number {
    const base = (this.options.baseDelayMs ?? DEFAULTS.baseDelayMs) * 2 ** retryCount;
    return Math.min(base, this.options.maxDelayMs ?? DEFAULTS.maxDelayMs);
  }
}

/**
 * The V1 surface, wired to a transport.
 *
 *   const v1 = createV1Client({ baseUrl, operatorToken });
 *   const organizations = await v1.organizations.list();
 *   const minted = await v1.mcpPlatformTokens.mint({ ... });
 *
 * `V1Api` and every type it names are GENERATED; the only hand-written part of
 * the call above is the transport underneath it.
 */
export function createV1Client(options: V1ClientOptions): V1Api & { readonly transport: V1HttpTransport } {
  const transport = new V1HttpTransport(options);
  const api = new V1Api(transport) as V1Api & { transport: V1HttpTransport };
  Object.defineProperty(api, "transport", { value: transport, enumerable: false });
  return api;
}

export { PlatosAuthError, PlatosRefusal };
