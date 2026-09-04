import { asIdentifier, environmentScope } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { AgentId, ClusterId, EndUserId } from "./identifiers.js";
import {
  canShareAgentScope,
  clusterPeers,
  memorySubject,
  ownershipKey,
  ownershipOf,
  resolveReadBindings,
  resolveWriteBinding,
  sameSubject,
  subjectPath,
  type AgentBinding,
} from "./scope.js";

const ENVIRONMENT = environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1"));
const OTHER_ENVIRONMENT = environmentScope(
  asIdentifier("org-1"),
  asIdentifier("proj-1"),
  asIdentifier("env-2"),
);
const SUBJECT = asIdentifier<EndUserId>("user-1");

const CLUSTER = asIdentifier<ClusterId>("cluster-1");
const OTHER_CLUSTER = asIdentifier<ClusterId>("cluster-2");

function binding(agent: string, cluster: ClusterId | null = null): AgentBinding {
  return { agentId: asIdentifier<AgentId>(agent), clusterId: cluster };
}

const SOLO = binding("agent-1");
const PEER_A = binding("agent-1", CLUSTER);
const PEER_B = binding("agent-2", CLUSTER);
const STRANGER = binding("agent-3", OTHER_CLUSTER);
const LONE = binding("agent-4");

describe("the subject key", () => {
  it("builds on the kernel's resolvePath, so a cache namespace and a log agree", () => {
    expect(subjectPath(memorySubject(ENVIRONMENT, SUBJECT))).toBe(
      "org/org-1/proj/proj-1/env/env-1/user/user-1",
    );
  });

  it("distinguishes the same subject in two environments", () => {
    expect(
      sameSubject(memorySubject(ENVIRONMENT, SUBJECT), memorySubject(OTHER_ENVIRONMENT, SUBJECT)),
    ).toBe(false);
    expect(
      sameSubject(memorySubject(ENVIRONMENT, SUBJECT), memorySubject(ENVIRONMENT, SUBJECT)),
    ).toBe(true);
  });
});

describe("canShareAgentScope — the whole of cross-agent sharing", () => {
  it("an agent always shares scope with itself", () => {
    expect(canShareAgentScope(SOLO, SOLO)).toBe(true);
  });

  it("two agents in ONE cluster share scope, in both directions", () => {
    expect(canShareAgentScope(PEER_A, PEER_B)).toBe(true);
    expect(canShareAgentScope(PEER_B, PEER_A)).toBe(true);
  });

  it("two agents in DIFFERENT clusters do not", () => {
    expect(canShareAgentScope(PEER_A, STRANGER)).toBe(false);
  });

  it("two UNCLUSTERED agents are not one scope, however alike they look", () => {
    expect(canShareAgentScope(SOLO, LONE)).toBe(false);
  });

  it("a clustered agent does not share scope with an unclustered one", () => {
    expect(canShareAgentScope(PEER_A, LONE)).toBe(false);
    expect(canShareAgentScope(LONE, PEER_A)).toBe(false);
  });
});

describe("ownership keys", () => {
  it("serialise a clustered node on its cluster and a solo node on its agent", () => {
    expect(ownershipKey(ownershipOf(PEER_A))).toBe("cluster:cluster-1");
    expect(ownershipKey(ownershipOf(PEER_B))).toBe("cluster:cluster-1");
    expect(ownershipKey(ownershipOf(SOLO))).toBe("agent:agent-1");
  });
});

