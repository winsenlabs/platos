import { describe, expect, test } from "vitest";
import {
  JsonShapeError,
  normalizeAgentVersionJson,
  normalizeDashboardPreferences,
  normalizeDynamicBlocks,
  normalizeJsonField,
  normalizeModelRoutes,
  normalizePromptBlocks,
  normalizeToolsBlockConfig,
} from "./json";

const promptBlocks = [
  {
    id: "system",
    type: "system",
    name: "System",
    content: "Be helpful",
    enabled: true,
    editable: true,
    order: 0,
  },
];
const dynamicBlocks = [
  { key: "account", name: "Account", defaultContent: "Unknown", order: 0 },
];
const modelRoutes = [
  { label: "default", model: "anthropic:claude", isDefault: true },
  { label: "fast", model: "openai:gpt", providerCredentialId: "credential", isDefault: false },
];

describe("Json write boundaries", () => {
  test("validates and normalizes versioned dashboard preferences", () => {
    expect(normalizeDashboardPreferences({
      version: "1",
      currentProjectId: "project-a",
      projects: {
        "project-a": { currentEnvironment: { id: "environment-a" }, ignored: true },
      },
      sideMenu: {
        isCollapsed: true,
        collapsedSections: { agents: false },
        organizations: {
          "organization-a": { orderedItems: { agents: ["agent-b", "agent-a"] } },
        },
      },
      ignored: "removed",
    })).toEqual({
      version: "1",
      currentProjectId: "project-a",
      projects: {
        "project-a": { currentEnvironment: { id: "environment-a" } },
      },
      sideMenu: {
        isCollapsed: true,
        collapsedSections: { agents: false },
        organizations: {
          "organization-a": { orderedItems: { agents: ["agent-b", "agent-a"] } },
        },
      },
    });
  });

  test("rejects malformed dashboard preference fields", () => {
    expect(() => normalizeDashboardPreferences({ version: "2", projects: {} }))
      .toThrow(/version/);
    expect(() => normalizeDashboardPreferences({ version: "1", projects: [] }))
      .toThrow(/projects/);
    expect(() => normalizeDashboardPreferences({
      version: "1",
      projects: { project: { currentEnvironment: { id: "" } } },
    })).toThrow(/currentEnvironment.id/);
    expect(() => normalizeDashboardPreferences({
      version: "1",
      projects: {},
      sideMenu: { collapsedSections: { agents: "yes" } },
    })).toThrow(/must be a boolean/);
    expect(() => normalizeDashboardPreferences({
      version: "1",
      projects: {},
      sideMenu: { organizations: { org: { orderedItems: { agents: [1] } } } },
    })).toThrow(/array of strings/);
  });

  test("persists native expected roots for a complete agent version", () => {
    const value = normalizeAgentVersionJson({
      promptBlocks,
      dynamicBlocks,
      modelRoutes,
      toolsBlockConfig: { mode: "direct", pinnedTools: ["remember"] },
      memoryConfig: { maxItems: 50 },
      outputSchema: { type: "object", properties: {} },
    });

    expect(Array.isArray(value.promptBlocks)).toBe(true);
    expect(Array.isArray(value.dynamicBlocks)).toBe(true);
    expect(Array.isArray(value.modelRoutes)).toBe(true);
    expect(typeof value.toolsBlockConfig).toBe("object");
    expect(value.modelRoutes.map((route) => route.label)).toEqual(["default", "fast"]);
  });

  test("parses exactly one explicitly supported legacy encoded layer", () => {
    expect(normalizePromptBlocks(JSON.stringify(promptBlocks))).toEqual(promptBlocks);
    expect(normalizeDynamicBlocks(JSON.stringify(dynamicBlocks))).toEqual(dynamicBlocks);
    expect(normalizeModelRoutes(JSON.stringify(modelRoutes))).toEqual(modelRoutes);
    expect(normalizeToolsBlockConfig(JSON.stringify({ mode: "sub-agent" }))).toEqual({
      mode: "sub-agent",
    });
  });

  test("rejects double encoding, malformed strings, and wrong roots", () => {
    for (const [normalizer, value] of [
      [normalizePromptBlocks, promptBlocks],
      [normalizeDynamicBlocks, dynamicBlocks],
      [normalizeModelRoutes, modelRoutes],
      [normalizeToolsBlockConfig, { mode: "direct" }],
    ] as const) {
      expect(() => normalizer(JSON.stringify(JSON.stringify(value)))).toThrow(JsonShapeError);
      expect(() => normalizer("{broken")).toThrow(JsonShapeError);
    }

    expect(() => normalizePromptBlocks({ blocks: promptBlocks })).toThrow(/expected array root/);
    expect(() => normalizeToolsBlockConfig([])).toThrow(/expected object root/);
    expect(() => normalizeJsonField("Event.payload", "{}"))
      .toThrow(/expected object root/);
  });

  test("never lets an encoded array reach map as a string", () => {
    const routes = normalizeModelRoutes(JSON.stringify(modelRoutes));
    expect(Array.isArray(routes)).toBe(true);
    expect(() => routes.map((route) => route.model)).not.toThrow();
    expect(routes.map((route) => route.model)).toEqual(["anthropic:claude", "openai:gpt"]);
  });

  test("replaces ambiguous enabledTools with AgentToolPolicy relations", () => {
    expect(() => normalizeToolsBlockConfig({ enabledTools: ["send_email"] })).toThrow(
      /AgentToolPolicy/
    );
    expect(normalizeToolsBlockConfig({ toolExposure: "meta", enabledCategories: ["email"] }))
      .toEqual({ toolExposure: "meta", enabledCategories: ["email"] });
  });

  test("validates typed entries rather than only their root", () => {
    expect(() => normalizeModelRoutes([{ label: "bad", model: "x", isDefault: false }]))
      .toThrow(/exactly one/);
    expect(() => normalizeModelRoutes([
      { label: "same", model: "x", isDefault: true },
      { label: "same", model: "y", isDefault: false },
    ])).toThrow(/duplicate route label/);
    expect(() => normalizePromptBlocks([{ id: "missing-fields" }])).toThrow(/type/);
    expect(() => normalizeDynamicBlocks([{ key: "x", name: "X", defaultContent: 1 }]))
      .toThrow(/defaultContent/);
  });
});
