import { asIdentifier, type EntityId } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asToolsIdentifier,
  END_USER_TOKEN,
  PLATFORM_TIER_MINIMUMS,
  SECRET_TOKEN,
  type AgentId,
  type AgentVersionId,
  type CredentialName,
  type EndUserId,
  type EntityMcpClient,
  type ExposureId,
  type ExternalEntityId,
  type ToolId,
  type ToolName,
} from "../domain/index.js";
import { executeTool } from "./execute-tool.js";
import { resolvePermission } from "./resolve-permission.js";
import { resolveDispatchTarget, subjectOf } from "./resolve-transport.js";
import {
  buildToolsTestContext,
  testExposure,
  testVaultAuthorization,
  type ToolsTestContext,
} from "./testing/index.js";

const ENTITY = asIdentifier<EntityId>("entity-pk-1");
const AGENT = asToolsIdentifier<AgentId>("agent-1");
const UPLOAD = asToolsIdentifier<ToolName>("files.upload");
const VAULT = testVaultAuthorization();

let context: ToolsTestContext;

beforeEach(() => {
  context = buildToolsTestContext();
  context.repository.seedExposure(testExposure(context.scope, { entityId: ENTITY }));
  context.repository.seedBindings([
    { agentId: AGENT, agentVersionId: asToolsIdentifier<AgentVersionId>("version-1"), defaultPolicy: "ALL", policies: [] },
  ]);
});

function execute(overrides: Record<string, unknown> = {}) {
  return executeTool(context.dependencies, {
    scope: context.scope,
    toolName: UPLOAD,
    arguments: { path: "/a" },
    agentId: AGENT,
    threadId: null,
    endUserId: null,
    vaultAuthorization: VAULT,
    ...overrides,
  } as Parameters<typeof executeTool>[1]);
}

describe("a call that goes through", () => {
  it("reaches the backend and comes back with the result", async () => {
    const executed = await execute();
    expect(executed.ok && executed.value.kind).toBe("completed");
    expect(context.dispatch.requests).toHaveLength(1);
    expect(context.dispatch.requests[0]?.arguments).toEqual({ path: "/a" });
  });

  it("writes exactly one audit row, with the tool and the scope on it", async () => {
    await execute();
    expect(context.repository.audit).toHaveLength(1);
    expect(context.repository.audit[0]?.toolName).toBe(UPLOAD);
    expect(context.repository.audit[0]?.status).toBe("SUCCEEDED");
    expect(context.repository.audit[0]?.environmentId).toBe(context.scope.environmentId);
  });

  /**
   * THE COLUMN IS `Decimal(18, 6)` AND THE FIELD IS A STRING OR NOTHING.
   *
   * `finish` writes `costCents: null` on every row it mints, because no use
   * case in this context prices a call yet — `providers` owns the only mint for
   * a priced value. Nothing proved that, so writing a FLOAT there left the
   * whole suite green, and a float is precisely the value that loses the last
   * places of a six-decimal money column on the way to the store.
   *
   * The claim is `typeof … !== "number"`, not `=== null`: pricing a call later
   * must not turn this case red, but pricing it with a JavaScript number must.
   */
  it("writes a cost that is never a number, on the row execution itself mints", async () => {
    await execute();
    expect(context.repository.audit).toHaveLength(1);
    const [row] = context.repository.audit;
    expect(row).toBeDefined();
    expect(typeof row?.costCents).not.toBe("number");
  });

  it("folds the latency into a health row that starts from nothing", async () => {
    context.dispatch.willAnswer({ kind: "succeeded", result: 1, latencyMs: 100 });
    await execute();
    const health = await context.repository.findHealth(
      context.scope,
      asToolsIdentifier<ToolId>("tool-1"),
      asToolsIdentifier<ExternalEntityId>("acme-backend"),
    );
    expect(health.ok && health.value?.totalCalls).toBe(1);
    expect(health.ok && health.value?.avgLatencyMs).toBe(100);
    expect(health.ok && health.value?.failCount).toBe(0);
  });

  /**
   * ONE TOOL, TWO ENTITIES, TWO HEALTH ROWS.
   *
   * `ToolHealth` is keyed by the tool AND the entity that serves it, because
   * the same content-addressed `Tool` row is shared across every installation
   * that declares that shape — a backend of one customer's failing would
   * otherwise mark the tool unhealthy for everyone exposing it. Nothing proved
   * the second half of that key was read, so a double that dropped it kept the
   * suite green.
   */
  it("keeps one tool's health apart per entity, which is what the key is for", async () => {
    context.dispatch.willAnswer({ kind: "succeeded", result: 1, latencyMs: 100 });
    await execute();
    const elsewhere = await context.repository.findHealth(
      context.scope,
      asToolsIdentifier<ToolId>("tool-1"),
      asToolsIdentifier<ExternalEntityId>("other-backend"),
    );
    expect(elsewhere.ok && elsewhere.value).toBeNull();
  });

  it("carries an audit row even when the audit store is down, without failing the call", async () => {
    // The model already has its answer by the time the row is written. The
    // swallow is a POLICY and it lives in `execute-tool.ts`, not in an adapter.
    context.dispatch.willAnswer({ kind: "succeeded", result: 1, latencyMs: 5 });
    const executed = await execute();
    expect(executed.ok).toBe(true);
  });
});

