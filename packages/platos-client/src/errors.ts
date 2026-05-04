/**
 * @platos/client — error hierarchy.
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

/** Root class — every error thrown by the SDK extends this. */
export class PlatosError extends Error {
  public readonly status: number;
  public readonly body: string;
  /** When the error carries a structured payload (e.g. `{code, message}`). */
  public readonly detail: Record<string, unknown> | undefined;

  constructor(status: number, message: string, body = "", detail?: Record<string, unknown>) {
    super(`Platos ${status}: ${message}`);
    this.name = "PlatosError";
    this.status = status;
    this.body = body;
    this.detail = detail;
  }
}

/** 401 / 403 — token invalid, expired, or scope-mismatched. */
export class PlatosAuthError extends PlatosError {
  constructor(status: number, message: string, body = "", detail?: Record<string, unknown>) {
    super(status, message, body, detail);
    this.name = "PlatosAuthError";
  }
}

/** 404 — resource not found in the caller's scope. */
export class PlatosNotFoundError extends PlatosError {
  constructor(message: string, body = "", detail?: Record<string, unknown>) {
    super(404, message, body, detail);
    this.name = "PlatosNotFoundError";
  }
}

/** 400 / 422 — request body failed server-side Zod validation. */
export class PlatosValidationError extends PlatosError {
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
      if (typeof parsed.message === "string") message = parsed.message;
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
