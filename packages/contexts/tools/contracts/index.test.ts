import { asIdentifier, type EntityId } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asToolsIdentifier,
  type ExternalEntityId,
  type ToolId,
  type ToolName,
} from "../domain/index.js";
import {
  buildToolsTestContext,
  testExposure,
  testVaultAuthorization,
  type ToolsTestContext,
} from "../application/testing/index.js";
import { toolsContract, TOOLS_EVENT_NAMES, type ToolsContract } from "./index.js";

const ENTITY = asIdentifier<EntityId>("entity-pk-1");
const EXTERNAL = asToolsIdentifier<ExternalEntityId>("acme-backend");
const UPLOAD = asToolsIdentifier<ToolName>("files.upload");

let context: ToolsTestContext;
let contract: ToolsContract;

beforeEach(() => {
  context = buildToolsTestContext();
  contract = toolsContract(context.dependencies);
  context.tenancy.seedEntity(ENTITY, EXTERNAL);
  context.repository.seedExposure(testExposure(context.scope, { entityId: ENTITY }));
});

describe("the published surface", () => {
  it("names itself, and is frozen so nothing can graft behaviour onto it", () => {
    expect(contract.name).toBe("tools");
    expect(Object.isFrozen(contract)).toBe(true);
  });

  it("returns Result from every method rather than throwing", async () => {
    const listed = await contract.listTools({ authorization: context.tenancy.grant() });
    expect(listed.ok).toBe(true);
    const refused = await contract.listTools({ authorization: { forged: true } });
    expect(refused.ok).toBe(false);
  });
});

describe("what the views withhold", () => {
  it("never publishes a callback URL", async () => {
    const listed = await contract.listTools({ authorization: context.tenancy.grant() });
    const [tool] = listed.ok ? listed.value : [];
    expect(tool).toBeDefined();
    expect(JSON.stringify(tool)).not.toContain("acme.test");
    expect(Object.keys(tool ?? {})).not.toContain("callbackUrl");
  });

  it("never publishes a resolved header set, and offers no method that could", () => {
    const methods = Object.keys(contract);
    expect(methods.some((method) => /header|credential|secret/iu.test(method))).toBe(false);
  });

  it("never publishes an audit row's arguments or result", async () => {
    context.repository.audit.push({
      toolCallAuditId: asToolsIdentifier("audit-1"),
      environmentId: context.scope.environmentId,
      toolId: asToolsIdentifier<ToolId>("tool-1"),
      toolName: UPLOAD,
      agentId: null,
      threadId: null,
      endUserId: null,
      traceId: null,
      arguments: { secretishQuestion: "what is my password" },
      result: { rows: ["private"] },
      error: null,
      status: "SUCCEEDED",
      latencyMs: 10,
      costCents: null,
      envelope: {
        externalEntityId: null,
        endUserId: null,
        actorUserId: null,
        spanId: null,
        parentSpanId: null,
        source: "turn",
        mcpPrincipalId: null,
        mcpClientId: null,
      },
      createdAt: context.clock.now(),
    });
    const listed = await contract.readToolAudit({ authorization: context.tenancy.grant() });
    const rendered = JSON.stringify(listed.ok ? listed.value : []);
    expect(rendered).not.toContain("what is my password");
    expect(rendered).not.toContain("private");
    expect(rendered).toContain("files.upload");
  });

  it("carries a cost as a canonical decimal STRING, never a number", async () => {
    const listed = await contract.readToolAudit({ authorization: context.tenancy.grant() });
    for (const entry of listed.ok ? listed.value : []) {
      expect(entry.costCents === null || typeof entry.costCents === "string").toBe(true);
    }
  });
});

describe("what the surface deliberately exposes", () => {
  it("answers a permission question WITHOUT the side effect", async () => {
    const decided = await contract.resolvePermission({
      scope: context.scope,
      toolName: asToolsIdentifier<ToolName>("kg.delete_node"),
      agentId: null,
      toolId: null,
    });
    expect(decided.ok && decided.value.state).toBe("require_approval");
    expect(context.dispatch.requests).toEqual([]);
    expect(context.repository.audit).toEqual([]);
  });

  it("binds registration, discovery and execution through one dependency bundle", async () => {
    const registered = await contract.registerTools({
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      externalEntityId: EXTERNAL,
      tools: [{ name: "files.upload" }],
      callbackUrl: "https://acme.test/tools",
    });
    expect(registered.ok && registered.value.registered).toBe(1);
    expect(registered.ok && registered.value.tools[0]?.toolName).toBe("files.upload");

    const executed = await contract.executeTool({
      scope: context.scope,
      toolName: UPLOAD,
      arguments: {},
      agentId: null,
      threadId: null,
      endUserId: null,
      vaultAuthorization: testVaultAuthorization(),
    });
    expect(executed.ok && executed.value.kind).toBe("completed");
  });
});

describe("the integration events", () => {
  it("are dotted and led by the owning context, per the kernel envelope", () => {
    for (const name of TOOLS_EVENT_NAMES) {
      expect(name.startsWith("tools."), name).toBe(true);
      expect(name.split(".").length, name).toBeGreaterThanOrEqual(3);
    }
  });

  it("names each event once", () => {
    expect(new Set(TOOLS_EVENT_NAMES).size).toBe(TOOLS_EVENT_NAMES.length);
  });
});
