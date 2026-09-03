import { asIdentifier, type EnvironmentId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { asAgentsIdentifier, type ActorId, type AgentId, type PostmanTemplateId } from "./identifiers.js";
import {
  admitTemplate,
  applyTemplatePatch,
  byTemplateOrder,
  defaultsToDemote,
  demote,
  findDefault,
  MAX_SIMULATED_USER_LENGTH,
  MAX_TEMPLATE_NAME_LENGTH,
  type PostmanTemplate,
} from "./postman-template.js";

const ENVIRONMENT = asIdentifier<EnvironmentId>("env-1");
const OTHER = asIdentifier<EnvironmentId>("env-2");
const AGENT = asAgentsIdentifier<AgentId>("agent-1");
const SIBLING = asAgentsIdentifier<AgentId>("agent-2");
const NOW = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-02-01T00:00:00.000Z");

function template(overrides: Partial<PostmanTemplate> = {}): PostmanTemplate {
  return {
    templateId: asAgentsIdentifier<PostmanTemplateId>("template-1"),
    environmentId: ENVIRONMENT,
    agentId: AGENT,
    name: "Smoke",
    simulateUserId: "end-user-1",
    sessionContext: null,
    isDefault: false,
    createdBy: asAgentsIdentifier<ActorId>("operator-1"),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("admission", () => {
  it("trims both operator-supplied strings", () => {
    const admitted = admitTemplate({ agentId: AGENT, name: "  Smoke  ", simulateUserId: " u1 " });
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.name).toBe("Smoke");
    expect(admitted.value.simulateUserId).toBe("u1");
  });

  it("refuses a blank name or simulated user, naming the field", () => {
    const blankName = admitTemplate({ agentId: AGENT, name: " ", simulateUserId: "u" });
    if (blankName.ok) throw new Error("unreachable");
    expect(blankName.error.fields[0]?.field).toBe("name");
    const blankUser = admitTemplate({ agentId: AGENT, name: "n", simulateUserId: "  " });
    if (blankUser.ok) throw new Error("unreachable");
    expect(blankUser.error.fields[0]?.field).toBe("simulateUserId");
  });

  it("refuses either string past its ceiling", () => {
    expect(
      admitTemplate({ agentId: AGENT, name: "a".repeat(MAX_TEMPLATE_NAME_LENGTH + 1), simulateUserId: "u" }).ok,
    ).toBe(false);
    expect(
      admitTemplate({
        agentId: AGENT,
        name: "n",
        simulateUserId: "u".repeat(MAX_SIMULATED_USER_LENGTH + 1),
      }).ok,
    ).toBe(false);
  });

  it("defaults isDefault to false and the session context to null", () => {
    const admitted = admitTemplate({ agentId: AGENT, name: "n", simulateUserId: "u" });
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.isDefault).toBe(false);
    expect(admitted.value.sessionContext).toBeNull();
  });
});

describe("the single-default invariant is per [environment, agent]", () => {
  const held = [
    template({ templateId: asAgentsIdentifier<PostmanTemplateId>("t1"), isDefault: true }),
    template({
      templateId: asAgentsIdentifier<PostmanTemplateId>("t2"),
      agentId: SIBLING,
      isDefault: true,
    }),
    template({
      templateId: asAgentsIdentifier<PostmanTemplateId>("t3"),
      environmentId: OTHER,
      isDefault: true,
    }),
  ];

  it("DEMOTES ONLY THIS AGENT'S DEFAULT, not every default in the environment", () => {
    // One missing clause here silently clears the default template of every
    // other agent in the environment, with no error and nothing an operator
    // would notice until they opened a different agent.
    expect(defaultsToDemote(held, ENVIRONMENT, AGENT).map((entry) => entry.templateId)).toEqual(["t1"]);
  });

  it("does not reach into another environment", () => {
    expect(defaultsToDemote(held, ENVIRONMENT, AGENT).map((entry) => entry.templateId)).not.toContain("t3");
  });

  it("excludes the template being promoted, so promoting the incumbent is a no-op", () => {
    expect(
      defaultsToDemote(held, ENVIRONMENT, AGENT, asAgentsIdentifier<PostmanTemplateId>("t1")),
    ).toEqual([]);
  });

  it("ignores templates that are not the default", () => {
    expect(defaultsToDemote([template()], ENVIRONMENT, AGENT)).toEqual([]);
  });

  it("finds the default for one agent, and none for an agent that has none", () => {
    expect(findDefault(held, ENVIRONMENT, AGENT)?.templateId).toBe("t1");
    expect(findDefault([template()], ENVIRONMENT, AGENT)).toBeNull();
  });

  it("demotes without touching anything else", () => {
    const held0 = template({ isDefault: true });
    const demoted = demote(held0, LATER);
    expect(demoted.isDefault).toBe(false);
    expect(demoted.updatedAt).toEqual(LATER);
    expect(held0.isDefault).toBe(true);
  });
});

describe("patching", () => {
  it("leaves a field the patch does not carry", () => {
    const patched = applyTemplatePatch(template({ simulateUserId: "kept" }), { name: "Renamed" }, LATER);
    expect(patched.name).toBe("Renamed");
    expect(patched.simulateUserId).toBe("kept");
  });

  it("clears a session context on an explicit null and keeps it when absent", () => {
    const held = template({ sessionContext: { locale: "en" } });
    expect(applyTemplatePatch(held, { sessionContext: null }, LATER).sessionContext).toBeNull();
    expect(applyTemplatePatch(held, { name: "R" }, LATER).sessionContext).toEqual({ locale: "en" });
  });

  it("clears the default flag one-way, with NO automatic succession", () => {
    const patched = applyTemplatePatch(template({ isDefault: true }), { isDefault: false }, LATER);
    expect(patched.isDefault).toBe(false);
  });

  it("stamps the instant on every patch", () => {
    expect(applyTemplatePatch(template(), { name: "R" }, LATER).updatedAt).toEqual(LATER);
  });
});

describe("ordering", () => {
  it("puts defaults first", () => {
    const plain = template({ templateId: asAgentsIdentifier<PostmanTemplateId>("a") });
    const starred = template({ templateId: asAgentsIdentifier<PostmanTemplateId>("b"), isDefault: true });
    expect([plain, starred].sort(byTemplateOrder)[0]).toBe(starred);
  });

  it("then the most recently updated", () => {
    const stale = template({ templateId: asAgentsIdentifier<PostmanTemplateId>("a"), updatedAt: NOW });
    const fresh = template({ templateId: asAgentsIdentifier<PostmanTemplateId>("b"), updatedAt: LATER });
    expect([stale, fresh].sort(byTemplateOrder)[0]).toBe(fresh);
  });

  it("then by id descending, so paging cannot repeat a row", () => {
    const first = template({ templateId: asAgentsIdentifier<PostmanTemplateId>("a") });
    const second = template({ templateId: asAgentsIdentifier<PostmanTemplateId>("b") });
    expect([first, second].sort(byTemplateOrder).map((held) => held.templateId)).toEqual(["b", "a"]);
    expect(byTemplateOrder(first, first)).toBe(0);
  });
});
