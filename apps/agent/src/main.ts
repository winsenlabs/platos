import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";
import { AppModule } from "./app.module";
import { AuthService } from "./auth/auth.service";
import { applyApiSurface } from "./http/api-surface";
import { installRequestBodyLimits, resolveUnauthBodyCaps } from "./http/request-body-limits";
import { validateAgentEnv } from "./shared/env";
import { resolveExternalTriggerConfig } from "./shared/external-trigger-config";
import { terminateAfterStartupFailure } from "./startup-failure";

// EOBD.4 — PLATOS_TEST_MODE=true unlocks test-only endpoints that mint
// session tokens with no auth + unlocks a dev-mode fallback branch in
// validateSessionToken. If this env var ever leaks to production, we
// have complete cross-tenant auth bypass. Fail-fast at boot.
if (
  process.env.PLATOS_TEST_MODE === "true" &&
  process.env.NODE_ENV === "production"
) {
  throw new Error(
    "PLATOS_TEST_MODE=true is forbidden when NODE_ENV=production. " +
      "Unset PLATOS_TEST_MODE or run with NODE_ENV=development/test. " +
      "See CLAUDE.md §14 (EOBD.4) for rationale.",
  );
}

/**
 * EOBD.11 — resolve CORS config. Browsers reject `*` + credentials:true,
 * but NestJS' cors middleware with `origin: "*"` + `credentials: true`
 * reflects the Origin header — effectively any-origin with credentials.
 * Production must supply an explicit origin list; dev falls back to `*`
 * with credentials disabled.
 *
 * Multi-tenant CORS extension: in production, the origin allow-list is
 * the union of `PLATOS_CORS_ORIGIN` (operator-trusted, e.g. dashboard,
 * Platos-owned marketing site) AND every PlatosConnectedEntity's
 * `allowedOrigins` array. Self-hosters never need to redeploy when an
 * integrator wants to embed the chat widget on a new domain — they just
 * add the origin to their entity record.
 */