describe("a call the four tiers refuse", () => {
  it("is BLOCKED before anything reaches the wire", async () => {
    await context.repository.upsertOrganizationPolicy(context.scope, "files.*", "DENY");
    const executed = await execute();
    expect(!executed.ok && executed.error.code).toBe("TOOLS_PERMISSION_BLOCKED");
    expect(context.dispatch.requests).toEqual([]);
  });

  it("is still AUDITED, because a stopped call is the interesting one", async () => {
    await context.repository.upsertOrganizationPolicy(context.scope, "files.*", "DENY");
    await execute();
    expect(context.repository.audit).toHaveLength(1);
    expect(context.repository.audit[0]?.status).toBe("FAILED");
  });

  it("leaves the health counters untouched — the backend was never asked", async () => {
    await context.repository.upsertOrganizationPolicy(context.scope, "files.*", "DENY");
    await execute();
    const health = await context.repository.findHealth(
      context.scope,
      asToolsIdentifier<ToolId>("tool-1"),
      asToolsIdentifier<ExternalEntityId>("acme-backend"),
    );
    expect(health.ok && health.value).toBeNull();
  });

  it("names the tier that blocked it, so an operator knows where to look", async () => {
    await context.repository.upsertOrganizationPolicy(context.scope, "*", "DENY");
    const executed = await execute();
    expect(!executed.ok && executed.error.details["tier"]).toBe(2);
  });
});

describe("a call that needs an operator decision", () => {
  beforeEach(() => {
    context.repository.seedExposure(
      testExposure(context.scope, {
        entityId: ENTITY,
        exposureId: asToolsIdentifier<ExposureId>("exposure-2"),
        toolId: asToolsIdentifier<ToolId>("tool-2"),
        toolName: asToolsIdentifier<ToolName>("kg.delete_node"),
      }),
    );
  });

  it("parks when the caller can park, and sends nothing upstream", async () => {
    const executed = await execute({
      toolName: asToolsIdentifier<ToolName>("kg.delete_node"),
      canPark: true,
    });
    expect(executed.ok && executed.value.kind).toBe("awaiting_approval");
    expect(context.dispatch.requests).toEqual([]);
  });

  it("returns a TERMINAL error when the caller cannot park, never a detached ack", async () => {
    const executed = await execute({ toolName: asToolsIdentifier<ToolName>("kg.delete_node") });
    expect(!executed.ok && executed.error.code).toBe("TOOLS_APPROVAL_REQUIRED");
    expect(context.dispatch.requests).toEqual([]);
  });
});

