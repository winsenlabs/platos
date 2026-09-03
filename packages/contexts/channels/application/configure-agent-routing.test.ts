import { describe, expect, it } from "vitest";

import { configureAppRouting, configureConnectionRouting } from "./configure-agent-routing.js";
import { buildApp, buildChannelsTestContext, buildConnection, testEnvironmentScope } from "./testing/index.js";

const scope = testEnvironmentScope();

function rule(agentId: string, channelId = "C1") {
  return { match: { type: "channel", id: channelId }, agentId };
}

describe("configureConnectionRouting", () => {
  it("normalizes and stores a valid table", async () => {
    const context = buildChannelsTestContext();
    context.repository.seedConnection(buildConnection());
    context.agents.register("env-1", "a1");

    const result = await configureConnectionRouting(context.dependencies, {
      scope,
      connectionId: buildConnection().connectionId,
      agentRouting: [{ match: { type: "prefix", value: "AdA" }, agentId: " a1 " }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.agentRouting).toEqual([{ match: { type: "prefix", value: "ada" }, agentId: "a1" }]);
  });

  it("REJECTS a rule naming an agent outside the environment", async () => {
    // The forged-id guard. Checked at WRITE time so the stored table can never
    // point at another tenant's agent, and the read path never has to ask.
    const context = buildChannelsTestContext();
    context.repository.seedConnection(buildConnection());
    context.agents.register("env-1", "a1");

    const result = await configureConnectionRouting(context.dependencies, {
      scope,
      connectionId: buildConnection().connectionId,
      agentRouting: [rule("a1"), rule("intruder", "C2")],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_ROUTING_AGENT_UNKNOWN");
    expect(result.error.message).toContain("intruder");
  });

  it("does not store anything when the guard rejects", async () => {
    const context = buildChannelsTestContext();
    const seeded = context.repository.seedConnection(buildConnection());

    await configureConnectionRouting(context.dependencies, {
      scope,
      connectionId: seeded.connectionId,
      agentRouting: [rule("intruder")],
    });

    expect(context.repository.connections.get(seeded.connectionId)?.agentRouting).toEqual([]);
  });

  it("names EVERY unknown id, not just the first", async () => {
    const context = buildChannelsTestContext();
    context.repository.seedConnection(buildConnection());
    context.agents.register("env-1", "a1");

    const result = await configureConnectionRouting(context.dependencies, {
      scope,
      connectionId: buildConnection().connectionId,
      agentRouting: [rule("ghost-1"), rule("a1", "C2"), rule("ghost-2", "C3")],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("ghost-1");
    expect(result.error.message).toContain("ghost-2");
  });

  it("skips the directory entirely for an empty table", async () => {
    const context = buildChannelsTestContext();
    context.repository.seedConnection(buildConnection());

    // The directory denies by default; an empty table must still succeed,
    // which proves the round trip is skipped rather than merely tolerated.
    const result = await configureConnectionRouting(context.dependencies, {
      scope,
      connectionId: buildConnection().connectionId,
      agentRouting: [],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a malformed table before consulting the directory", async () => {
    const context = buildChannelsTestContext();
    context.repository.seedConnection(buildConnection());

    const result = await configureConnectionRouting(context.dependencies, {
      scope,
      connectionId: buildConnection().connectionId,
      agentRouting: "not an array",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_ROUTING_INVALID");
  });

  it("fails for a connection that is not visible in this scope", async () => {
    const context = buildChannelsTestContext();
    context.repository.seedConnection(buildConnection({ scope: testEnvironmentScope("other-env") }));

    const result = await configureConnectionRouting(context.dependencies, {
      scope,
      connectionId: buildConnection().connectionId,
      agentRouting: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_CONNECTION_NOT_FOUND");
  });

  it("checks the guard against the CONNECTION's environment", async () => {
    const context = buildChannelsTestContext();
    context.repository.seedConnection(buildConnection());
    // Registered in a different environment: must not satisfy the guard.
    context.agents.register("other-env", "a1");

    const result = await configureConnectionRouting(context.dependencies, {
      scope,
      connectionId: buildConnection().connectionId,
      agentRouting: [rule("a1")],
    });
    expect(result.ok).toBe(false);
  });
});

describe("configureAppRouting", () => {
  it("stores a valid table on an app", async () => {
    const context = buildChannelsTestContext();
    context.repository.seedApp(buildApp());
    context.agents.register("env-1", "a1");

    const result = await configureAppRouting(context.dependencies, {
      scope,
      appId: buildApp().appId,
      agentRouting: [rule("a1")],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.agentRouting).toHaveLength(1);
  });

  it("applies the same forged-id guard as the connection surface", async () => {
    const context = buildChannelsTestContext();
    context.repository.seedApp(buildApp());

    const result = await configureAppRouting(context.dependencies, {
      scope,
      appId: buildApp().appId,
      agentRouting: [rule("intruder")],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_ROUTING_AGENT_UNKNOWN");
  });

  it("fails for an app that is not visible in this scope", async () => {
    const context = buildChannelsTestContext();
    const result = await configureAppRouting(context.dependencies, {
      scope,
      appId: buildApp().appId,
      agentRouting: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_APP_NOT_FOUND");
  });
});
