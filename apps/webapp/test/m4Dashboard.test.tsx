import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { renderToString } from "react-dom/server";
import { createRemixStub } from "@remix-run/testing";
import { describe, expect, it } from "vitest";
import { M4Surface, type SurfaceData } from "../app/components/platos/M4Surface";
import { asArray, asRecord } from "../app/components/platos/safe";

function render(data: SurfaceData) {
  const Stub = createRemixStub([{ path: "/", Component: () => <M4Surface data={data} /> }]);
  return renderToString(<Stub initialEntries={["/"]} />);
}
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("M4 dashboard rebuild", () => {
  it("renders malformed array and object fields without a white screen", () => {
    expect(asArray("double-encoded")).toEqual([]);
    expect(asRecord(null)).toEqual({});
    const html = render({ surface: "agent-config", title: "Agent", description: "Config", panel: { ok: true, data: { modelRoutes: "[]", promptBlocks: null, fallbackRoutes: "bad" } } });
    expect(html).toContain("Agent");
    expect(html).toContain("Runtime Agent configuration");
  });

  it("renders a dense long Thread and preserves the underlying Tool error", () => {
    const turns = Array.from({ length: 120 }, (_, index) => ({ sequence: index + 1, costWithCacheCents: 12, toolCalls: index === 119 ? [{ toolName: "sheets.query", status: "failed", error: "ENTITY_NOT_CONNECTED" }] : [] }));
    const html = render({ surface: "thread", title: "Thread", description: "Diagnostic", panel: { ok: true, data: { turns, compactionBoundary: "Turns 1–80 summarised" } } });
    expect(html).toContain("Turn #120");
    expect(html).toContain("ENTITY_NOT_CONNECTED");
    expect(html).toContain("Turns 1–80 summarised");
  });

  it("renders conversation-list payloads from top-level threads and total", () => {
    const html = render({
      surface: "conversations",
      title: "Conversations",
      description: "History",
      panel: {
        ok: true,
        data: {
          total: 12,
          threads: [{
            id: "thread-1",
            title: "Refund request",
            userId: "user-1",
            turnCount: 4,
            updatedAt: "2026-08-20T12:00:00.000Z",
          }],
        },
      },
    });
    expect(html).toContain("Refund request");
    expect(html).toContain("user-1");
    expect(html).toContain("Loaded page");
    expect(html).toContain("12");
  });

  it("renders top-level trace messages, spans, and spanTree content", () => {
    const html = render({
      surface: "trace",
      title: "Trace",
      description: "Observability",
      panel: {
        ok: true,
        data: {
          messages: [{ id: "message-1", role: "assistant", content: "Persisted answer" }],
          spans: [{ id: "span-1", name: "tools.execute", status: "error", durationMs: 42, turnId: "turn-1" }],
          spanTree: [{ id: "span-1", children: [{ id: "span-child" }] }],
        },
      },
    });
    expect(html).toContain("Persisted answer");
    expect(html).toContain("tools.execute");
    expect(html).toContain("Span hierarchy");
    expect(html).toContain("span-child");
  });

  it("links Entity detail routes by canonical UUID, not external identifier", () => {
    const canonicalId = "11111111-1111-4111-8111-111111111111";
    const html = render({
      surface: "entities",
      title: "Entities",
      description: "Registry",
      panel: {
        ok: true,
        data: {
          entities: [{ id: canonicalId, entityId: "support-core", displayName: "Support Core" }],
        },
      },
    });
    expect(html).toContain(`href="/${canonicalId}"`);
    expect(html).not.toContain('href="/support-core"');
  });

  it("renders monitoring from the endpoint's cards and ledger lanes without recomputing semantics", () => {
    const html = render({
      surface: "monitoring",
      title: "Monitoring",
      description: "Ledger",
      panel: {
        ok: true,
        data: {
          cards: [
            { id: "cost_7d", label: "Spend last 7 days", value: 2570, unit: "cents" },
            { id: "tasks_7d", label: "Tasks completed (7d)", value: 12, unit: "tasks" },
          ],
          costByLane: { inference: 2500, eval: 70 },
        },
      },
    });
    expect(html).toContain("$25.70");
    expect(html).toContain("One task is one completed Turn");
    expect(html).toContain("Usage-ledger cost lanes");
    expect(html).toContain("performs no cost or task arithmetic");
  });

  it("separates volatile Context variables and flags unresolved placeholders", () => {
    const html = render({
      surface: "context",
      title: "Context",
      description: "Variables",
      panel: {
        ok: true,
        data: {
          systemPrompt: "Hello {{user.name}} at {{user.current_time}} in {{account.region}}",
          contextMapping: { promptVars: ["user.name", "user.current_time"], declaredKeys: ["user.name"] },
        },
      },
    });
    expect(html).toContain("Volatile variables");
    expect(html).toContain("user.current_time");
    expect(html).toContain("Unresolved warnings");
    expect(html).toContain("account.region");
  });

  it("renders runtime-equivalent Agent Tool exposure and mapping controls", () => {
    const html = render({
      surface: "agent-tools",
      title: "Tools",
      description: "Runtime mapping",
      panel: { ok: true, data: { toolExposure: "meta", tools: [{ toolName: "sheets.query", sourceEntity: "sheets", enabled: true, dispatchable: false, health: "disconnected" }] } },
    });
    expect(html).toContain("Find-only");
    expect(html).toContain("Runtime Tools");
    expect(html).toContain("Always present");
    expect(html).toContain("Disable mapping");
  });

  it("renders canary metrics from persisted cohorts with set and promote controls", () => {
    const html = render({
      surface: "canary",
      title: "Canary",
      description: "Persisted cohorts",
      panel: { ok: true, data: { currentVersionId: "v1", canaryVersionId: "v2", canaryPercent: 25, hours: 24, perVersion: [{ versionId: "v2", versionNumber: 2, isCanary: true, turnCount: 10, tasks: 8, totalCostCents: 99 }] } },
      secondary: { ok: true, data: { versions: [{ id: "v2", versionNumber: 2, note: "candidate" }] } },
    });
    expect(html).toContain("Persisted cohort");
    expect(html).toContain("$0.99");
    expect(html).toContain("Promote to active");
  });

  it("renders cache-aware Budget status and typed enforcement controls", () => {
    const html = render({
      surface: "budgets",
      title: "Budgets",
      description: "Ledger caps",
      panel: { ok: true, data: { blocked: false, caps: [{ cap: { id: "cap-1", scopeType: "scope", period: "month", limitCents: 5000, runsLimit: 100 }, spentCents: 2570, runs: 12, blocked: false }] } },
      secondary: { ok: true, data: { caps: [{ id: "cap-1", scopeType: "scope", period: "month", limitCents: 5000, tier: "llm", alertThresholds: [50, 80, 100] }] } },
    });
    expect(html).toContain("$25.70");
    expect(html).toContain("Completed Turn");
    expect(html).toContain("performs no billing or enforcement arithmetic");
    expect(html).toContain("Persist budget");
  });

  it("renders Entity live state from the current registry and tolerates malformed config", () => {
    const html = render({
      surface: "entities",
      title: "Entity diagnostics",
      description: "Live registry",
      panel: { ok: true, data: { entityId: "notes", displayName: "Notes", liveConnected: false, allowedOrigins: "not-an-array", headers: { bad: true } } },
      secondary: { ok: true, data: { rows: [{ sourceEntityId: "notes", toolName: "notes.list", enabled: true, dispatchable: false, health: { lastStatus: "ENTITY_NOT_CONNECTED" } }] } },
    });
    expect(html).toContain("Disconnected");
    expect(html).toContain("Registry now");
    expect(html).toContain("Broken / undispatchable");
    expect(html).toContain("ENTITY_NOT_CONNECTED");
    expect(html).toContain("Delete Entity and registry residue");
  });

  it("renders field-aware AgentVersion changes instead of only dumping JSON", () => {
    const html = render({
      surface: "versions",
      title: "Versions",
      description: "Diff",
      panel: { ok: true, data: { versions: [{ id: "v2", versionNumber: 2, note: "Meta", configSnapshot: { model: "openai:gpt-5", toolsBlockConfig: { toolExposure: "meta" }, modelRoutes: [{ label: "default", model: "openai:gpt-5", isDefault: true }] } }, { id: "v1", versionNumber: 1, note: "Direct", configSnapshot: { model: "openai:gpt-4.1", toolsBlockConfig: { toolExposure: "direct" }, modelRoutes: [{ label: "default", model: "openai:gpt-4.1", isDefault: true }] } }] } },
    });
    expect(html).toContain("Readable config diff");
    expect(html).toContain("toolsBlockConfig");
    expect(html).toContain("modelRoutes");
    expect(html).toContain("Roll back via new immutable version");
  });

  it("renders persisted approval outcome and idempotent resolution controls", () => {
    const pending = render({ surface: "governance", title: "Approval detail", description: "Once", panel: { ok: true, data: { id: "approval-1", toolName: "notes.delete", status: "pending", requestedBy: "user-1" } } });
    expect(pending).toContain("Resolve exactly once");
    expect(pending).toContain("Approve");
    const resolved = render({ surface: "governance", title: "Approval detail", description: "Once", panel: { ok: true, data: { id: "approval-1", toolName: "notes.delete", status: "approved", comment: "Persisted" } } });
    expect(resolved).toContain("Persisted");
    expect(resolved).not.toContain("Resolve exactly once");
  });

  it("keeps both channel ownership models explicit and dashboard token minting absent", () => {
    const html = render({
      surface: "channels",
      title: "Connect",
      description: "Channels",
      panel: { ok: true, data: { rest: { baseUrl: "https://agent.example" } } },
      secondary: { ok: true, data: { apps: [{ id: "app-1", displayName: "Hosted", provider: "slack", enabled: true }] } },
      supporting: { ok: true, data: { channels: [{ id: "channel-1", displayName: "BYO", provider: "slack", status: "active" }] } },
    });
    expect(html).toContain("Hosted OAuth ChannelApp");
    expect(html).toContain("Operator-owned ChannelConnection");
    expect(html).toContain("Import operator-owned Slack installation");
    expect(html).toContain("does not mint identity-bearing session tokens");
  });

  it("renders typed Skill, Postman, and MCP configuration controls", () => {
    const skills = render({ surface: "skills", title: "Install Skill", description: "Import", panel: { ok: true, data: { skills: [] } } });
    expect(skills).toContain("Skill URL");
    expect(skills).toContain("Import and validate");
    const postman = render({ surface: "postman", title: "Postman templates", description: "Debug", panel: { ok: true, data: { templates: [{ id: "template-1", name: "Ada", simulateUserId: "user-1", sessionContext: { account: "a" }, isDefault: true }] } } });
    expect(postman).toContain("Simulated user ID");
    expect(postman).toContain("Session Context — JSON object");
    const mcp = render({ surface: "mcp-config", title: "MCP Entity", description: "Gateway", panel: { ok: true, data: { enabled: true, identityMode: "bearer", bearerTokenCount: 2, rateLimitPerMinute: 60 } } });
    expect(mcp).toContain("Save typed MCP config");
    expect(mcp).toContain("Active bearer tokens");
  });

  it("keeps the agent-service failure isolated to its panel", () => {
    const html = render({ surface: "agents", title: "Agents", description: "List", panel: { ok: false, error: { code: "AGENT_UNAVAILABLE", message: "Service unavailable" } } });
    expect(html).toContain("Panel unavailable");
    expect(html).toContain("AGENT_UNAVAILABLE");
  });

  it("has no legacy database, Environment resource, identity bridge, or dashboard token mint source", () => {
    const root = join(process.cwd(), "app");
    const corpus = files(root).map((path) => `${relative(root, path)}\n${readFileSync(path, "utf8")}`).join("\n");
    expect(corpus).not.toMatch(/runtimeEnvironment|RuntimeEnvironment/);
    expect(corpus).not.toContain("@platos/database");
    expect(corpus).not.toContain("dashboardIdentity");
    expect(corpus).not.toMatch(/LegacyUserId|legacyUserId|canonicalUserIdBrand/);
    expect(corpus).not.toContain("agent-connect.mint-token");
  });

  it("centralizes scoped dashboard API transport", () => {
    const routes = files(join(process.cwd(), "app/routes"))
      .filter((path) => /agent|approvals|eval|clusters|platos-tasks/.test(path))
      .map((path) => readFileSync(path, "utf8"));
    const directCalls = routes.filter((source) => source.includes("PLATOS_AGENT_API_URL"));
    expect(directCalls).toEqual([]);
    expect(readFileSync(join(process.cwd(), "app/services/platosAgent.server.ts"), "utf8")).toContain("X-Platos-Environment-Id");
  });

  it("keeps AccessKey bearer material in browser memory and submits hash metadata only", () => {
    const source = readFileSync(
      join(process.cwd(), "app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/route.tsx"),
      "utf8",
    );
    expect(source).toContain("crypto.getRandomValues");
    expect(source).toContain('crypto.subtle.digest("SHA-256"');
    expect(source).toContain('body: { keyHash, keyPrefix }');
    expect(source).toContain('["intent", "keyHash", "keyPrefix"]');
    expect(source).toContain("asRecord(accessKeys.key)");
    expect(source).toContain("asRecord(accessKeys.retiringKey)");
    expect(source).not.toMatch(/name=["'](?:rawKey|accessKey|key)["']/);
  });

  it("keeps Entity secrets reveal-once and renders nested Entity operations", () => {
    const surface = readFileSync(join(process.cwd(), "app/components/platos/M4Surface.tsx"), "utf8");
    const entityRoute = readFileSync(
      join(process.cwd(), "app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.$entityId/route.tsx"),
      "utf8",
    );
    expect(surface).toContain("result.plaintextSecret");
    expect(surface).toContain('pattern="[a-z0-9][a-z0-9\\-]{0,63}"');
    expect(entityRoute).toContain("useOutlet");
    expect(entityRoute).toContain("return outlet ??");
  });

  it("uses validated typed Agent controls rather than an arbitrary payload blob", () => {
    const source = readFileSync(join(process.cwd(), "app/services/agentConfig.server.ts"), "utf8");
    expect(source).toContain("modelRoutes must contain exactly one default route");
    expect(source).toContain('["direct", "meta"]');
    expect(source).not.toContain('form.get("payload")');
  });

  it("uses typed mutations for the remaining high-risk M4 route families", () => {
    const routeNames = [
      "_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-budgets._index",
      "_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.new",
      "_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.$entityId",
      "_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.approvals.$approvalId",
      "_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-clusters._index",
      "_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.platos-tasks.new",
      "_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.eval-criteria._index",
      "_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-connect",
      "_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.skills.new",
      "_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.postman-templates",
      "_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps.$entityId._index",
    ];
    for (const routeName of routeNames) {
      const source = readFileSync(join(process.cwd(), "app/routes", routeName, "route.tsx"), "utf8");
      expect(source, routeName).not.toContain("mutateSurface");
      expect(source, routeName).not.toContain('form.get("payload")');
    }
    const routeCorpus = files(join(process.cwd(), "app/routes")).map((path) => readFileSync(path, "utf8")).join("\n");
    expect(routeCorpus).not.toContain("mutateSurface");
    expect(routeCorpus).not.toContain('form.get("payload")');
  });

  it("uses runtime-equivalent Tool tests and real incremental chat transports", () => {
    const tools = readFileSync(
      join(process.cwd(), "app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-tools._index/route.tsx"),
      "utf8",
    );
    const chat = readFileSync(
      join(process.cwd(), "app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.chat/route.tsx"),
      "utf8",
    );
    const embed = readFileSync(join(process.cwd(), "app/routes/embed.$agentId.tsx"), "utf8");
    expect(tools).toContain("/test`");
    expect(tools).toContain("sourceEntityId, params: {}");
    expect(chat).toContain("/chat/stream?");
    expect(chat).toContain('event.type !== "message_persisted"');
    expect(chat).toContain("messages/${encodeURIComponent(safeMessageId(body.messageId))}/rating");
    expect(embed).toContain("/api/v1/public/agents/${encodeURIComponent(agentId)}/chat/stream");
    expect(embed).not.toContain("PLATOS_AGENT_PUBLIC_URL");
  });

  it("maps non-zero M4 detail contracts to generated canonical Agent operations", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(process.cwd(), "../agent/src/control-plane/operation-manifest.generated.json"),
        "utf8",
      ),
    ) as { inventories: { restOperations: Array<{ id: string }> } };
    const operationIds = new Set(manifest.inventories.restOperations.map((operation) => operation.id));
    const contracts = [
      {
        operation: "GET /api/v1/agent/entities/:entityId",
        route: "_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.$entityId",
      },
      {
        operation: "GET /api/v1/agent/entities/:entityId/mcp/config",
        route: "_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps.$entityId._index",
      },
      {
        operation: "GET /api/v1/agent/platos-tasks/:id",
        route: "_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.platos-tasks.$taskId",
      },
    ];

    expect(contracts.length).toBeGreaterThan(0);
    for (const contract of contracts) {
      expect(operationIds.has(contract.operation), contract.operation).toBe(true);
      const source = readFileSync(join(process.cwd(), "app/routes", contract.route, "route.tsx"), "utf8");
      expect(source, contract.route).toContain(contract.operation.slice(4));
    }
  });
});
