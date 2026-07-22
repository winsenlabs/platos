import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
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

  // L8 — clamp body size on the UNAUTHENTICATED bypass surface BEFORE the
  // global parser can buffer it. The 15mb limit below exists solely for the
  // authenticated catalog-ingest route (POST
  // /api/v1/agent/monitoring/cost/catalog, admin-token gated in ScopeGuard).
  // The public/unauth prefixes never need a 15mb buffer, so leaving it there is
  // a memory-amplification DoS vector (auth runs AFTER the body is parsed, so a
  // big body is buffered before the 401). Registered BEFORE useBodyParser so it
  // runs FIRST in the Express stack (both are httpAdapter.use() calls appended
  // in source order): a reject here fails closed before express.json reads a
  // byte. We inspect Content-Length rather than mounting a second express.json
  // parser because a direct require("express") is not resolvable in the pruned
  // production image and useBodyParser is app-global, not per-prefix.
  //
  // Per-prefix caps: /oauth + /api/v1/public are tiny control-plane payloads
  // (256KB is generous); /mcp tool calls can legitimately carry document-sized
  // arguments (memory upsert, RAG ingest), so they get a higher-but-still-
  // bounded cap (2MB, env-tunable) — 7.5x below the old 15mb, closing the
  // amplification vector without 413-ing real tool calls. Body-bearing requests
  // with no Content-Length (chunked) on these prefixes are rejected too; legit
  // callers here always send a small, length-framed JSON payload.
  const PUBLIC_BODY_CAP_BYTES = 256 * 1024;
  const MCP_BODY_CAP_BYTES =
    Number(process.env.PLATOS_MCP_BODY_CAP_BYTES) || 2 * 1024 * 1024;
  // Channels inbound webhooks are also an UNAUTHENTICATED bypass surface (auth
  // runs in-controller: webhookSecret + provider signature). A provider event
  // payload is small; 1MB is generous and closes the same memory-amplification
  // vector the other public prefixes guard against. GET (WhatsApp hub.challenge)
  // is skipped by the method check below, so its query-string handshake is
  // unaffected.
  const CHANNELS_BODY_CAP_BYTES =
    Number(process.env.PLATOS_CHANNELS_BODY_CAP_BYTES) || 1 * 1024 * 1024;
  const UNAUTH_BODY_CAPS: Array<{ prefix: string; cap: number }> = [
    { prefix: "/mcp", cap: MCP_BODY_CAP_BYTES },
    { prefix: "/oauth", cap: PUBLIC_BODY_CAP_BYTES },
    { prefix: "/api/v1/public", cap: PUBLIC_BODY_CAP_BYTES },
    { prefix: "/api/v1/channels/inbound", cap: CHANNELS_BODY_CAP_BYTES },
    // Connect v3 marketplace-app events (POST /api/v1/channels/apps/:id/events)
    // — same unauthenticated-bypass shape as /channels/inbound (auth is the
    // in-controller Slack signature check, which runs AFTER the body is
    // buffered). Slack event payloads are far under 1MB. The sibling
    // /api/v1/channels/oauth prefix is GET-only, so the method check above
    // already skips it.
    { prefix: "/api/v1/channels/apps", cap: CHANNELS_BODY_CAP_BYTES },
    // Connect v3 Phase C hosted account linking (/api/v1/channels/link/*). This
    // is the same unauthenticated-bypass family; the caps list matches by exact
    // prefix, and neither of the entries above covers `/link`. The link routes
    // are GET-only today (the method check above skips them), so this is a
    // forward-guard: if a POST link route is ever added, it inherits the same
    // 1MB cap instead of falling back to the effectively-unbounded 15mb parser.
    { prefix: "/api/v1/channels/link", cap: CHANNELS_BODY_CAP_BYTES },
  ];
  app.use((req: any, res: any, next: () => void) => {
    const method = req.method;
    if (
      method === "GET" ||
      method === "HEAD" ||
      method === "OPTIONS" ||
      method === "DELETE"
    ) {
      return next();
    }
    const path = String(req.url || "").split("?")[0];
    const match = UNAUTH_BODY_CAPS.find(
      (c) => path === c.prefix || path.startsWith(c.prefix + "/"),
    );
    if (!match) return next();
    const len = Number(req.headers["content-length"]);
    if (!Number.isFinite(len) || len > match.cap) {
      res.statusCode = 413;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ error: "payload_too_large", limit: match.cap }),
      );
      return;
    }
    return next();
  });

  // Body limit: Nest's default express.json cap is 100kb, which 413s the
  // litellm price-catalog refresh (`POST /monitoring/cost/catalog` carries the
  // full multi-MB catalog from the platos.cost.refresh_model_prices task).
  // 15mb bounds it without being effectively unlimited. useBodyParser is the
  // platform-express API (a direct require("express") is NOT resolvable in
  // the pruned production image — crashed the boot).
  app.useBodyParser("json", { limit: "15mb" });
  app.useBodyParser("urlencoded", { extended: true, limit: "15mb" });

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
