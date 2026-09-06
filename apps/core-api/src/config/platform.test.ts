// The whole-platform configuration contract, and every way it refuses.
//
// The cases below are the falsifiability surface for WIN-260's second acceptance
// clause — "refusing to boot on a missing or malformed value rather than failing
// at first use". `process.test.ts` proves the same property against the BUILT
// binary and a real exit code; these prove it against the function, which is
// where the individual refusals can each be named.

import { afterEach, describe, expect, it } from "vitest";

import { readProcessEnvironment } from "./environment.js";
import { renderStartupFailure } from "./load.js";
import { loadPlatformConfiguration, platformFieldNames, PLATFORM_SECTIONS } from "./platform.js";

/** The smallest environment this process boots on. Everything else is optional. */
const MINIMAL = { PLATOS_ENVIRONMENT: "test" } as const;

const POSTGRES = "postgresql://platos:secret-password@db.internal:5432/platos_control";
const ROOT_KEY = "a".repeat(64);

// The declared reader itself. Both of its promises need a case, and both cases
// have to touch the ambient environment to make them — which is why this file is
// declared as `test-support` in `scripts/arch/env-access.mjs` with an exact pin
// of one read, rather than exempted for being a test.
describe("the one declared environment reader", () => {
  const PROBE = "PLATOS_ENV_SNAPSHOT_PROBE";
  // eslint-disable-next-line no-restricted-syntax -- the pinned read; see above.
  const ambient = process.env;

  afterEach(() => {
    delete ambient[PROBE];
  });

  it("returns a SNAPSHOT, so a later change to the environment cannot alter what booted", () => {
    ambient[PROBE] = "before";
    const snapshot = readProcessEnvironment();
    ambient[PROBE] = "after";
    expect(snapshot[PROBE]).toBe("before");
  });

  it("returns a FROZEN object, so nothing downstream can edit the configuration input", () => {
    const snapshot = readProcessEnvironment();
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("carries the ambient values through, so the snapshot is not merely empty", () => {
    // Without this, a reader that returned `Object.freeze({})` would satisfy
    // both cases above and starve every section of its configuration.
    ambient[PROBE] = "carried";
    expect(readProcessEnvironment()[PROBE]).toBe("carried");
  });
});

describe("a process with nothing wired", () => {
  it("boots, and every section reports its groups as absent rather than defaulted", () => {
    const outcome = loadPlatformConfiguration(MINIMAL);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stores).toEqual({
      postgres: null,
      redis: null,
      clickhouse: null,
      objectstore: null,
    });
    expect(outcome.value.providers.modelRouter).toBeNull();
    expect(outcome.value.channels.slack).toBeNull();
    expect(outcome.value.durable.durableRuntime).toBeNull();
    expect(outcome.value.security.session).toBeNull();
    expect(outcome.value.declaredGroups).toEqual([]);
  });

  it("still carries the core section, so the process knows how to be a process", () => {
    const outcome = loadPlatformConfiguration(MINIMAL);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.core.environment).toBe("test");
    expect(outcome.value.core.port).toBe(3030);
  });
});

