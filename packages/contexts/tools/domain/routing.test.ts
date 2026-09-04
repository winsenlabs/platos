import { asIdentifier, type EntityId, type EnvironmentId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { ToolExposure } from "./exposure.js";
import {
  asToolsIdentifier,
  type AgentId,
  type ExposureId,
  type ExternalEntityId,
  type ToolId,
  type ToolName,
} from "./identifiers.js";
import {
  DISAMBIGUATION_STRATEGIES,
  requiresEntityDisambiguation,
  resolveRoute,
} from "./routing.js";

const ENVIRONMENT = asIdentifier<EnvironmentId>("env-1");
const UPLOAD = asToolsIdentifier<ToolName>("files.upload");

function exposure(overrides: Partial<ToolExposure> = {}): ToolExposure {
  return {
    exposureId: asToolsIdentifier<ExposureId>("exposure-1"),
    environmentId: ENVIRONMENT,
    entityId: asIdentifier<EntityId>("entity-pk-1"),
    externalEntityId: asToolsIdentifier<ExternalEntityId>("acme"),
    toolId: asToolsIdentifier<ToolId>("tool-1"),
    toolName: UPLOAD,
    description: "",
    paramSchema: {},
    category: "files",
    callbackUrl: "https://acme.test/tools",
    connectionKind: "wire",
    enabled: true,
    dispatchable: true,
    allowedAgentIds: [],
    injectMcpContext: false,
    ...overrides,
  };
}

const BETA = exposure({
  entityId: asIdentifier<EntityId>("entity-pk-2"),
  externalEntityId: asToolsIdentifier<ExternalEntityId>("beta"),
  toolId: asToolsIdentifier<ToolId>("tool-2"),
  exposureId: asToolsIdentifier<ExposureId>("exposure-2"),
});

describe("the two strategies", () => {
  it("are exactly the two callers, and the default is the one a model can act on", () => {
    expect([...DISAMBIGUATION_STRATEGIES]).toEqual(["first-match", "error"]);
    const routed = resolveRoute([exposure(), BETA], { toolName: UPLOAD });
    expect(routed.ok).toBe(true);
  });
});

describe("resolving a unique name", () => {
  it("returns the one exposure and reports one match", () => {
    const routed = resolveRoute([exposure()], { toolName: UPLOAD });
    expect(routed.ok && routed.value.matched).toBe(1);
    expect(routed.ok && routed.value.exposure.externalEntityId).toBe("acme");
  });

  it("refuses a name nothing in scope exposes", () => {
    const routed = resolveRoute([exposure()], { toolName: asToolsIdentifier<ToolName>("nope") });
    expect(!routed.ok && routed.error.code).toBe("TOOLS_ROUTE_NOT_IN_SCOPE");
  });

  it("refuses a name only an uncallable exposure holds", () => {
    expect(resolveRoute([exposure({ enabled: false })], { toolName: UPLOAD }).ok).toBe(false);
    expect(resolveRoute([exposure({ dispatchable: false })], { toolName: UPLOAD }).ok).toBe(false);
  });

  it("refuses a name only another agent may see", () => {
    const owned = exposure({ allowedAgentIds: [asToolsIdentifier<AgentId>("agent-1")] });
    expect(
      resolveRoute([owned], { toolName: UPLOAD, agentId: asToolsIdentifier<AgentId>("agent-2") }).ok,
    ).toBe(false);
    expect(
      resolveRoute([owned], { toolName: UPLOAD, agentId: asToolsIdentifier<AgentId>("agent-1") }).ok,
    ).toBe(true);
  });
});

describe("resolving an ambiguous name", () => {
  const matrix = [BETA, exposure()];

  it("picks the lowest tool id under first-match, and reports the ambiguity", () => {
    const routed = resolveRoute(matrix, { toolName: UPLOAD, strategy: "first-match" });
    expect(routed.ok && routed.value.exposure.toolId).toBe("tool-1");
    expect(routed.ok && routed.value.matched).toBe(2);
  });

  it("picks the SAME one every time, which is what a model's retry depends on", () => {
    const first = resolveRoute(matrix, { toolName: UPLOAD });
    const second = resolveRoute([...matrix].reverse(), { toolName: UPLOAD });
    expect(first.ok && second.ok && first.value.exposure.toolId).toBe(
      second.ok ? second.value.exposure.toolId : null,
    );
  });

  it("refuses under `error`, and hands back the candidates so a client can re-ask", () => {
    const routed = resolveRoute(matrix, { toolName: UPLOAD, strategy: "error" });
    expect(!routed.ok && routed.error.code).toBe("TOOLS_ROUTE_AMBIGUOUS");
    expect(!routed.ok && (routed.error.details["candidates"] as readonly unknown[])).toHaveLength(2);
  });

  it("stops being ambiguous once the caller names an entity", () => {
    const routed = resolveRoute(matrix, {
      toolName: UPLOAD,
      strategy: "error",
      externalEntityIds: [asToolsIdentifier<ExternalEntityId>("beta")],
    });
    expect(routed.ok && routed.value.matched).toBe(1);
    expect(routed.ok && routed.value.exposure.externalEntityId).toBe("beta");
  });
});

describe("whether an agent must name an entity", () => {
  it("says no with one entity, because there is nothing to disambiguate", () => {
    expect(requiresEntityDisambiguation([exposure()])).toBe(false);
    expect(
      requiresEntityDisambiguation([exposure(), exposure({ toolId: asToolsIdentifier<ToolId>("tool-9") })]),
    ).toBe(false);
  });

  it("says yes once a second entity contributes a callable tool", () => {
    expect(requiresEntityDisambiguation([exposure(), BETA])).toBe(true);
  });

  it("counts only what the model can reach, not what is merely configured", () => {
    expect(requiresEntityDisambiguation([exposure(), { ...BETA, enabled: false }])).toBe(false);
    expect(requiresEntityDisambiguation([exposure(), { ...BETA, dispatchable: false }])).toBe(false);
  });
});
