import { asIdentifier, type ProjectId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  admitAgent,
  admitAgentPatch,
  applyAgentPatch,
  byListingOrder,
  deactivate,
  MAX_AGENT_DESCRIPTION_LENGTH,
  MAX_AGENT_NAME_LENGTH,
  touchesAgentRow,
  type Agent,
} from "./agent.js";
import { asAgentsIdentifier, type AgentId, type Slug } from "./identifiers.js";

const PROJECT = asIdentifier<ProjectId>("proj-1");
const NOW = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-02-01T00:00:00.000Z");

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    agentId: asAgentsIdentifier<AgentId>("agent-1"),
    projectId: PROJECT,
    name: "Support",
    slug: asAgentsIdentifier<Slug>("support"),
    description: null,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("admission", () => {
  it("trims every field before it judges it", () => {
    const admitted = admitAgent({ name: "  Support  ", description: "  answers mail  " });
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value).toEqual({ name: "Support", description: "answers mail" });
  });

  it("refuses a name that is empty or only whitespace, naming it", () => {
    const admitted = admitAgent({ name: "   " });
    if (admitted.ok) throw new Error("unreachable");
    expect(admitted.error.fields[0]).toEqual({
      field: "name",
      code: "required",
      message: "name is required",
    });
  });

  it("refuses a name past the ceiling and admits one exactly at it", () => {
    expect(admitAgent({ name: "a".repeat(MAX_AGENT_NAME_LENGTH) }).ok).toBe(true);
    expect(admitAgent({ name: "a".repeat(MAX_AGENT_NAME_LENGTH + 1) }).ok).toBe(false);
  });

  it("reads a blank description as no description rather than refusing", () => {
    const admitted = admitAgent({ name: "Support", description: "   " });
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.description).toBeNull();
  });

  it("refuses a description past its own ceiling", () => {
    const admitted = admitAgent({
      name: "Support",
      description: "a".repeat(MAX_AGENT_DESCRIPTION_LENGTH + 1),
    });
    if (admitted.ok) throw new Error("unreachable");
    expect(admitted.error.fields[0]?.field).toBe("description");
  });
});

describe("the patch keeps absent, null and a value apart", () => {
  it("reads an absent description as leave-alone", () => {
    const patch = admitAgentPatch({ name: "Renamed" });
    if (!patch.ok) throw new Error("unreachable");
    expect(patch.value.description).toBeUndefined();
    expect(applyAgentPatch(agent({ description: "kept" }), patch.value, LATER).description).toBe("kept");
  });

  it("reads an explicit null as clear", () => {
    const patch = admitAgentPatch({ description: null });
    if (!patch.ok) throw new Error("unreachable");
    expect(patch.value.description).toBeNull();
    expect(applyAgentPatch(agent({ description: "kept" }), patch.value, LATER).description).toBeNull();
  });

  it("reads a value as replace", () => {
    const patch = admitAgentPatch({ description: " new " });
    if (!patch.ok) throw new Error("unreachable");
    expect(applyAgentPatch(agent({ description: "old" }), patch.value, LATER).description).toBe("new");
  });

  it("refuses an invalid name inside a patch rather than dropping it", () => {
    expect(admitAgentPatch({ name: "  " }).ok).toBe(false);
  });

  it("reports an empty patch as touching nothing", () => {
    const patch = admitAgentPatch({});
    if (!patch.ok) throw new Error("unreachable");
    expect(touchesAgentRow(patch.value)).toBe(false);
  });

  it("reports a patch that only CLEARS a description as touching the row", () => {
    // The `undefined` sentinel is why this needs its own case: a check written
    // as `!== null` would read a clear as a no-op and skip the write.
    const patch = admitAgentPatch({ description: null });
    if (!patch.ok) throw new Error("unreachable");
    expect(touchesAgentRow(patch.value)).toBe(true);
  });

  it("reports a patch that only flips the active flag as touching the row", () => {
    const patch = admitAgentPatch({ isActive: false });
    if (!patch.ok) throw new Error("unreachable");
    expect(touchesAgentRow(patch.value)).toBe(true);
  });

  it("stamps the update instant on every applied patch", () => {
    const patch = admitAgentPatch({ name: "Renamed" });
    if (!patch.ok) throw new Error("unreachable");
    expect(applyAgentPatch(agent(), patch.value, LATER).updatedAt).toEqual(LATER);
  });
});

describe("deactivation", () => {
  it("clears the flag and stamps the instant, leaving everything else", () => {
    const held = agent();
    const gone = deactivate(held, LATER);
    expect(gone.isActive).toBe(false);
    expect(gone.updatedAt).toEqual(LATER);
    expect(gone.name).toBe(held.name);
    expect(held.isActive).toBe(true);
  });
});

describe("the listing order is total", () => {
  it("puts the newest first", () => {
    const older = agent({ agentId: asAgentsIdentifier<AgentId>("a"), createdAt: NOW });
    const newer = agent({ agentId: asAgentsIdentifier<AgentId>("b"), createdAt: LATER });
    expect([older, newer].sort(byListingOrder)[0]).toBe(newer);
  });

  it("breaks a same-instant tie on id, descending, so paging cannot repeat a row", () => {
    const first = agent({ agentId: asAgentsIdentifier<AgentId>("a") });
    const second = agent({ agentId: asAgentsIdentifier<AgentId>("b") });
    expect([first, second].sort(byListingOrder).map((held) => held.agentId)).toEqual(["b", "a"]);
    expect([second, first].sort(byListingOrder).map((held) => held.agentId)).toEqual(["b", "a"]);
  });

  it("reports an agent as equal to itself", () => {
    expect(byListingOrder(agent(), agent())).toBe(0);
  });
});