describe("a declared group", () => {
  it("fills its own defaults and names itself in declaredGroups", () => {
    const outcome = loadPlatformConfiguration({ ...MINIMAL, PLATOS_STORE_POSTGRES_URL: POSTGRES });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stores.postgres).toEqual({
      url: POSTGRES,
      poolMax: 10,
      statementTimeoutMs: 15000,
      schema: "public",
    });
    expect(outcome.value.declaredGroups).toEqual(["stores.postgres"]);
    // Declaring one group must not declare its neighbours.
    expect(outcome.value.stores.redis).toBeNull();
  });

  it("treats a BLANK anchor as absent rather than as a declaration", () => {
    // A compose file that interpolates an unset variable writes an empty string,
    // not nothing. If blank declared the group, every such install would be told
    // its required members were missing — a startup refusal caused by a variable
    // the operator never set.
    const outcome = loadPlatformConfiguration({
      ...MINIMAL,
      PLATOS_STORE_CLICKHOUSE_URL: "   ",
      PLATOS_DURABLE_RUNTIME_API_URL: "",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.declaredGroups).toEqual([]);
    expect(outcome.value.stores.clickhouse).toBeNull();
  });

  it("leaves the other three store groups absent when only one is declared", () => {
    const outcome = loadPlatformConfiguration({ ...MINIMAL, PLATOS_STORE_REDIS_URL: "rediss://cache.internal:6380" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stores.redis?.keyPrefix).toBe("platos");
    expect(outcome.value.stores.redis?.tls).toBe(false);
    expect(outcome.value.stores.postgres).toBeNull();
    expect(outcome.value.stores.clickhouse).toBeNull();
    expect(outcome.value.stores.objectstore).toBeNull();
  });
});

describe("INCOMPLETE — an anchor with a required member missing", () => {
  it("refuses a ClickHouse endpoint with no database name", () => {
    const outcome = loadPlatformConfiguration({
      ...MINIMAL,
      PLATOS_STORE_CLICKHOUSE_URL: "https://clickhouse.internal:8123",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics.map((entry) => entry.field)).toEqual(["PLATOS_STORE_CLICKHOUSE_DATABASE"]);
    expect(outcome.diagnostics[0]?.problem).toContain("is required once PLATOS_STORE_CLICKHOUSE_URL is set");
  });

  it("refuses a durable endpoint with no key, naming the key and not the endpoint", () => {
    const outcome = loadPlatformConfiguration({
      ...MINIMAL,
      PLATOS_DURABLE_RUNTIME_API_URL: "https://durable.internal",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics.map((entry) => entry.field)).toEqual(["PLATOS_DURABLE_RUNTIME_SECRET_KEY"]);
  });

  it("names all three missing object-store members at once, not just the first", () => {
    const outcome = loadPlatformConfiguration({
      ...MINIMAL,
      PLATOS_STORE_OBJECT_ENDPOINT: "https://minio.internal:9000",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics.map((entry) => entry.field).sort()).toEqual([
      "PLATOS_STORE_OBJECT_ACCESS_KEY_ID",
      "PLATOS_STORE_OBJECT_BUCKET",
      "PLATOS_STORE_OBJECT_SECRET_ACCESS_KEY",
    ]);
  });

  it("refuses an encryption root with no version stamped beside it", () => {
    const outcome = loadPlatformConfiguration({ ...MINIMAL, PLATOS_SECURITY_ENCRYPTION_KEY: ROOT_KEY });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics.map((entry) => entry.field)).toEqual(["PLATOS_SECURITY_ENCRYPTION_KEY_VERSION"]);
  });
});

describe("ORPHANED — a member set with no anchor", () => {
  // This is the case the anchor exists for. Under any scheme that judges fields
  // independently, every environment below validates, boots, and wires nothing.
  it("refuses a bucket name with no endpoint", () => {
    const outcome = loadPlatformConfiguration({ ...MINIMAL, PLATOS_STORE_OBJECT_BUCKET: "platos-media" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics.map((entry) => entry.field)).toEqual(["PLATOS_STORE_OBJECT_BUCKET"]);
    expect(outcome.diagnostics[0]?.problem).toContain("is set but PLATOS_STORE_OBJECT_ENDPOINT is not");
  });

  it("refuses a pool size with no database", () => {
    const outcome = loadPlatformConfiguration({ ...MINIMAL, PLATOS_STORE_POSTGRES_POOL_MAX: "40" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics.map((entry) => entry.field)).toEqual(["PLATOS_STORE_POSTGRES_POOL_MAX"]);
  });

  it("refuses a session cookie name with no session secret", () => {
    const outcome = loadPlatformConfiguration({ ...MINIMAL, PLATOS_SECURITY_SESSION_COOKIE_NAME: "sid" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics.map((entry) => entry.field)).toEqual(["PLATOS_SECURITY_SESSION_COOKIE_NAME"]);
  });

  it("never echoes the orphaned value back, even for a field that is not a secret", () => {
    const outcome = loadPlatformConfiguration({ ...MINIMAL, PLATOS_STORE_OBJECT_BUCKET: "platos-media" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics[0]?.shownValue).toBeNull();
    expect(renderStartupFailure(outcome.diagnostics)).not.toContain("platos-media");
  });
});

describe("MALFORMED — an ordinary field failure", () => {
  it("refuses a database URL whose scheme is not a PostgreSQL one", () => {
    const outcome = loadPlatformConfiguration({
      ...MINIMAL,
      PLATOS_STORE_POSTGRES_URL: "mysql://platos:secret-password@db.internal:3306/platos",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics[0]?.problem).toContain("postgres:, postgresql:");
  });

  it("refuses a value that is a host rather than a URL", () => {
    const outcome = loadPlatformConfiguration({ ...MINIMAL, PLATOS_STORE_OBJECT_ENDPOINT: "minio.internal:9000" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // "minio.internal:9000" parses as a URL with scheme `minio.internal:`, which
    // is why the scheme list and not the parser is what catches it.
    expect(outcome.diagnostics.map((entry) => entry.field)).toContain("PLATOS_STORE_OBJECT_ENDPOINT");
  });

  it("refuses an unqualified default model", () => {
    const outcome = loadPlatformConfiguration({ ...MINIMAL, PLATOS_PROVIDERS_DEFAULT_MODEL: "claude-haiku-4-5" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics[0]?.problem).toContain("vendor-qualified");
  });

  it("refuses a 63-character encryption root — a short key is a typo, not a weak key", () => {
    const outcome = loadPlatformConfiguration({
      ...MINIMAL,
      PLATOS_SECURITY_ENCRYPTION_KEY: "a".repeat(63),
      PLATOS_SECURITY_ENCRYPTION_KEY_VERSION: "1",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics.map((entry) => entry.field)).toEqual(["PLATOS_SECURITY_ENCRYPTION_KEY"]);
  });

  it("refuses a 64-character root that is not hexadecimal", () => {
    const outcome = loadPlatformConfiguration({
      ...MINIMAL,
      PLATOS_SECURITY_ENCRYPTION_KEY: `${"a".repeat(63)}z`,
      PLATOS_SECURITY_ENCRYPTION_KEY_VERSION: "1",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics[0]?.problem).toContain("64 hexadecimal");
  });

  it("refuses a boolean spelled any way but true or false", () => {
    const outcome = loadPlatformConfiguration({
      ...MINIMAL,
      PLATOS_STORE_REDIS_URL: "redis://cache.internal:6379",
      PLATOS_STORE_REDIS_TLS: "yes",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics[0]?.problem).toContain("exactly true or false");
  });

  it("refuses a cookie name carrying a character the header grammar forbids", () => {
    const outcome = loadPlatformConfiguration({
      ...MINIMAL,
      PLATOS_SECURITY_SESSION_SECRET: "s".repeat(32),
      PLATOS_SECURITY_SESSION_COOKIE_NAME: "platos session",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics.map((entry) => entry.field)).toEqual(["PLATOS_SECURITY_SESSION_COOKIE_NAME"]);
  });

  it("names a malformed value in a group nobody declared", () => {
    // The group is absent, so nothing will read it — and the value is still
    // wrong, and the operator still wants to know before they set the anchor.
    const outcome = loadPlatformConfiguration({ ...MINIMAL, PLATOS_STORE_POSTGRES_POOL_MAX: "many" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics.map((entry) => entry.problem)).toContain("must be a base-10 integer");
  });
});

describe("every problem at once, across sections", () => {
  it("reports a core failure and a store failure and a security failure together", () => {
    const outcome = loadPlatformConfiguration({
      PLATOS_ENVIRONMENT: "prod",
      PLATOS_STORE_CLICKHOUSE_URL: "https://clickhouse.internal:8123",
      PLATOS_SECURITY_SESSION_SECRET: "too-short",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics.map((entry) => entry.field).sort()).toEqual([
      "PLATOS_ENVIRONMENT",
      "PLATOS_SECURITY_SESSION_SECRET",
      "PLATOS_STORE_CLICKHOUSE_DATABASE",
    ]);
  });

  it("does not let a core failure suppress the sections below it", () => {
    // The core loader returns early on its own diagnostics. If the platform
    // loader did the same, five sections' worth of problems would be discovered
    // one restart at a time.
    const broken = loadPlatformConfiguration({ PLATOS_STORE_OBJECT_BUCKET: "platos-media" });
    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.diagnostics.map((entry) => entry.field).sort()).toEqual([
      "PLATOS_ENVIRONMENT",
      "PLATOS_STORE_OBJECT_BUCKET",
    ]);
  });
});

describe("secrets never appear in a startup failure", () => {
  it("refuses the durable key by length without repeating it", () => {
    const key = "hunter2-key";
    const outcome = loadPlatformConfiguration({
      ...MINIMAL,
      PLATOS_DURABLE_RUNTIME_API_URL: "https://durable.internal",
      PLATOS_DURABLE_RUNTIME_SECRET_KEY: key,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const rendered = renderStartupFailure(outcome.diagnostics);
    expect(rendered).toContain("PLATOS_DURABLE_RUNTIME_SECRET_KEY");
    expect(rendered).toContain("[redacted]");
    expect(rendered).not.toContain(key);
  });

  it("refuses a malformed connection string without repeating its password", () => {
    const outcome = loadPlatformConfiguration({
      ...MINIMAL,
      PLATOS_STORE_POSTGRES_URL: "mysql://platos:hunter2-the-password@db.internal:3306/platos",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(renderStartupFailure(outcome.diagnostics)).not.toContain("hunter2-the-password");
  });

  it("echoes a NON-secret bad value, so the redaction proof is not vacuous", () => {
    const outcome = loadPlatformConfiguration({
      ...MINIMAL,
      PLATOS_STORE_CLICKHOUSE_URL: "https://clickhouse.internal:8123",
      PLATOS_STORE_CLICKHOUSE_DATABASE: "spans",
      PLATOS_STORE_CLICKHOUSE_TIMEOUT_MS: "eventually",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(renderStartupFailure(outcome.diagnostics)).toContain('"eventually"');
  });
});

describe("a fully wired install", () => {
  const FULL = {
    ...MINIMAL,
    PLATOS_STORE_POSTGRES_URL: POSTGRES,
    PLATOS_STORE_POSTGRES_POOL_MAX: "40",
    PLATOS_STORE_REDIS_URL: "rediss://cache.internal:6380",
    PLATOS_STORE_REDIS_TLS: "true",
    PLATOS_STORE_CLICKHOUSE_URL: "https://clickhouse.internal:8123",
    PLATOS_STORE_CLICKHOUSE_DATABASE: "spans",
    PLATOS_STORE_OBJECT_ENDPOINT: "https://minio.internal:9000",
    PLATOS_STORE_OBJECT_BUCKET: "platos-media",
    PLATOS_STORE_OBJECT_ACCESS_KEY_ID: "platos-minio-admin",
    PLATOS_STORE_OBJECT_SECRET_ACCESS_KEY: "platos-minio-password",
    PLATOS_PROVIDERS_DEFAULT_MODEL: "anthropic:claude-haiku-4-5-20251001",
    PLATOS_CHANNELS_SLACK_SIGNING_SECRET: "c".repeat(32),
    PLATOS_CHANNELS_EMAIL_SMTP_URL: "smtps://relay.internal:465",
    PLATOS_CHANNELS_EMAIL_FROM: "alerts@platos.example",
    PLATOS_CHANNELS_WEBHOOK_SIGNING_KEY: "w".repeat(32),
    PLATOS_DURABLE_RUNTIME_API_URL: "https://durable.internal",
    PLATOS_DURABLE_RUNTIME_SECRET_KEY: "d".repeat(24),
    PLATOS_SECURITY_SESSION_SECRET: "s".repeat(32),
    PLATOS_SECURITY_ENCRYPTION_KEY: ROOT_KEY,
    PLATOS_SECURITY_ENCRYPTION_KEY_VERSION: "3",
  } as const;

  it("declares all ten groups", () => {
    const outcome = loadPlatformConfiguration(FULL);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.declaredGroups).toEqual([
      "stores.postgres",
      "stores.redis",
      "stores.clickhouse",
      "stores.objectstore",
      "providers.modelRouter",
      "channels.slack",
      "channels.emailNotifier",
      "channels.webhookNotifier",
      "durableRuntime.durableRuntime",
      "security.session",
      "security.encryption",
    ]);
  });

  it("parses each value into its declared type rather than leaving it a string", () => {
    const outcome = loadPlatformConfiguration(FULL);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stores.postgres?.poolMax).toBe(40);
    expect(outcome.value.stores.redis?.tls).toBe(true);
    expect(outcome.value.security.encryption?.rootKeyVersion).toBe(3);
    expect(outcome.value.security.session?.cookieSecure).toBe(true);
    expect(outcome.value.security.session?.sameSite).toBe("lax");
    expect(outcome.value.providers.modelRouter?.embeddingModel).toBeNull();
  });

  it("freezes what it returns, so nothing downstream can edit the contract", () => {
    const outcome = loadPlatformConfiguration(FULL);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(Object.isFrozen(outcome.value)).toBe(true);
    expect(Object.isFrozen(outcome.value.stores)).toBe(true);
    expect(Object.isFrozen(outcome.value.stores.postgres)).toBe(true);
  });
});

describe("the section tables themselves", () => {
  it("declares five sibling sections beside the core one", () => {
    expect(PLATFORM_SECTIONS.map((section) => section.id)).toEqual([
      "stores",
      "providers",
      "channels",
      "durableRuntime",
      "security",
    ]);
  });

  it("names every variable exactly once across all five", () => {
    const names = platformFieldNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it("carries no variable the core section already owns", () => {
    // A name declared twice would be validated twice, under two different rules,
    // and the last assembler to read it would win silently.
    const core = new Set(["PLATOS_ENVIRONMENT", "PLATOS_LOG_LEVEL"]);
    for (const name of platformFieldNames()) expect(core.has(name)).toBe(false);
  });
});
