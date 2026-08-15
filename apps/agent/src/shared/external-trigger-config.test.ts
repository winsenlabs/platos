import { describe, expect, it, vi } from "vitest";
import {
  configureExternalTriggerSdk,
  resolveExternalTriggerConfig,
  resolveExternalTriggerEndpoint,
} from "./external-trigger-config";
import { validateAgentEnv } from "./env";

describe("external Trigger configuration", () => {
  it("disables Trigger without configuration and never configures an implicit endpoint", () => {
    const configure = vi.fn();
    expect(configureExternalTriggerSdk({ configure }, {})).toEqual({ status: "disabled" });
    expect(configure).not.toHaveBeenCalled();
    expect(resolveExternalTriggerEndpoint({})).toBeNull();
  });

  it("accepts boot configuration with no Trigger values", () => {
    expect(
      validateAgentEnv({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://test:test@localhost:5432/platos_test",
        REDIS_URL: "redis://localhost:6379",
        PLATOS_ENCRYPTION_KEY:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        SESSION_SECRET: "test-session-secret-not-real-do-not-use-in-prod",
      }),
    ).toMatchObject({ ok: true });
  });

  it("honors an explicit non-Cloud self-hosted URL", () => {
    const configure = vi.fn();
    const source = {
      TRIGGER_API_URL: "https://trigger.internal.example/v1",
      TRIGGER_SECRET_KEY: "tr_dev_explicit",
    };

    expect(configureExternalTriggerSdk({ configure }, source)).toEqual({
      status: "configured",
      endpoint: source.TRIGGER_API_URL,
      accessToken: source.TRIGGER_SECRET_KEY,
    });
    expect(configure).toHaveBeenCalledWith({
      baseURL: source.TRIGGER_API_URL,
      accessToken: source.TRIGGER_SECRET_KEY,
    });
    expect(resolveExternalTriggerEndpoint(source)).toBe(source.TRIGGER_API_URL);
    configureExternalTriggerSdk({ configure }, source);
    expect(configure).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ TRIGGER_SECRET_KEY: "tr_dev_only" }, "TRIGGER_API_URL is missing"],
    [{ TRIGGER_API_URL: "https://trigger.example" }, "TRIGGER_SECRET_KEY is missing"],
    [
      { TRIGGER_API_URL: "file:///tmp/trigger", TRIGGER_SECRET_KEY: "tr_dev" },
      "must use http or https",
    ],
  ])("degrades incomplete config clearly without configuring the SDK", (source, message) => {
    const configure = vi.fn();
    const result = configureExternalTriggerSdk({ configure }, source);
    expect(result.status).toBe("incomplete");
    expect(result).toMatchObject({ message: expect.stringContaining(message) });
    expect(configure).not.toHaveBeenCalled();
  });

  it("classifies a secret without an endpoint as direct-dispatch configuration", () => {
    expect(resolveExternalTriggerConfig({ TRIGGER_SECRET_KEY: "tr_dev_only" })).toMatchObject({
      status: "incomplete",
      message: expect.stringContaining("dispatch direct"),
    });
  });
});
