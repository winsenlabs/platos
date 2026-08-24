/**
 * @platosdev/client — root `PlatosClient`. Theme I.1/I.2/I.3.
 *
 * Responsibilities (core):
 *   - Hold auth (`sessionToken` OR `apiKey`) + scope helpers.
 *   - Build headers, run `fetch` with retry + 401 refresh, surface
 *     typed errors from `errors.ts`.
 *   - Open Socket.IO connections for the realtime streaming module.
 *
 * Agent APIs are attached on construction so consumers can write
 * `client.agents.list()`, `client.turns.list()`, and `client.jobs.list()`.
 */

import { io, type Socket } from "socket.io-client";
import {
  errorFromResponse,
  isRetryableError,
  PlatosAuthError,
  PlatosError,
  PlatosNetworkError,
  PlatosRateLimitError,
  PlatosServerError,
} from "./errors.js";
import { AgentsApi } from "./apis/agents.js";
import { ApprovalsApi } from "./apis/approvals.js";
import { BudgetsApi } from "./apis/budgets.js";
import { MonitoringApi } from "./apis/monitoring.js";
import { MessagesApi } from "./apis/messages.js";
import { ThreadsApi } from "./apis/threads.js";
import { ToolsApi } from "./apis/tools.js";
import { JobsApi } from "./apis/jobs.js";
import { TurnsApi } from "./apis/turns.js";
import type {
  PlatosClientOptions,
  PlatosRetryOptions,
  PlatosScope,
  PlatosTokenRefreshFn,
} from "./types.js";

const DEFAULT_RETRY: Required<PlatosRetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 250,
  maxDelayMs: 10_000,
  jitter: 0.2,
};
const DEFAULT_TIMEOUT_MS = 30_000;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Root Platos client. Instantiate once per process / session.
 *
 *   const client = new PlatosClient({ baseUrl, sessionToken });
 *   const agents = await client.agents.list();
 *   for await (const evt of client.threads.send(threadId, "hello")) { ... }
 */
export class PlatosClient {
  readonly agents: AgentsApi;
  readonly threads: ThreadsApi;
  /** Completed user-to-agent units of work. */
  readonly turns: TurnsApi;
  /** EOBD.85 — human-in-the-loop approval queue. */
  readonly approvals: ApprovalsApi;
  /** EOBD.85 — read-only budget cap + status surface. */
  readonly budgets: BudgetsApi;
  /** EOBD.85 — Turns, traces, and cost rollups. */
  readonly monitoring: MonitoringApi;
  /**
   * Tool catalog (issue #2). Backs the dashboard's Tools tab + Matrix.
   *   `client.tools.list({ category? })`
   *   `client.tools.search(q, { limit?, entity? })`
   *   `client.tools.matrix()`        — per-entity grid with health data
   *   `client.tools.stats()`         — registry index counts
   *   `client.tools.setEnabled(entityId, toolName, enabled)`
   *   `client.tools.test(toolId, params)`
   */
  readonly tools: ToolsApi;
  /**
   * Message rating — thumbs up/down votes on assistant messages, backed by
   * the agent's `/messages/:id/rating` endpoints. `messageId` is the server
   * id surfaced on the `message_persisted` stream event.
   */
  readonly messages: MessagesApi;
  /** Platos-owned asynchronous background work. */
  readonly jobs: JobsApi;
  /**
   * @deprecated since 1.0.0 — use `client.jobs`. Removed in 2.0.0.
   */
  readonly bgo: JobsApi;
  /** @deprecated since 1.0.0 — use `client.jobs`. Removed in 2.0.0. */
  readonly trigger: JobsApi;

  private readonly opts: PlatosClientOptions;
  private sessionToken: string | undefined;
  private readonly refreshFn: PlatosTokenRefreshFn | undefined;
  private readonly retryCfg: Required<PlatosRetryOptions>;
  private readonly timeoutMs: number;

  constructor(opts: PlatosClientOptions) {
    if (!opts.baseUrl) throw new Error("PlatosClient: baseUrl is required");
    if (!opts.sessionToken && !opts.apiKey) {
      throw new Error("PlatosClient: one of { sessionToken, apiKey } is required");
    }
    // Normalize — strip trailing slash so we can safely concat paths.
    this.opts = { ...opts, baseUrl: opts.baseUrl.replace(/\/+$/, "") };
    this.sessionToken = opts.sessionToken;
    this.refreshFn = opts.onTokenRefresh;
    this.retryCfg = { ...DEFAULT_RETRY, ...(opts.retry ?? {}) };
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.agents = new AgentsApi(this);
    this.threads = new ThreadsApi(this);
    this.turns = new TurnsApi(this);
    // EOBD.85 — new dashboard-facing namespaces.
    this.approvals = new ApprovalsApi(this);
    this.budgets = new BudgetsApi(this);
    this.monitoring = new MonitoringApi(this);
    this.tools = new ToolsApi(this);
    this.messages = new MessagesApi(this);
    this.jobs = new JobsApi(this);
    this.bgo = this.jobs;
    this.trigger = this.jobs;
  }