function staticCorsOrigins(): string[] {
  const raw = (process.env.PLATOS_CORS_ORIGIN || "").trim();
  if (!raw || raw === "*") return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function resolveCorsConfig(authService: AuthService | null): CorsOptions {
  const staticOrigins = staticCorsOrigins();
  const universal = (process.env.PLATOS_CORS_UNIVERSAL || "").trim() === "true";

  // Hosted-demo escape hatch. When the operator explicitly opts in via
  // PLATOS_CORS_UNIVERSAL=true, accept ANY origin so a third-party
  // integrator can test their entity from arbitrary domains. credentials
  // is forced OFF — bearer tokens travel in the Authorization header so
  // we don't need cookies, and turning credentials off keeps cookies
  // from leaking across origins. The per-entity allowedOrigins gate
  // still applies inside the request handlers, narrowing which entity
  // any given origin can actually transact with.
  if (universal) {
    return { origin: true, credentials: false };
  }

  if (process.env.NODE_ENV === "production") {
    if (staticOrigins.length === 0) {
      throw new Error(
        "PLATOS_CORS_ORIGIN is required in production and must not be `*`. " +
          "Supply a comma-separated list of operator-trusted origins " +
          '(e.g. "https://app.acme.com,https://admin.acme.com") ' +
          "OR set PLATOS_CORS_UNIVERSAL=true to accept any origin. " +
          "Per-customer origins go on each PlatosConnectedEntity.allowedOrigins.",
      );
    }
    return {
      credentials: true,
      origin: dynamicOriginCheck(staticOrigins, authService),
    };
  }

  // Dev / test — if no explicit static list, allow `*` but force
  // credentials OFF so the wildcard is browser-safe. Entity-declared
  // origins still apply on top.
  if (staticOrigins.length === 0) {
    return { origin: "*", credentials: false };
  }
  return {
    credentials: true,
    origin: dynamicOriginCheck(staticOrigins, authService),
  };
}

/**
 * Build a NestJS-compatible origin function that accepts an Origin
 * header iff it's in the static list OR in any entity's allowedOrigins
 * (cached for 30s by AuthService.getAllAllowedOrigins).
 *
 * `origin` is `undefined` for same-origin / non-browser callers — let
 * those through; the actual auth gate lives in ScopeGuard.
 */
function dynamicOriginCheck(
  staticOrigins: string[],
  authService: AuthService | null,
): (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => void {
  const staticSet = new Set(staticOrigins);
  return (origin, cb) => {
    if (!origin) return cb(null, true);
    if (staticSet.has(origin)) return cb(null, true);
    if (!authService) return cb(null, false);
    authService
      .getAllAllowedOrigins()
      .then((entitySet) => cb(null, entitySet.has(origin)))
      .catch((err) => {
        // Fail closed on DB errors — better to reject CORS than to
        // silently allow every origin. Operator can always add a
        // critical origin to PLATOS_CORS_ORIGIN as a static fallback.
        console.error("[cors] origin check failed:", err);
        cb(null, false);
      });
  };
}

async function bootstrap() {
  // EOBD.57 — centralized Zod env validation. Runs before the other env
  // guards above (EOBD.4 / EOBD.11) conceptually cover; those remain in
  // place as belt-and-braces so a hypothetical regression here still
  // fails closed. Collect every error and print as a single block so
  // `docker logs` shows all problems at once rather than one-at-a-time.
  const envResult = validateAgentEnv();
  if (!envResult.ok) {
    process.stderr.write(
      "[Platos agent] Invalid environment — refusing to boot:\n",
    );
    for (const err of envResult.errors) {
      process.stderr.write(`  - ${err}\n`);
    }
    process.exit(1);
  }

  const externalTrigger = resolveExternalTriggerConfig();
  if (externalTrigger.status === "incomplete") {
    process.stderr.write(`[Platos agent] ${externalTrigger.message}\n`);
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    // Channels RUNTIME — the inbound webhook adapters (Slack HMAC / WhatsApp
    // X-Hub-Signature-256 / Discord Ed25519 / Telegram secret_token) sign the
    // EXACT received bytes, so the channels controller needs the unparsed body
    // as `req.rawBody`. `rawBody: true` makes the explicit `useBodyParser`
    // calls below ALSO stash the raw Buffer on every parsed request; existing
    // JSON/urlencoded body handling is otherwise unchanged.
    rawBody: true,
  });

  // WIN-267 (M4.1) T1 — the version expression, declared once in
  // `http/api-surface.ts` and installed here: `setGlobalPrefix("api")` +
  // `enableVersioning({ type: URI, defaultVersion: "1" })`, so every controller
  // declares only its own path and none of them spells `api/v1` by hand any
  // more (ADR M0.4 §1.2/§2, WIN-249). Routes are built at `init()`, so this must
  // run before `listen()`; it is placed first because everything below reasons
  // about the FINAL wire path this call produces.
  //
  // The body caps installed below (`http/request-body-limits.ts`) are mounted on
  // wire prefixes the pre-M4.1 table spelled `/api/v1/...` literally, and those
  // stay literal: if this call ever stopped producing that prefix they would stop
  // firing on the public surface, which is a failure the route-identity test and
  // the manifest join in `request-body-limits.test.ts` name rather than paper over.
  applyApiSurface(app);

  // L8 — clamp body size on the UNAUTHENTICATED bypass surface BEFORE the
  // global parser can buffer it, then install the parser. Auth on every capped
  // prefix runs AFTER the body is parsed, so the order is the guarantee, and
  // `installRequestBodyLimits` owns it: the cap table, the middleware, the 15mb
  // parser and the reasons for each live in `http/request-body-limits.ts`, where
  // `request-body-limits.test.ts` drives the same installer over a real socket.
  // The two operator overrides are read HERE, at the composition root, and
  // handed in as values.
  installRequestBodyLimits(
    app,
    resolveUnauthBodyCaps({
      PLATOS_MCP_BODY_CAP_BYTES: process.env.PLATOS_MCP_BODY_CAP_BYTES,
      PLATOS_CHANNELS_BODY_CAP_BYTES: process.env.PLATOS_CHANNELS_BODY_CAP_BYTES,
    }),
  );

  // EOBD.42 — enable graceful shutdown so SentryService.onApplicationShutdown
  // + WS close hooks run on SIGTERM. Without this, Sentry drops in-flight
  // events + the tool-sync server leaks sockets.
  app.enableShutdownHooks();

  // AuthService is needed for the dynamic-origin lookup. Fetch via the
  // Nest container so we share the singleton + its origin cache rather
  // than instantiating a second copy.
  const authService = app.get(AuthService, { strict: false });
  const corsConfig = resolveCorsConfig(authService);
  app.enableCors(corsConfig);

  const port = process.env.PLATOS_AGENT_PORT || 3100;
  await app.listen(port);

  console.log(`
========================================
  Platos Agent Service
  Running on http://0.0.0.0:${port}
  Test mode: ${process.env.PLATOS_TEST_MODE === "true" ? "ENABLED" : "disabled"}
  Sentry:    ${process.env.PLATOS_SENTRY_DSN || process.env.SENTRY_DSN ? "enabled" : "disabled"}
  Metrics:   /metrics
========================================
  `);
}

bootstrap().catch((error: unknown) => {
  terminateAfterStartupFailure(error);
});