describe("resolveWriteBinding", () => {
  it("an acting agent owns its own write", () => {
    const resolved = resolveWriteBinding([PEER_A, PEER_B], {
      actingAgentId: PEER_A.agentId,
      requestedAgentId: null,
      sourceThreadBinding: null,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.agentId).toBe(PEER_A.agentId);
  });

  it("honours a NAMED agent inside the acting agent's cluster", () => {
    const resolved = resolveWriteBinding([PEER_A, PEER_B], {
      actingAgentId: PEER_A.agentId,
      requestedAgentId: PEER_B.agentId,
      sourceThreadBinding: null,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.agentId).toBe(PEER_B.agentId);
  });

  it("REFUSES a named agent outside the acting agent's cluster", () => {
    const resolved = resolveWriteBinding([PEER_A, STRANGER], {
      actingAgentId: PEER_A.agentId,
      requestedAgentId: STRANGER.agentId,
      sourceThreadBinding: null,
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("unreachable");
    expect(resolved.error.code).toBe("MEMORY_AGENT_SCOPE_DENIED");
  });

  it("refuses when the ACTING agent is not bound here at all", () => {
    const resolved = resolveWriteBinding([PEER_B], {
      actingAgentId: PEER_A.agentId,
      requestedAgentId: null,
      sourceThreadBinding: null,
    });
    expect(resolved.ok).toBe(false);
  });

  it("lets an operator with no acting agent name one", () => {
    const resolved = resolveWriteBinding([PEER_A, STRANGER], {
      actingAgentId: null,
      requestedAgentId: STRANGER.agentId,
      sourceThreadBinding: null,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.agentId).toBe(STRANGER.agentId);
  });

  it("falls back to the SOURCE THREAD's agent when nothing was named", () => {
    const resolved = resolveWriteBinding([PEER_A, PEER_B], {
      actingAgentId: null,
      requestedAgentId: null,
      sourceThreadBinding: PEER_B,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.agentId).toBe(PEER_B.agentId);
  });

  it("uses the only binding in a single-agent environment", () => {
    const resolved = resolveWriteBinding([SOLO], {
      actingAgentId: null,
      requestedAgentId: null,
      sourceThreadBinding: null,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.agentId).toBe(SOLO.agentId);
  });

  it("REFUSES rather than picking the first of several bindings", () => {
    const resolved = resolveWriteBinding([PEER_A, PEER_B], {
      actingAgentId: null,
      requestedAgentId: null,
      sourceThreadBinding: null,
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("unreachable");
    expect(resolved.error.code).toBe("MEMORY_AGENT_AMBIGUOUS");
    expect(resolved.error.details["candidateCount"]).toBe(2);
  });

  it("refuses an empty environment", () => {
    const resolved = resolveWriteBinding([], {
      actingAgentId: null,
      requestedAgentId: null,
      sourceThreadBinding: null,
    });
    expect(resolved.ok).toBe(false);
  });
});

describe("resolveReadBindings", () => {
  it("returns the acting agent when nothing was named", () => {
    const resolved = resolveReadBindings([PEER_A, PEER_B], {
      actingAgentId: PEER_A.agentId,
      requestedAgentIds: [],
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.map((entry) => entry.agentId)).toEqual([PEER_A.agentId]);
  });

  it("preserves the CALLER's order, not the store's", () => {
    const resolved = resolveReadBindings([PEER_A, PEER_B], {
      actingAgentId: PEER_A.agentId,
      requestedAgentIds: [PEER_B.agentId, PEER_A.agentId],
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.map((entry) => entry.agentId)).toEqual([PEER_B.agentId, PEER_A.agentId]);
  });

  it("de-duplicates a repeated agent id", () => {
    const resolved = resolveReadBindings([PEER_A, PEER_B], {
      actingAgentId: null,
      requestedAgentIds: [PEER_A.agentId, PEER_A.agentId],
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value).toHaveLength(1);
  });

  it("REFUSES a named agent outside the acting agent's cluster", () => {
    const resolved = resolveReadBindings([PEER_A, STRANGER], {
      actingAgentId: PEER_A.agentId,
      requestedAgentIds: [STRANGER.agentId],
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("unreachable");
    expect(resolved.error.code).toBe("MEMORY_AGENT_SCOPE_DENIED");
  });

  it("refuses an agent that is not bound in this environment", () => {
    const resolved = resolveReadBindings([PEER_A], {
      actingAgentId: null,
      requestedAgentIds: [asIdentifier<AgentId>("agent-99")],
    });
    expect(resolved.ok).toBe(false);
  });

  it("reads the whole environment when it holds ONE agent", () => {
    const resolved = resolveReadBindings([SOLO], { actingAgentId: null, requestedAgentIds: [] });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value).toEqual([SOLO]);
  });

  it("reads the whole environment when every agent shares ONE cluster", () => {
    const resolved = resolveReadBindings([PEER_A, PEER_B], {
      actingAgentId: null,
      requestedAgentIds: [],
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value).toHaveLength(2);
  });

  it("REFUSES a mixed environment rather than reading one agent's slice", () => {
    const resolved = resolveReadBindings([PEER_A, STRANGER], {
      actingAgentId: null,
      requestedAgentIds: [],
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("unreachable");
    expect(resolved.error.code).toBe("MEMORY_AGENT_SCOPE_DENIED");
  });

  it("refuses an environment whose agents are all UNCLUSTERED and several", () => {
    expect(
      resolveReadBindings([SOLO, LONE], { actingAgentId: null, requestedAgentIds: [] }).ok,
    ).toBe(false);
  });

  it("refuses an operator naming two agents from different clusters", () => {
    expect(
      resolveReadBindings([PEER_A, STRANGER], {
        actingAgentId: null,
        requestedAgentIds: [PEER_A.agentId, STRANGER.agentId],
      }).ok,
    ).toBe(false);
  });

  it("refuses an empty environment", () => {
    expect(resolveReadBindings([], { actingAgentId: null, requestedAgentIds: [] }).ok).toBe(false);
  });
});

describe("clusterPeers", () => {
  it("is the whole cluster for a clustered agent", () => {
    expect(clusterPeers([PEER_A, PEER_B, STRANGER], PEER_A).map((entry) => entry.agentId)).toEqual([
      PEER_A.agentId,
      PEER_B.agentId,
    ]);
  });

  it("is the agent ALONE when it has no cluster", () => {
    expect(clusterPeers([SOLO, LONE], SOLO)).toEqual([SOLO]);
  });
});