  /** Update the session token in place (e.g. after a manual refresh). */
  setSessionToken(token: string): void {
    this.sessionToken = token;
  }

  /** @internal */
  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  /** @internal */
  get socketNamespace(): string {
    return this.opts.socketNamespace ?? "/agent";
  }

  /** @internal */
  get currentToken(): string | undefined {
    return this.sessionToken;
  }

  /** @internal */
  _buildHeaders(scope?: PlatosScope): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.sessionToken) {
      h["X-Platos-Session-Token"] = this.sessionToken;
    } else if (this.opts.apiKey) {
      h["Authorization"] = `Bearer ${this.opts.apiKey}`;
      if (!scope) {
        throw new Error("PlatosClient: apiKey mode requires an explicit scope on every call");
      }
    }
    if (scope) {
      h["X-Platos-Organization-Id"] = scope.organizationId;
      h["X-Platos-Project-Id"] = scope.projectId;
      h["X-Platos-Environment-Id"] = scope.environmentId;
      if (scope.userId) h["X-Platos-User-Id"] = scope.userId;
    }
    // EOBD.86 — per-user identity passthrough. Customer backend mints an
    // opaque userToken (e.g. their own JWT, or a random id) and we forward
    // it on every request so the agent's tool backend can scope per-user.
    // Instance-level `userToken` is the default; per-call `scope.userToken`
    // overrides for short-lived impersonation.
    const userToken = scope?.userToken ?? this.opts.userToken;
    if (userToken) {
      h["X-Platos-User-Token"] = userToken;
    }
    return h;
  }

  /**
   * @internal — fetch with retry, 401-refresh, and timeout. All public
   * REST helpers go through this.
   */
  async _fetch<T>(path: string, init: RequestInit, scope?: PlatosScope): Promise<T> {
    return this._fetchWithRefresh<T>(path, init, scope, /* refreshedOnce */ false);
  }

  private async _fetchWithRefresh<T>(
    path: string,
    init: RequestInit,
    scope: PlatosScope | undefined,
    refreshedOnce: boolean,
  ): Promise<T> {
    try {
      return await this._fetchWithRetry<T>(path, init, scope);
    } catch (err) {
      // 401/403 → try one token refresh, then re-run exactly once.
      if (err instanceof PlatosAuthError && !refreshedOnce && this.refreshFn && this.sessionToken !== undefined) {
        let fresh: string | null = null;
        try {
          fresh = await this.refreshFn({ currentToken: this.sessionToken, status: err.status });
        } catch {
          // Refresh handler itself failed — surface the original error.
        }
        if (fresh && fresh !== this.sessionToken) {
          this.sessionToken = fresh;
          return this._fetchWithRefresh<T>(path, init, scope, true);
        }
      }
      throw err;
    }
  }

  private async _fetchWithRetry<T>(path: string, init: RequestInit, scope?: PlatosScope): Promise<T> {
    const fetchImpl = this.opts.fetch ?? globalThis.fetch;
    const url = `${this.opts.baseUrl}${path}`;
    const externalSignal = init.signal ?? undefined;

    let lastError: unknown;
    for (let retryCount = 0; retryCount <= this.retryCfg.maxRetries; retryCount++) {
      // Per-retry timeout signal combined with caller's signal.
      const retryController = new AbortController();
      const timeoutId = setTimeout(() => retryController.abort(), this.timeoutMs);
      const combined = externalSignal
        ? anySignal([externalSignal, retryController.signal])
        : retryController.signal;

      let res: Response;
      try {
        res = await fetchImpl(url, {
          ...init,
          signal: combined,
          headers: { ...this._buildHeaders(scope), ...(init.headers as Record<string, string> | undefined) },
        });
      } catch (err) {
        clearTimeout(timeoutId);
        const netErr = new PlatosNetworkError(err);
        lastError = netErr;
        if (retryCount < this.retryCfg.maxRetries && !externalSignal?.aborted) {
          await sleep(this._backoffMs(retryCount), externalSignal);
          continue;
        }
        throw netErr;
      }
      clearTimeout(timeoutId);

      if (res.ok) {
        const body = await res.text();
        if (!body) return undefined as unknown as T;
        return JSON.parse(body) as T;
      }

      const parsed = await errorFromResponse(res);
      lastError = parsed;
      if (
        retryCount < this.retryCfg.maxRetries &&
        isRetryableError(parsed) &&
        !externalSignal?.aborted
      ) {
        // Honor Retry-After for 429s.
        const delay =
          parsed instanceof PlatosRateLimitError && parsed.retryAfterMs
            ? parsed.retryAfterMs
            : this._backoffMs(retryCount);
        await sleep(delay, externalSignal);
        continue;
      }
      throw parsed;
    }
    // Unreachable — the loop always either returns or throws, but TS
    // can't see that without an explicit guard.
    throw lastError instanceof PlatosError ? lastError : new PlatosServerError(0, "exhausted retries");
  }

  private _backoffMs(retryCount: number): number {
    const base = this.retryCfg.baseDelayMs * Math.pow(2, retryCount);
    const capped = Math.min(base, this.retryCfg.maxDelayMs);
    const jitterFrac = this.retryCfg.jitter;
    const rand = 1 + (Math.random() * 2 - 1) * jitterFrac;
    return Math.max(0, Math.floor(capped * rand));
  }

  /** @internal — used by the realtime module. */
  _openSocket(scope?: PlatosScope): Socket {
    const namespace = this.socketNamespace;
    const url = `${this.opts.baseUrl}${namespace}`;
    const auth: Record<string, string> = {};
    if (this.sessionToken) auth.token = this.sessionToken;
    if (scope) {
      auth.organizationId = scope.organizationId;
      auth.projectId = scope.projectId;
      auth.environmentId = scope.environmentId;
      if (scope.userId) auth.userId = scope.userId;
    }
    return io(url, {
      auth,
      transports: ["websocket"],
      forceNew: true,
      // Let the consumer app decide reconnection strategy — our iterator
      // orchestrates a manual reconnect in `threads.send` to preserve the
      // event-buffer-during-disconnect invariant (see realtime.ts).
      reconnection: false,
    });
  }

  /**
   * EOBD.84 — Socket.IO 401-refresh helper.
   *
   * Opens a socket; if the initial `connect_error` indicates an auth
   * failure AND `onTokenRefresh` is configured AND we haven't already
   * retried, we refresh the token and open a fresh socket once. Same
   * policy as the REST fetch path; this closes the gap where a stale
   * browser token worked on REST but dropped every WS upgrade.
   *
   * The returned promise resolves when the socket is `connect`ed or
   * rejects with the last `connect_error` once the single refresh
   * retry is exhausted.
   */
  async _openSocketWithRefresh(scope?: PlatosScope): Promise<Socket> {
    const connect = async (refreshedOnce: boolean): Promise<Socket> => {
      const socket = this._openSocket(scope);
      return new Promise<Socket>((resolve, reject) => {
        const onConnect = () => {
          socket.off("connect_error", onError);
          resolve(socket);
        };
        const onError = async (err: Error & { data?: { status?: number; code?: string } }) => {
          socket.off("connect", onConnect);
          socket.disconnect();
          const status = err?.data?.status ?? 0;
          const code = err?.data?.code ?? "";
          const isAuth =
            status === 401 ||
            status === 403 ||
            /unauth/i.test(err?.message ?? "") ||
            code === "unauthorized";
          if (isAuth && !refreshedOnce && this.refreshFn && this.sessionToken !== undefined) {
            try {
              const fresh = await this.refreshFn({
                currentToken: this.sessionToken,
                status: status || 401,
              });
              if (fresh && fresh !== this.sessionToken) {
                this.sessionToken = fresh;
                // Retry with new token exactly once.
                resolve(connect(true));
                return;
              }
            } catch {
              // fall through → reject with original error
            }
          }
          reject(err);
        };
        socket.once("connect", onConnect);
        socket.once("connect_error", onError);
      });
    };
    return connect(false);
  }
}

/**
 * Merge multiple AbortSignals into one — mirrors the not-yet-standard
 * `AbortSignal.any`. Small local impl keeps the package dep-free.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  const onAbort = (reason: unknown) => ctrl.abort(reason);
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => onAbort(s.reason), { once: true });
  }
  return ctrl.signal;
}
