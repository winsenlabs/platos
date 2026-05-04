/**
 * Vitest setup — stamps the minimum env vars `apps/agent/src/shared/env.ts`
 * requires so unit tests can run standalone. Real integration tests that
 * need a live database / redis / clickhouse override these via testcontainers
 * before importing the modules under test (per CLAUDE.md §9.11).
 *
 * If a real env var is already set (CI, docker compose), don't overwrite —
 * tests can opt into the real value by exporting before invoking vitest.
 */

const STUBS: Record<string, string> = {
  DATABASE_URL: "postgresql://test:test@localhost:5432/platos_test",
  REDIS_URL: "redis://localhost:6379",
  PLATOS_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  PLATOS_SESSION_SECRET: "test-session-secret-not-real-do-not-use-in-prod",
  // ScopeGuard tests use this exact value via `process.env.PLATOS_ADMIN_TOKEN = ...`
  // BUT env.ts caches its parse on first access (Proxy in env.ts:421), so
  // those late-set process.env mutations are no-ops. Pre-populate here so
  // the cached env matches what the tests expect, then test-internal
  // `process.env` writes are redundant-but-harmless.
  PLATOS_ADMIN_TOKEN: "admin-secret-for-test",
};

for (const [k, v] of Object.entries(STUBS)) {
  if (!process.env[k]) process.env[k] = v;
}
