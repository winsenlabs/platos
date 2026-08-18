export const INTERNAL_CALLBACK_AUTH_HEADER = "X-Platos-Internal-Auth";

export type InternalCallbackFailureCode =
  | "CALLBACK_NOT_CONFIGURED"
  | "CALLBACK_TIMEOUT"
  | "CALLBACK_REJECTED"
  | "CALLBACK_UNAVAILABLE"
  | "CALLBACK_INVALID_RESPONSE";

export interface InternalCallbackResult<T> {
  ok: true;
  value: T;
}

export interface InternalCallbackFailure {
  ok: false;
  code: InternalCallbackFailureCode;
  httpStatus?: number;
}

interface InternalCallbackOptions {
  path: `/${string}`;
  body: unknown;
  timeoutMs: number;
  source?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

function resolveAgentUrl(source: NodeJS.ProcessEnv): string | null {
  const raw = source.PLATOS_AGENT_HTTP_URL ?? source.PLATOS_AGENT_API_URL;
  if (!raw?.trim()) return null;

  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function timeoutFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/**
 * Calls a Platos-owned internal endpoint without putting authentication in the
 * Trigger payload. Failure bodies and thrown error messages are intentionally
 * discarded so provider, database, and token details cannot enter Trigger run
 * output or logs.
 */
export async function postInternalCallback<T>(
  options: InternalCallbackOptions,
): Promise<InternalCallbackResult<T> | InternalCallbackFailure> {
  const source = options.source ?? process.env;
  const agentUrl = resolveAgentUrl(source);
  const token = source.PLATOS_INTERNAL_AUTH_TOKEN?.trim();
  if (!agentUrl || !token) return { ok: false, code: "CALLBACK_NOT_CONFIGURED" };

  try {
    const response = await (options.fetchImpl ?? fetch)(`${agentUrl}${options.path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_CALLBACK_AUTH_HEADER]: token,
      },
      body: JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });

    if (!response.ok) {
      return {
        ok: false,
        code: "CALLBACK_REJECTED",
        httpStatus: response.status,
      };
    }

    try {
      return { ok: true, value: (await response.json()) as T };
    } catch {
      return { ok: false, code: "CALLBACK_INVALID_RESPONSE" };
    }
  } catch (error: unknown) {
    return {
      ok: false,
      code: timeoutFailure(error) ? "CALLBACK_TIMEOUT" : "CALLBACK_UNAVAILABLE",
    };
  }
}
