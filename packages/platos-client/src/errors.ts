/**
 * @platosdev/client — error hierarchy.
 *
 * Theme I.1 — PlatosError is the root. Subclasses let consumer code do:
 *
 *   try { ... } catch (err) {
 *     if (err instanceof PlatosAuthError) { reauth(); return; }
 *     if (err instanceof PlatosRateLimitError) { backoff(); return; }
 *     throw err;
 *   }
 *
 * The factory `fromResponse(status, body)` lives here so retry/fetch code
 * in `client.ts` stays ignorant of error taxonomy.
 */

/**
 * One refusal off the V1 wire, as ADR M0.4 section 2 states it.
 *
 * WIN-270 (M4.4). Until this landed, `errorFromResponse` looked for
 * `parsed.message` or a STRING `parsed.error`, and the V1 envelope is neither:
 * `error` is an OBJECT. So a 401 from `/api/v1/identity/session` produced a
 * `PlatosAuthError` whose message was the bare HTTP status text and whose `code`
 * — the one field a caller can branch on — was dropped on the floor. Every
 * refusal on this surface carries a code; a client that hides it forces callers
 * to regex a human sentence, and a sentence is not a contract.
 */
export interface PlatosWireErrorDetail {
  readonly code: string;
  readonly title: string;
  readonly body: string;
  readonly errorId: string;
  readonly traceRef: string;
  readonly version: string;
  readonly fields?: readonly { readonly field: string; readonly code: string; readonly message: string }[];
  readonly retryAfterSec?: number;
}

/**
 * Read the V1 envelope out of a parsed body, or null when it is not one.
 *
 * STRICT ON `code` AND NOTHING ELSE. `code` is the field the caller branches on
 * and the field the taxonomy owns, so a body without a string `code` is not a V1
 * refusal and is not treated as one. The other members are read when present and
 * defaulted to the empty string when not, because a server that answered a
 * partial envelope has still refused, and refusing to parse it would turn a
 * refusal into a silent generic error.
 */
