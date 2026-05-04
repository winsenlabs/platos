import { defineConfig } from "vitest/config";

/**
 * Pre-launch hardening (LAUNCH-9 follow-up): provide the env vars
 * `apps/agent/src/shared/env.ts` validates eagerly with Zod. Without
 * these, any test path that touches an `env.*` getter triggers a
 * Zod validation error before the test logic runs — the failure
 * looks like a logic bug but is purely missing-env. Setup file
 * stamps the minimum-viable values once per worker so unit tests
 * can run standalone (without Docker / .env / CI secrets).
 *
 * Real integration tests that need Postgres/Redis/etc. ignore
 * these stubs and connect to testcontainers (per CLAUDE.md §9.11).
 */
export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
