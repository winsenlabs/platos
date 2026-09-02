import { asIdentifier, type EntityId, type EnvironmentId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  byExposureOrder,
  contributingEntities,
  dispatchabilityOf,
  hasPersistentCallback,
  isCallable,
  isVisibleToAgent,
  selectExposures,
  type ToolExposure,
} from "./exposure.js";
import {
  asToolsIdentifier,
  type AgentId,
  type ExposureId,
  type ExternalEntityId,
  type ToolId,
  type ToolName,
} from "./identifiers.js";

const ENVIRONMENT = asIdentifier<EnvironmentId>("env-1");
const AGENT = asToolsIdentifier<AgentId>("agent-1");
const OTHER_AGENT = asToolsIdentifier<AgentId>("agent-2");

function exposure(overrides: Partial<ToolExposure> = {}): ToolExposure {
  return {
    exposureId: asToolsIdentifier<ExposureId>("exposure-1"),
    environmentId: ENVIRONMENT,
    entityId: asIdentifier<EntityId>("entity-pk-1"),
    externalEntityId: asToolsIdentifier<ExternalEntityId>("acme"),
    toolId: asToolsIdentifier<ToolId>("tool-1"),
    toolName: asToolsIdentifier<ToolName>("files.upload"),
    description: "",
    paramSchema: {},
    category: "files",
    callbackUrl: "https://acme.test/tools",
    connectionKind: "wire",
    enabled: true,
    dispatchable: true,
    allowedAgentIds: [AGENT],
    injectMcpContext: false,
    ...overrides,
  };
}

describe("whether a transport can carry a call", () => {
  it("makes an MCP entity dispatchable exactly when it has a client row", () => {
    expect(
      dispatchabilityOf({ connectionKind: "mcp", callbackUrl: null, hasMcpClient: true }),
    ).toBe(true);
    expect(
      dispatchabilityOf({ connectionKind: "mcp", callbackUrl: null, hasMcpClient: false }),
    ).toBe(false);
  });

  it("ignores a callback URL on an MCP entity — it is reached by a session", () => {
    expect(
      dispatchabilityOf({
        connectionKind: "mcp",
        callbackUrl: "https://acme.test/tools",
        hasMcpClient: false,
      }),
    ).toBe(false);
  });

  it("keeps a wire entity dispatchable while its callback outlives the socket", () => {
    expect(
      dispatchabilityOf({
        connectionKind: "wire",
        callbackUrl: "https://acme.test/tools",
        hasMcpClient: false,
        transportLive: false,
      }),
    ).toBe(true);
  });

  it("falls back to the live socket when there is no persistent callback", () => {
    expect(
      dispatchabilityOf({ connectionKind: "wire", callbackUrl: "", hasMcpClient: false, transportLive: true }),
    ).toBe(true);
    expect(
      dispatchabilityOf({ connectionKind: "wire", callbackUrl: "", hasMcpClient: false, transportLive: false }),
    ).toBe(false);
  });

  it("accepts only an absolute http(s) callback", () => {
    expect(hasPersistentCallback("https://acme.test/x")).toBe(true);
    expect(hasPersistentCallback("HTTP://acme.test/x")).toBe(true);
    expect(hasPersistentCallback("ws://acme.test/x")).toBe(false);
    expect(hasPersistentCallback("/tools")).toBe(false);
    expect(hasPersistentCallback("")).toBe(false);
  });
});

describe("agent visibility", () => {
  it("shows everything to a caller that is not an agent", () => {
    expect(isVisibleToAgent(exposure({ allowedAgentIds: [] }), null)).toBe(true);
  });

  it("hides a tool from an agent its policy does not name", () => {
    expect(isVisibleToAgent(exposure(), AGENT)).toBe(true);
    expect(isVisibleToAgent(exposure(), OTHER_AGENT)).toBe(false);
  });

  it("needs all three facts before a tool is callable", () => {
    expect(isCallable(exposure(), AGENT)).toBe(true);
    expect(isCallable(exposure({ enabled: false }), AGENT)).toBe(false);
    expect(isCallable(exposure({ dispatchable: false }), AGENT)).toBe(false);
    expect(isCallable(exposure(), OTHER_AGENT)).toBe(false);
  });
});

describe("narrowing the matrix", () => {
  const matrix = [
    exposure({ toolName: asToolsIdentifier<ToolName>("b"), toolId: asToolsIdentifier<ToolId>("tool-2") }),
    exposure({ toolName: asToolsIdentifier<ToolName>("a") }),
    exposure({
      toolName: asToolsIdentifier<ToolName>("a"),
      toolId: asToolsIdentifier<ToolId>("tool-3"),
      externalEntityId: asToolsIdentifier<ExternalEntityId>("beta"),
      entityId: asIdentifier<EntityId>("entity-pk-2"),
    }),
  ];

  it("orders by name, then entity, then tool version", () => {
    expect(selectExposures(matrix).map((entry) => [entry.toolName, entry.externalEntityId])).toEqual([
      ["a", "acme"],
      ["a", "beta"],
      ["b", "acme"],
    ]);
  });

  it("treats an EMPTY entity list as no filter, not as a filter matching nothing", () => {
    expect(selectExposures(matrix, { externalEntityIds: [] })).toHaveLength(3);
    expect(
      selectExposures(matrix, { externalEntityIds: [asToolsIdentifier<ExternalEntityId>("beta")] }),
    ).toHaveLength(1);
  });

  it("drops uncallable exposures by default and keeps them on request", () => {
    const withDisabled = [...matrix, exposure({ toolName: asToolsIdentifier<ToolName>("c"), enabled: false })];
    expect(selectExposures(withDisabled)).toHaveLength(3);
    expect(selectExposures(withDisabled, { callableOnly: false })).toHaveLength(4);
  });

  it("is a TOTAL order, so two rows differing only by id do not swap between calls", () => {
    const left = exposure({ toolId: asToolsIdentifier<ToolId>("tool-1") });
    const right = exposure({ toolId: asToolsIdentifier<ToolId>("tool-2") });
    expect(byExposureOrder(left, right)).toBeLessThan(0);
    expect(byExposureOrder(right, left)).toBeGreaterThan(0);
    expect(byExposureOrder(left, left)).toBe(0);
  });
});

describe("which entities contribute to a matrix", () => {
  it("reports each entity once, in matrix order", () => {
    const entities = contributingEntities([
      exposure({ externalEntityId: asToolsIdentifier<ExternalEntityId>("beta"), entityId: asIdentifier<EntityId>("pk-2") }),
      exposure(),
      exposure({ toolName: asToolsIdentifier<ToolName>("z") }),
    ]);
    expect(entities.map((entity) => entity.externalEntityId)).toEqual(["acme", "beta"]);
  });
});
