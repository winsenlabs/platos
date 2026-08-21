import * as Sentry from "@sentry/remix";

// Webapp telemetry is intentionally server-only, production-only, optional,
// and PII-free. Self-hosted deployments without SENTRY_DSN remain no-op.
if (process.env.NODE_ENV === "production" && process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    release: process.env.SENTRY_RELEASE ?? process.env.BUILD_GIT_SHA,
    sendDefaultPii: false,
    skipOpenTelemetrySetup: true,
    registerEsmLoaderHooks: false,
    disableInstrumentationWarnings: true,
    maxBreadcrumbs: 0,
    shutdownTimeout: 10,
    serverName: process.env.SERVICE_NAME ?? "platos-webapp",
    environment: process.env.APP_ENV ?? process.env.NODE_ENV,
    ignoreErrors: ["queryRoute() call aborted"],
    includeLocalVariables: false,
  });
}
