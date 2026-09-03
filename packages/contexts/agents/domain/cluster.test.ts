import { asIdentifier, type EnvironmentId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  admitCluster,
  applyClusterPatch,
  byClusterOrder,
  clusterSlugIsTaken,
  electOnJoin,
  electOnLeave,
  MAX_CLUSTER_NAME_LENGTH,
  primaryAgentOf,
  PRIMARY_AGENT_KEY,
  setPrimaryAgent,
  type AgentCluster,
} from "./cluster.js";
import { asAgentsIdentifier, type AgentClusterId, type AgentId, type Slug } from "./identifiers.js";

const ENVIRONMENT = asIdentifier<EnvironmentId>("env-1");
const OTHER = asIdentifier<EnvironmentId>("env-2");
const ALPHA = asAgentsIdentifier<AgentId>("agent-alpha");
const BRAVO = asAgentsIdentifier<AgentId>("agent-bravo");
const NOW = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-02-01T00:00:00.000Z");

function cluster(overrides: Partial<AgentCluster> = {}): AgentCluster {
  return {
    clusterId: asAgentsIdentifier<AgentClusterId>("cluster-1"),
    environmentId: ENVIRONMENT,
    name: "Frontline",
    slug: asAgentsIdentifier<Slug>("frontline"),
    description: null,
    metadata: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("admission", () => {
  it("trims the name and reads a blank description as none", () => {
    const admitted = admitCluster({ name: "  Frontline  ", description: "  " });
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value).toEqual({ name: "Frontline", description: null, primaryAgentId: null });
  });

  it("refuses a blank name and one past the ceiling", () => {
    expect(admitCluster({ name: "   " }).ok).toBe(false);
    expect(admitCluster({ name: "a".repeat(MAX_CLUSTER_NAME_LENGTH + 1) }).ok).toBe(false);
    expect(admitCluster({ name: "a".repeat(MAX_CLUSTER_NAME_LENGTH) }).ok).toBe(true);
  });

  it("reads a blank primary agent as none", () => {
    const admitted = admitCluster({ name: "F", primaryAgentId: "  " });
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.primaryAgentId).toBeNull();
  });
});

describe("the primary agent lives in free-form metadata", () => {
  it("reads it out of the reserved key", () => {
    expect(primaryAgentOf(cluster({ metadata: { [PRIMARY_AGENT_KEY]: ALPHA } }))).toBe(ALPHA);
  });

  it("reads an absent, blank or non-string entry as none", () => {
    expect(primaryAgentOf(cluster())).toBeNull();
    expect(primaryAgentOf(cluster({ metadata: { [PRIMARY_AGENT_KEY]: "" } }))).toBeNull();
    expect(primaryAgentOf(cluster({ metadata: { [PRIMARY_AGENT_KEY]: 7 } }))).toBeNull();
  });

  it("PRESERVES every other metadata key when it sets the primary", () => {
    const held = cluster({ metadata: { region: "eu", [PRIMARY_AGENT_KEY]: ALPHA } });
    expect(setPrimaryAgent(held, BRAVO, LATER).metadata).toEqual({
      region: "eu",
      [PRIMARY_AGENT_KEY]: BRAVO,
    });
  });

  it("DELETES the key rather than writing null when the primary is cleared", () => {
    // A stale primary pointing outside its own cluster is not a display bug —
    // it is a routing decision made against an agent nobody put there.
    const held = cluster({ metadata: { [PRIMARY_AGENT_KEY]: ALPHA } });
    expect(setPrimaryAgent(held, null, LATER).metadata).toBeNull();
  });

  it("keeps the other keys when the primary is cleared and they exist", () => {
    const held = cluster({ metadata: { region: "eu", [PRIMARY_AGENT_KEY]: ALPHA } });
    expect(setPrimaryAgent(held, null, LATER).metadata).toEqual({ region: "eu" });
  });
});

