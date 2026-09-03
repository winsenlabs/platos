import { describe, expect, it } from "vitest";

import { loadCoreApiConfiguration, renderStartupFailure } from "./load.js";
import { CORE_API_CONFIG_FIELDS } from "./schema.js";

const MINIMAL = { PLATOS_ENVIRONMENT: "test" } as const;

describe("startup configuration", () => {
  it("applies every declared default when only the required field is set", () => {
    const outcome = loadCoreApiConfiguration(MINIMAL);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual({
      environment: "test",
      host: "127.0.0.1",
      port: 3030,
      shutdownTimeoutMs: 10000,
      drainGraceMs: 0,
      requestIdHeader: "x-request-id",
      logLevel: "info",
      adminHealthToken: null,
    });
  });

  it("fails closed when the required field is absent", () => {
    const outcome = loadCoreApiConfiguration({});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics).toHaveLength(1);
    expect(outcome.diagnostics[0]?.field).toBe("PLATOS_ENVIRONMENT");
    expect(outcome.diagnostics[0]?.presented).toBe("absent");
  });

  it("reports every problem at once rather than the first", () => {
    const outcome = loadCoreApiConfiguration({
      PLATOS_ENVIRONMENT: "prod",
      PLATOS_CORE_API_PORT: "70000",
      PLATOS_LOG_LEVEL: "chatty",
      PLATOS_CORE_API_SHUTDOWN_TIMEOUT_MS: "-5",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics.map((entry) => entry.field).sort()).toEqual([
      "PLATOS_CORE_API_PORT",
      "PLATOS_CORE_API_SHUTDOWN_TIMEOUT_MS",
      "PLATOS_ENVIRONMENT",
      "PLATOS_LOG_LEVEL",
    ]);
  });

  it("rejects a numeric field that only starts with digits", () => {
    // `parseInt("8080oops")` is 8080. That is how a typo becomes a listener on a
    // port nobody expected, so the parse is strict.
    const outcome = loadCoreApiConfiguration({ ...MINIMAL, PLATOS_CORE_API_PORT: "8080oops" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics[0]?.problem).toContain("base-10 integer");
  });

  it("treats a whitespace-only value as absent so a blank variable takes the default", () => {
    const outcome = loadCoreApiConfiguration({ ...MINIMAL, PLATOS_CORE_API_HOST: "   " });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.host).toBe("127.0.0.1");
  });

  it("accepts port 0, which is how the executable evidence avoids a port race", () => {
    const outcome = loadCoreApiConfiguration({ ...MINIMAL, PLATOS_CORE_API_PORT: "0" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.port).toBe(0);
  });

  it("lower-cases the correlation header so lookup against Node's headers works", () => {
    const outcome = loadCoreApiConfiguration({ ...MINIMAL, PLATOS_CORE_API_REQUEST_ID_HEADER: "X-Correlation-Id" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.requestIdHeader).toBe("x-correlation-id");
  });
});

describe("startup diagnostics are redacted by classification, not by luck", () => {
  const SECRET = "hunter2-hunter2-hunter2";

  it("never renders a secret value, even though the field is named", () => {
    const outcome = loadCoreApiConfiguration({
      ...MINIMAL,
      // Fifteen characters: one short of the declared minimum, so it fails and
      // the failing VALUE is what the renderer must refuse to repeat.
      PLATOS_CORE_API_ADMIN_HEALTH_TOKEN: "short-token-123",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const text = renderStartupFailure(outcome.diagnostics);
    expect(text).toContain("PLATOS_CORE_API_ADMIN_HEALTH_TOKEN");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("short-token-123");
  });

  it("DOES render a non-secret value — the control proving redaction is selective", () => {
    // Without this, a renderer that printed nothing at all would pass the test
    // above and be indistinguishable from one that redacts correctly.
    const outcome = loadCoreApiConfiguration({ ...MINIMAL, PLATOS_CORE_API_PORT: "not-a-port" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const text = renderStartupFailure(outcome.diagnostics);
    expect(text).toContain("not-a-port");
    expect(text).not.toContain("[redacted]");
  });

  it("strips control characters so a hostile value cannot forge a log line", () => {
    const outcome = loadCoreApiConfiguration({
      ...MINIMAL,
      PLATOS_LOG_LEVEL: 'x"\n{"level":"info","message":"all good"}',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const text = renderStartupFailure(outcome.diagnostics);
    // Exactly the lines the renderer wrote: header, blank, one problem, blank,
    // footer. A forged newline would make it six.
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(5);
    // And the injected payload is inert text inside one line rather than a line
    // of its own, so a log reader cannot mistake it for an emitted record.
    expect(lines.some((line) => line.trimStart().startsWith("{"))).toBe(false);
    expect(text).toContain("\u{FFFD}");
  });

  it("truncates an unbounded value rather than logging a megabyte", () => {
    const outcome = loadCoreApiConfiguration({ ...MINIMAL, PLATOS_LOG_LEVEL: "z".repeat(5000) });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(renderStartupFailure(outcome.diagnostics).length).toBeLessThan(500);
  });

  it("a secret value supplied and valid never reaches a diagnostic at all", () => {
    const outcome = loadCoreApiConfiguration({
      PLATOS_ENVIRONMENT: "nonsense",
      PLATOS_CORE_API_ADMIN_HEALTH_TOKEN: SECRET,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(renderStartupFailure(outcome.diagnostics)).not.toContain(SECRET);
  });
});

describe("the schema itself", () => {
  it("declares exactly one secret field, so the redaction control is not vacuous", () => {
    expect(CORE_API_CONFIG_FIELDS.filter((field) => field.secret).map((field) => field.name)).toEqual([
      "PLATOS_CORE_API_ADMIN_HEALTH_TOKEN",
    ]);
  });

  it("gives every non-required field a default, so absence can never mean undefined", () => {
    for (const field of CORE_API_CONFIG_FIELDS) {
      if (field.required) continue;
      // The admin token is the one legitimate null: absent means "detail off".
      if (field.name === "PLATOS_CORE_API_ADMIN_HEALTH_TOKEN") continue;
      expect(field.defaultValue, field.name).not.toBeNull();
    }
  });
});