export function readWireError(parsed: unknown): PlatosWireErrorDetail | null {
  if (parsed === null || typeof parsed !== "object") return null;
  const error = (parsed as { error?: unknown }).error;
  if (error === null || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  if (typeof record.code !== "string" || record.code.length === 0) return null;
  const text = (key: string): string => (typeof record[key] === "string" ? (record[key] as string) : "");
  const fields = Array.isArray(record.fields)
    ? (record.fields as unknown[]).flatMap((entry) => {
        if (entry === null || typeof entry !== "object") return [];
        const violation = entry as Record<string, unknown>;
        if (typeof violation.field !== "string" || typeof violation.code !== "string") return [];
        return [
          {
            field: violation.field,
            code: violation.code,
            message: typeof violation.message === "string" ? violation.message : "",
          },
        ];
      })
    : undefined;
  return {
    code: record.code,
    title: text("title"),
    body: text("body"),
    errorId: text("errorId"),
    traceRef: text("traceRef"),
    version: text("version"),
    ...(fields === undefined || fields.length === 0 ? {} : { fields }),
    ...(typeof record.retryAfterSec === "number" ? { retryAfterSec: record.retryAfterSec } : {}),
  };
}

/** Root class — every error thrown by the SDK extends this. */
export class PlatosError extends Error {
  public readonly status: number;
  public readonly body: string;
  /** When the error carries a structured payload (e.g. `{code, message}`). */
  public readonly detail: Record<string, unknown> | undefined;
  /**
   * The canonical `error.code` when the answer was a V1 envelope, else
   * `undefined`.
   *
   * `undefined` and not `"UNKNOWN"`: a code invented by the client would be
   * indistinguishable from one the server minted, and the whole value of the
   * field is that it came from the taxonomy.
   */
  public readonly code: string | undefined;
  /** The rest of the V1 envelope — `errorId` and `traceRef` are what a support
   * ticket is opened with. */
  public readonly refusal: PlatosWireErrorDetail | undefined;

  constructor(status: number, message: string, body = "", detail?: Record<string, unknown>) {
    super(`Platos ${status}: ${message}`);
    this.name = "PlatosError";
    this.status = status;
    this.body = body;
    this.detail = detail;
    const wire = readWireError(detail);
    this.code = wire?.code;
    this.refusal = wire ?? undefined;
  }
}

/**
 * A CODED 4xx: the server declined, and no retry of the same request succeeds.
 *
 * THE BASE OF THE 4xx FAMILY, not a sibling of it. `PlatosAuthError`,
 * `PlatosNotFoundError` and `PlatosValidationError` extend this, so a caller
 * that writes `catch (e) { if (e instanceof PlatosRefusal) ... }` reaches every
 * refusal on the V1 surface — including the ones minted after this SDK was
 * built, which by construction have no named subclass here. Existing code that
 * narrows to a named class keeps working; this only widens what can be caught.
 *
 * 429 is deliberately NOT in this family. A rate limit is a refusal of THIS
 * attempt and an invitation to make another, which is why `isRetryableError`
 * returns true for it — catching it beside a permanent refusal would lose that
 * distinction.
 */
export class PlatosRefusal extends PlatosError {
  constructor(status: number, message: string, body = "", detail?: Record<string, unknown>) {
    super(status, message, body, detail);
    this.name = "PlatosRefusal";
  }
}

/** 401 / 403 — token invalid, expired, or scope-mismatched. */
export class PlatosAuthError extends PlatosRefusal {
  constructor(status: number, message: string, body = "", detail?: Record<string, unknown>) {
    super(status, message, body, detail);
    this.name = "PlatosAuthError";
  }
}

/** 404 — resource not found in the caller's scope. */
export class PlatosNotFoundError extends PlatosRefusal {
  constructor(message: string, body = "", detail?: Record<string, unknown>) {
    super(404, message, body, detail);
    this.name = "PlatosNotFoundError";
  }
}

/** 400 / 422 — request body failed server-side Zod validation. */
export class PlatosValidationError extends PlatosRefusal {
  public readonly validationErrors: string[];
  constructor(
    status: number,
    message: string,
    validationErrors: string[] = [],
    body = "",
    detail?: Record<string, unknown>,
  ) {
    super(status, message, body, detail);
    this.name = "PlatosValidationError";
    this.validationErrors = validationErrors;
  }
}

/** 429 — caller should back off. `retryAfterMs` is populated when the server sends `Retry-After`. */
export class PlatosRateLimitError extends PlatosError {
  public readonly retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs: number | undefined, body = "", detail?: Record<string, unknown>) {
    super(429, message, body, detail);
    this.name = "PlatosRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** 5xx — transient. Retry policy in `client.ts` handles these. */
export class PlatosServerError extends PlatosError {
  constructor(status: number, message: string, body = "", detail?: Record<string, unknown>) {
    super(status, message, body, detail);
    this.name = "PlatosServerError";
  }
}

/** Network-layer failure (fetch threw) — socket hang-up, DNS, etc. */
export class PlatosNetworkError extends PlatosError {
  /**
   * Underlying thrown value from `fetch` / `AbortController`. Named
   * `reason` (not `cause`) because `Error.cause` is reserved in ES2022
   * with an `unknown` type that conflicts with our stricter typing.
   */
  public readonly reason: unknown;
  constructor(reason: unknown) {
    const msg = reason instanceof Error ? reason.message : String(reason);
    super(0, `network error: ${msg}`, "");
    this.name = "PlatosNetworkError";
    this.reason = reason;
  }
}

/**
 * Parse a `Response` into the appropriate error subclass.
 * Never throws — always returns a PlatosError.
 */
export async function errorFromResponse(res: Response): Promise<PlatosError> {
  const text = await res.text().catch(() => "");
  let detail: Record<string, unknown> | undefined;
  let message = res.statusText || "request failed";
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      detail = parsed as Record<string, unknown>;
      // THE V1 ENVELOPE IS TRIED FIRST, and its `code` leads the message. A
      // caller reading a log line needs the code more than it needs the title,
      // and `PlatosError.code` carries it structurally either way.
      const wire = readWireError(parsed);
      if (wire !== null) message = wire.title === "" ? wire.code : `${wire.code}: ${wire.title}`;
      else if (typeof parsed.message === "string") message = parsed.message;
      else if (typeof parsed.error === "string") message = parsed.error;
    }
  } catch {
    // Non-JSON body — fall back to raw text.
    if (text) message = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  }

  const status = res.status;
  if (status === 401 || status === 403) return new PlatosAuthError(status, message, text, detail);
  if (status === 404) return new PlatosNotFoundError(message, text, detail);
  if (status === 400 || status === 422) {
    const errs = Array.isArray(detail?.validationErrors)
      ? (detail!.validationErrors as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    return new PlatosValidationError(status, message, errs, text, detail);
  }
  if (status === 429) {
    const retryAfter = res.headers.get("retry-after");
    let retryAfterMs: number | undefined;
    if (retryAfter) {
      const n = Number(retryAfter);
      if (Number.isFinite(n)) retryAfterMs = n * 1000;
    }
    return new PlatosRateLimitError(message, retryAfterMs, text, detail);
  }
  if (status >= 500) return new PlatosServerError(status, message, text, detail);
  // Every other 4xx is a REFUSAL, and it is a named class so a caller can branch
  // on the whole family rather than on a status number it has to keep in step
  // with the taxonomy.
  if (status >= 400) return new PlatosRefusal(status, message, text, detail);
  return new PlatosError(status, message, text, detail);
}

/**
 * `true` iff the error is worth retrying (network, 5xx, 429 with retry-after).
 * Used by the retry policy in `client.ts`.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof PlatosNetworkError) return true;
  if (err instanceof PlatosServerError) return true;
  if (err instanceof PlatosRateLimitError) return true;
  return false;
}