describe("a call that cannot be routed", () => {
  it("refuses a name nothing in scope exposes, and audits the refusal", async () => {
    const executed = await execute({ toolName: asToolsIdentifier<ToolName>("nope") });
    expect(!executed.ok && executed.error.code).toBe("TOOLS_ROUTE_NOT_IN_SCOPE");
    expect(context.dispatch.requests).toEqual([]);
    expect(context.repository.audit).toHaveLength(1);
  });

  it("refuses a tool this agent's version denies", async () => {
    context.repository.seedBindings([
      {
        agentId: AGENT,
        agentVersionId: asToolsIdentifier<AgentVersionId>("version-1"),
        defaultPolicy: "NONE",
        policies: [],
      },
    ]);
    const executed = await execute();
    expect(!executed.ok && executed.error.details["tier"]).toBe(3);
  });

  it("refuses an agent with no binding in this environment", async () => {
    context.repository.seedBindings([]);
    const executed = await execute();
    expect(!executed.ok && executed.error.code).toBe("TOOLS_PERMISSION_BLOCKED");
  });
});

describe("what a backend answers", () => {
  it("reports a refusal and counts it against health", async () => {
    context.dispatch.willAnswer({ kind: "failed", reason: "backend said no", latencyMs: 8 });
    const executed = await execute();
    expect(!executed.ok && executed.error.code).toBe("TOOLS_DISPATCH_FAILED");
    const health = await context.repository.findHealth(
      context.scope,
      asToolsIdentifier<ToolId>("tool-1"),
      asToolsIdentifier<ExternalEntityId>("acme-backend"),
    );
    expect(health.ok && health.value?.failCount).toBe(1);
    expect(health.ok && health.value?.lastStatus).toBe("failed");
  });

  it("keeps a timeout apart from a refusal on the health row", async () => {
    context.dispatch.willAnswer({ kind: "timeout", latencyMs: 30_000 });
    await execute();
    const health = await context.repository.findHealth(
      context.scope,
      asToolsIdentifier<ToolId>("tool-1"),
      asToolsIdentifier<ExternalEntityId>("acme-backend"),
    );
    expect(health.ok && health.value?.lastStatus).toBe("timeout");
  });

  it("treats a 429 as HEALTH-NEUTRAL, so a busy tool is not reported broken", async () => {
    context.dispatch.willAnswer({ kind: "rateLimited", retryAfterSeconds: 30, latencyMs: 4 });
    const executed = await execute();
    expect(!executed.ok && executed.error.code).toBe("TOOLS_DISPATCH_RATE_LIMITED");
    expect(!executed.ok && executed.error.retryAfterSeconds).toBe(30);
    const health = await context.repository.findHealth(
      context.scope,
      asToolsIdentifier<ToolId>("tool-1"),
      asToolsIdentifier<ExternalEntityId>("acme-backend"),
    );
    expect(health.ok && health.value).toBeNull();
  });

  it("still audits a rate-limited call", async () => {
    context.dispatch.willAnswer({ kind: "rateLimited", retryAfterSeconds: 30, latencyMs: 4 });
    await execute();
    expect(context.repository.audit).toHaveLength(1);
  });

  it("keeps the runtime failure message content-free and the diagnosis in details", async () => {
    context.dispatch.willAnswer({ kind: "failed", reason: "ECONNRESET 10.0.0.4:8443", latencyMs: 3 });
    const executed = await execute();
    expect(!executed.ok && executed.error.message).toBe("Tool call failed.");
    expect(!executed.ok && executed.error.details["reason"]).toBe("ECONNRESET 10.0.0.4:8443");
  });
});

