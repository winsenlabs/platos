/**
 * Vitest setup — stamps the minimum env vars `apps/agent/src/shared/env.ts`
 * requires so unit tests can run standalone. Real integration tests that
 * need a live database / redis / clickhouse override these via testcontainers
 * before importing the modules under test (per CLAUDE.md §9.11).
 *
 * If a real env var is already set (CI, docker compose), don't overwrite —
 * tests can opt into the real value by exporting before invoking vitest.
 */

// Repository deployment secrets can be exported into the sandbox. Unit tests
// must never parse those values as a production deployment configuration.
process.env.NODE_ENV = "test";

const STUBS: Record<string, string> = {
  DATABASE_URL: "postgresql://test:test@localhost:5432/platos_test",
  REDIS_URL: "redis://localhost:6379",
  PLATOS_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  PLATOS_CREDENTIAL_ROOT_KEY_VERSION: "1",
  PLATOS_CREDENTIAL_ROOT_KEYS: JSON.stringify({ "1": "33".repeat(32) }),
  ENCRYPTION_KEY: "1111111111111111111111111111111111111111111111111111111111111111",
  PLATOS_MESSAGE_ENCRYPTION_KEY: "2222222222222222222222222222222222222222222222222222222222222222",
  SESSION_SECRET: "test-session-secret-not-real-do-not-use-in-prod",
  // ScopeGuard tests use this exact value via `process.env.PLATOS_INTERNAL_AUTH_TOKEN = ...`
  // BUT env.ts caches its parse on first access (Proxy in env.ts:421), so
  // those late-set process.env mutations are no-ops. Pre-populate here so
  // the cached env matches what the tests expect, then test-internal
  // `process.env` writes are redundant-but-harmless.
  PLATOS_INTERNAL_AUTH_TOKEN: "admin-secret-for-test",
};

for (const [k, v] of Object.entries(STUBS)) {
  if (
    !process.env[k] ||
    [
      "PLATOS_ENCRYPTION_KEY",
      "PLATOS_CREDENTIAL_ROOT_KEY_VERSION",
      "PLATOS_CREDENTIAL_ROOT_KEYS",
      "ENCRYPTION_KEY",
      "PLATOS_MESSAGE_ENCRYPTION_KEY",
      "PLATOS_INTERNAL_AUTH_TOKEN",
    ].includes(k)
  ) {
    process.env[k] = v;
  }
}
