import { describe, expect, it } from "vitest";

import {
  asAgentsIdentifier,
  DEFAULT_COMPACTION_MODEL,
  type AgentId,
  type ProviderKeyId,
  type RouteLabel,
} from "../domain/index.js";
import { describePins, resolveCompactionRoute, resolveRoute } from "./resolve-route.js";
import { buildAgentsTestContext, seedBoundAgent } from "./testing/fixtures.js";

function routes(entries: readonly { label: string; model: string; providerKeyId?: string | null; isDefault?: boolean }[]) {
  return entries.map((entry) => ({
    label: asAgentsIdentifier<RouteLabel>(entry.label),
    model: entry.model,
    providerKeyId:
      entry.providerKeyId === undefined || entry.providerKeyId === null
        ? null
        : asAgentsIdentifier<ProviderKeyId>(entry.providerKeyId),
    isDefault: entry.isDefault === true,
  }));
}

function newContext(source: Record<string, unknown> = {}) {
  const context = buildAgentsTestContext();
  const authorization = context.tenancy.grant();
  const seeded = seedBoundAgent(context, { source });
  return { context, authorization, seeded };
}

describe("selecting a route", () => {
  it("takes the default route when no label is asked for", async () => {
    const { context, authorization, seeded } = newContext({
      modelRoutes: routes([
        { label: "slow", model: "openai:gpt-5" },
        { label: "fast", model: "openai:gpt-5-mini", isDefault: true },
      ]),
    });
    const resolved = await resolveRoute(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
    });
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value).toEqual({
      label: "fast",
      model: "openai:gpt-5-mini",
      provider: "openai",
      providerKeyId: null,
      credentialName: null,
    });
  });

  it("takes a labelled route", async () => {
    const { context, authorization, seeded } = newContext({
      modelRoutes: routes([{ label: "slow", model: "openai:gpt-5", isDefault: true }, { label: "fast", model: "anthropic:haiku" }]),
    });
    const resolved = await resolveRoute(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      label: " fast ",
    });
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.model).toBe("anthropic:haiku");
    expect(resolved.value.provider).toBe("anthropic");
  });

  it("refuses a label the table does not carry", async () => {
    const { context, authorization, seeded } = newContext({
      modelRoutes: routes([{ label: "slow", model: "openai:gpt-5", isDefault: true }]),
    });
    const resolved = await resolveRoute(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      label: "fast",
    });
    if (resolved.ok) throw new Error("unreachable");
    expect(resolved.error.code).toBe("AGENTS_ROUTE_NOT_FOUND");
  });

  it("falls back to the version's own model when there is no routing table", async () => {
    const { context, authorization, seeded } = newContext({ model: "openai:gpt-5" });
    const resolved = await resolveRoute(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
    });
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value).toEqual({
      label: null,
      model: "openai:gpt-5",
      provider: "openai",
      providerKeyId: null,
      credentialName: null,
    });
  });

  it("REFUSES a named label against an agent with no routing table", async () => {
    // Asking for `fast` and being silently served the default is worse than
    // being told there is no `fast`.
    const { context, authorization, seeded } = newContext({ model: "openai:gpt-5" });
    const resolved = await resolveRoute(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      label: "fast",
    });
    if (resolved.ok) throw new Error("unreachable");
    expect(resolved.error.code).toBe("AGENTS_ROUTE_NOT_FOUND");
  });

  it("resolves an unqualified model to the default provider", async () => {
    const { context, authorization, seeded } = newContext({ model: "claude-sonnet-4-6" });
    const resolved = await resolveRoute(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
    });
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.provider).toBe("anthropic");
  });
});