describe("the MCP transport and its fail-closed invariant", () => {
  function seedMcpEntity(headersTemplate: unknown, url: string | null): EntityMcpClient {
    context.repository.seedExposure(
      testExposure(context.scope, {
        entityId: ENTITY,
        connectionKind: "mcp",
        callbackUrl: "",
      }),
    );
    return context.repository.seedMcpClient({
      entityId: ENTITY,
      transport: "http",
      url,
      credentialId: null,
      credentialName: asToolsIdentifier<CredentialName>("COMPOSIO_API_KEY"),
      headersTemplate: headersTemplate as Readonly<Record<string, string>>,
      lastDiscoveryAt: null,
      discoveryError: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
  }

  it("sends NOTHING when a template names an end user and none is linked", async () => {
    seedMcpEntity({ "X-User": END_USER_TOKEN }, "https://mcp.test/x");
    const executed = await execute();
    expect(!executed.ok && executed.error.code).toBe("TOOLS_END_USER_REQUIRED");
    expect(context.dispatch.requests).toEqual([]);
  });

  it("does not even READ THE VAULT for a call it is going to refuse", async () => {
    seedMcpEntity(
      { "X-User": END_USER_TOKEN, Authorization: `Bearer ${SECRET_TOKEN}` },
      "https://mcp.test/x",
    );
    await execute();
    expect(context.secrets.reads).toEqual([]);
  });

  it("substitutes and dispatches once an end user IS linked", async () => {
    seedMcpEntity({ "X-User": END_USER_TOKEN }, "https://mcp.test/x");
    const executed = await execute({ endUserId: asToolsIdentifier<EndUserId>("user-9") });
    expect(executed.ok).toBe(true);
    expect(context.dispatch.requests[0]?.target.headers["X-User"]).toBe("user-9");
  });

  it("keys the pooled session on the resolved credential, so two users never share one", async () => {
    seedMcpEntity({ "X-User": END_USER_TOKEN }, "https://mcp.test/x");
    await execute({ endUserId: asToolsIdentifier<EndUserId>("user-1") });
    await execute({ endUserId: asToolsIdentifier<EndUserId>("user-2") });
    const [first, second] = context.dispatch.requests;
    expect(first?.target.sessionKey).not.toBe(second?.target.sessionKey);
  });

  it("resolves the secret from the vault and puts it only in the header", async () => {
    context.secrets.seed("COMPOSIO_API_KEY", "sk-live-abc");
    seedMcpEntity({ Authorization: `Bearer ${SECRET_TOKEN}` }, "https://mcp.test/x");
    const executed = await execute();
    expect(executed.ok).toBe(true);
    expect(context.secrets.reads).toEqual(["COMPOSIO_API_KEY"]);
    expect(context.dispatch.requests[0]?.target.headers["Authorization"]).toBe("Bearer sk-live-abc");
  });

  it("refuses a URL carrying a secret template, without reading the vault for it", async () => {
    context.secrets.seed("COMPOSIO_API_KEY", "sk-live-abc");
    // A non-empty template, so the bearer default is not applied and nothing
    // in a HEADER demands material. The token is in the URL alone.
    seedMcpEntity({ "X-Static": "v" }, `https://mcp.test/${SECRET_TOKEN}`);
    const executed = await execute();
    expect(!executed.ok && executed.error.code).toBe("TOOLS_RESIDUAL_TEMPLATE");
    expect(context.secrets.reads).toEqual([]);
    expect(context.dispatch.requests).toEqual([]);
  });

  it("refuses when the entity has no MCP client at all", async () => {
    context.repository.seedExposure(
      testExposure(context.scope, { entityId: ENTITY, connectionKind: "mcp", callbackUrl: "" }),
    );
    const executed = await execute();
    expect(!executed.ok && executed.error.code).toBe("TOOLS_ENTITY_NOT_DISPATCHABLE");
    expect(context.dispatch.requests).toEqual([]);
  });

  it("merges the context envelope only when the entity asked for it, and only after every gate", async () => {
    context.repository.seedExposure(
      testExposure(context.scope, { entityId: ENTITY, injectMcpContext: true }),
    );
    await execute({ endUserId: asToolsIdentifier<EndUserId>("user-9") });
    expect(context.dispatch.requests[0]?.arguments).toMatchObject({
      path: "/a",
      _context: { endUserId: "user-9" },
    });
  });
});

// `resolveDispatchTarget` is published from `application/index.js`, so the
// dispatchability rule is a boundary of its own and not merely an internal step
// of `executeTool`. Both of its in-context callers arrive already-filtered —
// `executeTool` routes with `callableOnly: true` and discovery hard-codes a
// dispatchable subject — so the refusal below is the ONLY thing standing
// between a caller that did not filter and a target it can spend on the wire.
describe("turning an exposure into a callable target", () => {
  it("REFUSES a subject with no live transport, before reading anything", async () => {
    const dead = testExposure(context.scope, { entityId: ENTITY, dispatchable: false });
    const resolved = await resolveDispatchTarget(context.dependencies, {
      scope: context.scope,
      subject: subjectOf(dead),
      endUserId: null,
      vaultAuthorization: VAULT,
    });
    expect(!resolved.ok && resolved.error.code).toBe("TOOLS_ENTITY_NOT_DISPATCHABLE");
    // Nothing was read and nothing was sent. A guard that refused AFTER
    // resolving would still return an error and would still have touched the
    // vault for a call that is not going to happen.
    expect(context.dispatch.requests).toEqual([]);
  });

  it("resolves the SAME subject once its transport is live, so the refusal is the flag and not the shape", async () => {
    const live = testExposure(context.scope, { entityId: ENTITY, dispatchable: true });
    const resolved = await resolveDispatchTarget(context.dependencies, {
      scope: context.scope,
      subject: subjectOf(live),
      endUserId: null,
      vaultAuthorization: VAULT,
    });
    expect(resolved.ok && resolved.value.kind).toBe("wire");
  });
});

describe("resolving a permission without the side effect", () => {
  it("answers with the composed state and the winning tier", async () => {
    const decided = await resolvePermission(context.dependencies, {
      scope: context.scope,
      toolName: asToolsIdentifier<ToolName>("kg.delete_node"),
      agentId: AGENT,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
    });
    expect(decided.ok && decided.value.state).toBe("require_approval");
  });

  it("reports tier 1 when the baseline is the only tier with an opinion", async () => {
    const decided = await resolvePermission(context.dependencies, {
      scope: context.scope,
      toolName: asToolsIdentifier<ToolName>("gdpr.purge"),
      agentId: AGENT,
      toolId: null,
    });
    expect(decided.ok && decided.value).toEqual({
      state: "require_approval",
      tier: 1,
      reason: "tier-1 require_approval",
    });
  });

  it("has NO tier-1 block in the shipped baseline, so that short-circuit never fires today", () => {
    // Worth pinning rather than assuming: the transcribed table is entirely
    // `require_approval`, so an installation that wants an outright refusal
    // must write an organization policy — tier 2 — and the tier-1 early
    // return in `resolvePermission` is dead code until the table grows one.
    expect(PLATFORM_TIER_MINIMUMS.some((rule) => rule.minimum === "block")).toBe(false);
  });

  it("short-circuits at tier 2 without consulting the agent's version", async () => {
    await context.repository.upsertOrganizationPolicy(context.scope, "files.*", "DENY");
    context.repository.seedBindings([]);
    const decided = await resolvePermission(context.dependencies, {
      scope: context.scope,
      toolName: UPLOAD,
      agentId: AGENT,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
    });
    // With no binding, tier 3 would ALSO block — and would report tier 3. That
    // it reports tier 2 is what proves tier 3 was never reached.
    expect(decided.ok && decided.value.tier).toBe(2);
  });

  it("has no opinion at tier 3 for a caller that is not an agent", async () => {
    const decided = await resolvePermission(context.dependencies, {
      scope: context.scope,
      toolName: UPLOAD,
      agentId: null,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
    });
    expect(decided.ok && decided.value.state).toBe("auto_allow");
  });
});
