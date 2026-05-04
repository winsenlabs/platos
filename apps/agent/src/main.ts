import { NestFactory } from "@nestjs/core";
import type { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";
import { AppModule } from "./app.module";
import { AuthService } from "./auth/auth.service";
import { validateAgentEnv } from "./shared/env";

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

  if (process.env.NODE_ENV === "production") {
    if (staticOrigins.length === 0) {
      throw new Error(
        "PLATOS_CORS_ORIGIN is required in production and must not be `*`. " +
          "Supply a comma-separated list of operator-trusted origins " +
          '(e.g. "https://app.acme.com,https://admin.acme.com"). ' +
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

  const app = await NestFactory.create(AppModule);

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

bootstrap();