describe("election", () => {
  it("elects the FIRST joiner into a cluster with no primary", () => {
    expect(primaryAgentOf(electOnJoin(cluster(), ALPHA, LATER))).toBe(ALPHA);
  });

  it("leaves an existing primary alone on a later join", () => {
    const held = cluster({ metadata: { [PRIMARY_AGENT_KEY]: ALPHA } });
    expect(electOnJoin(held, BRAVO, LATER)).toBe(held);
    expect(primaryAgentOf(electOnJoin(held, BRAVO, LATER))).toBe(ALPHA);
  });

  it("re-elects a remaining member when the primary leaves", () => {
    const held = cluster({ metadata: { [PRIMARY_AGENT_KEY]: ALPHA } });
    expect(primaryAgentOf(electOnLeave(held, ALPHA, [BRAVO], LATER))).toBe(BRAVO);
  });

  it("CLEARS the key when the LAST member leaves", () => {
    const held = cluster({ metadata: { [PRIMARY_AGENT_KEY]: ALPHA } });
    expect(primaryAgentOf(electOnLeave(held, ALPHA, [], LATER))).toBeNull();
  });

  it("ignores the departing agent even when the caller left it in the list", () => {
    const held = cluster({ metadata: { [PRIMARY_AGENT_KEY]: ALPHA } });
    expect(primaryAgentOf(electOnLeave(held, ALPHA, [ALPHA], LATER))).toBeNull();
  });

  it("does nothing when a NON-primary member leaves", () => {
    const held = cluster({ metadata: { [PRIMARY_AGENT_KEY]: ALPHA } });
    expect(electOnLeave(held, BRAVO, [ALPHA], LATER)).toBe(held);
  });
});

describe("patching", () => {
  it("leaves a field the patch does not carry", () => {
    const patched = applyClusterPatch(cluster({ description: "kept" }), { name: "Renamed" }, LATER);
    expect(patched.name).toBe("Renamed");
    expect(patched.description).toBe("kept");
  });

  it("clears a description on an explicit null", () => {
    expect(applyClusterPatch(cluster({ description: "x" }), { description: null }, LATER).description).toBeNull();
  });

  it("does not touch the primary when the patch omits it", () => {
    const held = cluster({ metadata: { [PRIMARY_AGENT_KEY]: ALPHA } });
    expect(primaryAgentOf(applyClusterPatch(held, { name: "R" }, LATER))).toBe(ALPHA);
  });

  it("clears the primary on an explicit null or empty string", () => {
    const held = cluster({ metadata: { [PRIMARY_AGENT_KEY]: ALPHA } });
    expect(primaryAgentOf(applyClusterPatch(held, { primaryAgentId: null }, LATER))).toBeNull();
    expect(primaryAgentOf(applyClusterPatch(held, { primaryAgentId: "" }, LATER))).toBeNull();
  });

  it("stamps the instant on every patch", () => {
    expect(applyClusterPatch(cluster(), { name: "R" }, LATER).updatedAt).toEqual(LATER);
  });
});

describe("ordering and uniqueness", () => {
  it("puts the newest first and breaks a tie on id, descending", () => {
    const first = cluster({ clusterId: asAgentsIdentifier<AgentClusterId>("a") });
    const second = cluster({ clusterId: asAgentsIdentifier<AgentClusterId>("b") });
    expect([first, second].sort(byClusterOrder).map((held) => held.clusterId)).toEqual(["b", "a"]);
    expect(byClusterOrder(first, first)).toBe(0);
  });

  it("scopes slug uniqueness to the ENVIRONMENT, not the project", () => {
    const held = [cluster(), cluster({ clusterId: asAgentsIdentifier<AgentClusterId>("c2"), environmentId: OTHER })];
    expect(clusterSlugIsTaken(held, ENVIRONMENT, asAgentsIdentifier<Slug>("frontline"))).toBe(true);
    expect(clusterSlugIsTaken(held, asIdentifier<EnvironmentId>("env-3"), asAgentsIdentifier<Slug>("frontline"))).toBe(
      false,
    );
  });

  it("excludes the cluster that already holds it, so a rename to itself passes", () => {
    expect(
      clusterSlugIsTaken(
        [cluster()],
        ENVIRONMENT,
        asAgentsIdentifier<Slug>("frontline"),
        asAgentsIdentifier<AgentClusterId>("cluster-1"),
      ),
    ).toBe(false);
  });
});