describe("the pinned provider key is resolved by `providers`", () => {
  it("asks providers, and reports the credential name it answers with", async () => {
    const { context, authorization, seeded } = newContext({
      modelRoutes: routes([{ label: "fast", model: "openai:gpt-5", providerKeyId: "key-1", isDefault: true }]),
    });
    context.providers.seed({ providerKeyId: "key-1", provider: "openai", credentialName: "OPENAI_API_KEY" });
    const resolved = await resolveRoute(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
    });
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.credentialName).toBe("OPENAI_API_KEY");
    expect(context.providers.lookups).toEqual(["key-1"]);
  });

  it("FAILS CLOSED when the pinned key does not resolve", async () => {
    const { context, authorization, seeded } = newContext({
      modelRoutes: routes([{ label: "fast", model: "openai:gpt-5", providerKeyId: "key-gone", isDefault: true }]),
    });
    const resolved = await resolveRoute(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
    });
    if (resolved.ok) throw new Error("unreachable");
    expect(resolved.error.code).toBe("AGENTS_PROVIDER_KEY_UNAVAILABLE");
    expect(resolved.error.details["reason"]).toBe("unresolved");
  });

  it("FAILS CLOSED when the key belongs to a DIFFERENT provider", async () => {
    // The alternative — silently falling back to the environment's default key —
    // bills a different customer's credential for the turn.
    const { context, authorization, seeded } = newContext({
      modelRoutes: routes([{ label: "fast", model: "openai:gpt-5", providerKeyId: "key-1", isDefault: true }]),
    });
    context.providers.seed({ providerKeyId: "key-1", provider: "anthropic", credentialName: "ANTHROPIC_API_KEY" });
    const resolved = await resolveRoute(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
    });
    if (resolved.ok) throw new Error("unreachable");
    expect(resolved.error.details["reason"]).toBe("provider-mismatch");
  });

  it("does not leak the providers error code across the boundary", async () => {
    const { context, authorization, seeded } = newContext({
      modelRoutes: routes([{ label: "fast", model: "openai:gpt-5", providerKeyId: "key-gone", isDefault: true }]),
    });
    const resolved = await resolveRoute(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
    });
    if (resolved.ok) throw new Error("unreachable");
    expect(resolved.error.code.startsWith("AGENTS_")).toBe(true);
  });

  it("resolves the VERSION-level pin when there is no routing table", async () => {
    const { context, authorization, seeded } = newContext({
      model: "openai:gpt-5",
      providerKeyId: "key-1",
    });
    context.providers.seed({ providerKeyId: "key-1", provider: "openai", credentialName: "OPENAI_API_KEY" });
    const resolved = await resolveRoute(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
    });
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.providerKeyId).toBe("key-1");
  });

  it("asks providers NOTHING when no key is pinned", async () => {
    const { context, authorization, seeded } = newContext({ model: "openai:gpt-5" });
    await resolveRoute(context.dependencies, { authorization, agentId: seeded.agent.agentId });
    expect(context.providers.lookups).toEqual([]);
  });
});

describe("the compaction route", () => {
  it("takes the reserved label when the agent defines it", async () => {
    const { context, authorization, seeded } = newContext({
      modelRoutes: routes([{ label: "compaction", model: "anthropic:haiku-cheap" }]),
    });
    const resolved = await resolveCompactionRoute(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
    });
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.model).toBe("anthropic:haiku-cheap");
    expect(resolved.value.label).toBe("compaction");
  });

  it("FALLS BACK to the default summarisation model rather than failing", async () => {
    const { context, authorization, seeded } = newContext({
      modelRoutes: routes([{ label: "fast", model: "openai:gpt-5", isDefault: true }]),
    });
    const resolved = await resolveCompactionRoute(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
    });
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.model).toBe(DEFAULT_COMPACTION_MODEL);
    expect(resolved.value.label).toBeNull();
  });

  it("resolves a key pinned on the compaction route", async () => {
    const { context, authorization, seeded } = newContext({
      modelRoutes: routes([{ label: "compaction", model: "anthropic:haiku", providerKeyId: "key-1" }]),
    });
    context.providers.seed({ providerKeyId: "key-1", provider: "anthropic", credentialName: "ANTHROPIC_API_KEY" });
    const resolved = await resolveCompactionRoute(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
    });
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.credentialName).toBe("ANTHROPIC_API_KEY");
  });
});

describe("describing the pins", () => {
  it("reads both places a pin can live", async () => {
    const { context, authorization, seeded } = newContext({
      model: "openai:gpt-5",
      providerKeyId: "key-version",
      modelRoutes: routes([{ label: "fast", model: "anthropic:haiku", providerKeyId: "key-route" }]),
    });
    const described = await describePins(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
    });
    if (!described.ok) throw new Error("unreachable");
    expect(described.value).toEqual([
      { providerKeyId: "key-version", provider: "openai", label: null },
      { providerKeyId: "key-route", provider: "anthropic", label: "fast" },
    ]);
  });

  it("answers empty for an agent that pins nothing", async () => {
    const { context, authorization, seeded } = newContext({ model: "openai:gpt-5" });
    const described = await describePins(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
    });
    if (!described.ok) throw new Error("unreachable");
    expect(described.value).toEqual([]);
  });

  it("refuses an agent this environment cannot see", async () => {
    const { context, authorization } = newContext();
    expect(
      (await describePins(context.dependencies, { authorization, agentId: asAgentsIdentifier<AgentId>("nope") })).ok,
    ).toBe(false);
  });
});
