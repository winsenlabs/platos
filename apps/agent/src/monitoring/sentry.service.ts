import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import * as Sentry from "@sentry/node";
import { env } from "../shared/env";

/**
 * EOBD.42 — Sentry wiring for the agent process.
 *
 * Initialised at bootstrap when `PLATOS_SENTRY_DSN` is set. Missing DSN
 * is a no-op — the service stays a passive identity so we don't force
 * Sentry on self-hosters who don't want it.
 *
 * PII scrubbing (`beforeSend`) removes:
 *   - assistant/user message content (possibly sensitive conversation data)
 *   - `x-platos-user-token` headers (opaque customer identity proof)
 *   - `x-platos-session-token` headers (JWT-like session tokens)
 *   - `authorization` headers (service secrets, bearer tokens)
 *   - `api_key` / `apiKey` fields anywhere in the event tree
 *
 * Scrub is defense-in-depth — the Nest exception filter already strips
 * request bodies before passing events here.
 */
@Injectable()
export class SentryService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SentryService.name);
  private initialized = false;

  onApplicationBootstrap(): void {
    const dsn = env.PLATOS_SENTRY_DSN || env.SENTRY_DSN;
    if (!dsn) {
      this.logger.log("Sentry disabled — PLATOS_SENTRY_DSN not set");
      return;
    }

    const tracesSampleRate = env.PLATOS_SENTRY_TRACES_SAMPLE_RATE ?? 0.1;

    Sentry.init({
      dsn,
      environment: env.NODE_ENV || "development",
      release: env.PLATOS_RELEASE || env.GIT_COMMIT || undefined,
      tracesSampleRate: Number.isFinite(tracesSampleRate) ? tracesSampleRate : 0.1,
      beforeSend: (event) => scrubPii(event),
    });

    // Unhandled rejections + uncaught exceptions (Sentry's Node SDK hooks
    // these itself, but register a backup so an error during Sentry's own
    // init path still surfaces in our Logger).
    process.on("unhandledRejection", (reason) => {
      this.logger.error("Unhandled rejection", reason as any);
      Sentry.captureException(reason);
    });
    process.on("uncaughtException", (err) => {
      this.logger.error("Uncaught exception", err.stack);
      Sentry.captureException(err);
    });

    this.initialized = true;
    this.logger.log(`Sentry enabled (env=${env.NODE_ENV})`);
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.initialized) return;
    try {
      await Sentry.close(2000);
    } catch {
      // Shutdown flush timed out — acceptable.
    }
  }

  captureException(err: unknown, context?: Record<string, unknown>): void {
    if (!this.initialized) return;
    Sentry.withScope((scope) => {
      if (context) {
        for (const [k, v] of Object.entries(context)) scope.setExtra(k, v);
      }
      Sentry.captureException(err);
    });
  }
}

/**
 * Recursive PII scrub. Strips known-sensitive keys (case-insensitive
 * match) and masks `authorization` / `x-platos-*-token` headers.
 * Returns a shallow-cloned event so we don't mutate the caller's.
 */
function scrubPii(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  const SENSITIVE_KEYS = new Set([
    "authorization",
    "x-platos-session-token",
    "x-platos-user-token",
    "content",
    "messages",
    "api_key",
    "apikey",
    "secret",
    "servicesecret",
    "cookie",
  ]);

  // Wave 13 review follow-up — cycle guard. Sentry events are acyclic
  // by construction, but a custom context carrying a self-referential
  // object would stack-overflow inside walk() and lose the event. Cheap
  // to protect against.
  const seen = new WeakSet<object>();
  function walk(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value !== "object") return value;
    if (seen.has(value as object)) return "[cycle]";
    seen.add(value as object);
    if (Array.isArray(value)) return value.map(walk);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = "[redacted]";
      } else {
        out[k] = walk(v);
      }
    }
    return out;
  }

  return walk(event) as Sentry.ErrorEvent;
}
