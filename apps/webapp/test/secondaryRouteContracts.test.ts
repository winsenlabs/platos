import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const routes = join(process.cwd(), "app/routes");
const source = (name: string) => readFileSync(join(routes, name, "route.tsx"), "utf8");

describe("WIN-233 secondary route contracts", () => {
  it("maps the complete supported Channel lifecycle to canonical endpoints", () => {
    const connect = source("_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-connect");
    for (const intent of [
      "connection-toggle",
      "connection-update",
      "connection-delete",
      "connection-rotate",
      "connection-mint",
      "channel-app",
      "app-toggle-ai",
      "app-update",
      "app-delete",
      "installation-import",
      "installation-bind",
      "installation-revoke",
    ]) expect(connect).toContain(`intent === \"${intent}\"`);
    expect(connect).toContain('?? "connection-create"');
    expect(connect).toContain("/installations/status");
    expect(connect).toContain("/rotate-secret");
    expect(connect).toContain("/channels/mint");
    expect(connect).not.toContain('intent === "installation"');
  });

  it("propagates the separately selected EndUser through every Memory operation", () => {
    const memory = source("_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.memories._index");
    expect(memory).toContain("/api/v1/memory/extract");
    expect(memory).toContain("/api/v1/memory/import");
    expect(memory).toContain('requiredText(form, "userId", "End user")');
    expect(memory).toContain('requiredText(form, "agentId", "Agent")');
    expect(memory).toContain('agentPinQueryParam: "agentId"');
    expect(memory).toContain("?userId=${encodeURIComponent(userId)}");
    expect(memory).toContain("body: { userId");
    const memoryExport = source("_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.memories.export");
    expect(memoryExport).toContain("/api/v1/memory/export");
    expect(memoryExport).toContain("?userId=${encodeURIComponent(userId)}");
    expect(memoryExport).toContain("{ ...scope, agentId }");
    const graph = source("_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.memories.graph");
    expect(graph).toContain("/api/v1/memory/graph/path");
    expect(graph).toContain("/relationships");
    expect(graph).toContain("/api/v1/memory/relate");
    expect(graph).toContain('query.set("userId", userId)');
    expect(graph).toContain('requiredText(form, "userId", "End user")');
    expect(graph).toContain('requiredText(form, "agentId", "Agent")');
  });

  it("keeps only explicitly owned auxiliary payload fetches", () => {
    const routeSources = readdirSync(routes, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => source(entry.name));
    const configuredSecondarySurfaces = new Set(routeSources.flatMap((route) => {
      if (!/secondaryEndpoint:\s*(?!undefined)["'`/]/.test(route)) return [];
      const match = route.match(/surface:\s*"([^"]+)"/);
      return match ? [match[1]] : [];
    }));
    expect([...configuredSecondarySurfaces].sort()).toEqual([
      "agent-create",
      "budgets",
      "canary",
      "clusters",
      "cost",
      "entities",
      "evals",
      "governance",
      "memories",
      "memory-graph",
      "monitoring",
      "settings",
      "trace",
    ]);

    const surfaces = ["AgentSurfaces", "OperationsSurfaces", "RegistrySurfaces", "SecondarySurfaces", "ThreadSurfaces"]
      .map((name) => readFileSync(join(process.cwd(), `app/components/platos/surfaces/${name}.tsx`), "utf8"))
      .join("\n");
    for (const signature of [
      "AgentConfigSurface({ data, secondary, title }",
      "BudgetsSurface({ data, secondary }",
      "CanarySurface({ data, secondary }",
      "ClustersSurface({ data, secondary }",
      "CostSurface({ data, secondary, supporting }",
      "EntitiesSurface({ data, secondary }",
      "EvalsSurface({ data, secondary, title }",
      "GovernanceSurface({ data, secondary, title }",
      "MonitoringSurface({ data, secondary }",
      "MemorySurface({ data, secondary }",
      "MemoryGraphSurface({ data, secondary }",
      "SettingsSurface({ data, secondary }",
      "TraceSurface({ data, secondary }",
    ]) expect(surfaces).toContain(signature);

    const configuredSupporting = routeSources.filter((route) => /supportingEndpoint:\s*(?!undefined)["'`/]/.test(route));
    expect(configuredSupporting).toHaveLength(1);
    expect(configuredSupporting[0]).toContain('surface: "cost"');
  });

  it("keeps all four Files drill-down endpoints operator-backed", () => {
    const files = [
      source("_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.files._index"),
      source("_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.files.$agentId.users"),
      source("_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.files.$agentId.users.$userId.conversations"),
      source("_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.files.$agentId.users.$userId.conversations.$threadId.attachments"),
    ].join("\n");
    expect(files).toContain("/api/v1/agent/files/agents");
    expect(files).toContain("/api/v1/agent/files/agents/:agentId/users");
    expect(files).toContain("/api/v1/agent/files/agents/:agentId/users/:userId/conversations");
    expect(files).toContain("/api/v1/agent/files/threads/:threadId/attachments");
  });

  it("redirects duplicate Agent-scoped Thread and Trace screens to canonical global routes", () => {
    const thread = source("_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.conversations.$threadId");
    const trace = source("_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.trace.$threadId");
    expect(thread).toContain("/threads/${encodeURIComponent(threadId)}");
    expect(trace).toContain("/threads/${encodeURIComponent(threadId)}/trace");
    expect(thread).not.toContain("M4Surface");
    expect(trace).not.toContain("M4Surface");
  });
});
