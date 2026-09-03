import { describe, expect, it } from "vitest";

import {
  asAgentsIdentifier,
  collisionToken,
  primaryAgentOf,
  type AgentBindingId,
  type AgentClusterId,
  type AgentId,
  type AgentVersionId,
  type Slug,
} from "../domain/index.js";
import {
  addAgentToCluster,
  createCluster,
  describeCluster,
  listClusters,
  removeAgentFromCluster,
  removeCluster,
  updateCluster,
} from "./clusters.js";
import { buildAgentsTestContext, seedBoundAgent, testAgent, testCluster, testEnvironmentScope } from "./testing/fixtures.js";
import { updateAgent } from "./update-agent.js";

function newContext() {
  const context = buildAgentsTestContext();
  return { context, authorization: context.tenancy.grant() };
}

describe("creating a cluster", () => {
  it("derives the slug from the name", async () => {
    const { context, authorization } = newContext();
    const created = await createCluster(context.dependencies, { authorization, name: "Front Line" });
    if (!created.ok) throw new Error("unreachable");
    expect(created.value.cluster.slug).toBe("front-line");
    expect(created.value.members).toEqual([]);
  });

  it("disambiguates a taken slug inside the environment", async () => {
    const { context, authorization } = newContext();
    context.repository.seedCluster(testCluster(context.scope));
    const created = await createCluster(context.dependencies, { authorization, name: "Frontline" });
    if (!created.ok) throw new Error("unreachable");
    expect(created.value.cluster.slug).toMatch(/^frontline-/u);
  });

  // THE REFUSAL THE DISAMBIGUATION LEAVES BEHIND, and the one arrangement in
  // this file that reached it was none. `resolveSlug` is ONE ROUND by design:
  // "frontline" is taken, so it appends the millisecond token — and if THAT is
  // taken too, which is what two clusters created in the same millisecond look
  // like, the use case must refuse. Until this case existed the whole guard
  // could be deleted at full green, and the failure it prevents is an opaque
  // unique-index violation reaching an operator instead of a sentence.
  it("REFUSES when even the disambiguated slug is taken, rather than leaving it to the index", async () => {
    const { context, authorization } = newContext();
    context.repository.seedCluster(testCluster(context.scope));
    context.repository.seedCluster(
      testCluster(context.scope, {
        clusterId: asAgentsIdentifier<AgentClusterId>("cluster-2"),
        slug: asAgentsIdentifier<Slug>(`frontline-${collisionToken(context.clock.now())}`),
      }),
    );
    const created = await createCluster(context.dependencies, { authorization, name: "Frontline" });
    expect(created.ok).toBe(false);
    if (created.ok) throw new Error("unreachable");
    expect(created.error.code).toBe("AGENTS_CLUSTER_ALREADY_EXISTS");
    // THE CODE ALONE PROVES NOTHING HERE, and that is the whole trap: the store
    // double simulates the unique index and raises the SAME error, so this case
    // would pass just as happily with the guard deleted. What separates the two
    // is WHERE the refusal happened — no insert was ever issued.
    expect(context.repository.writes).toEqual([]);
    expect(context.unitOfWork.transactions).toHaveLength(0);
  });

  it("ignores a same-slug cluster in ANOTHER environment", async () => {
    const { context, authorization } = newContext();
    context.repository.seedCluster(
      testCluster(testEnvironmentScope("env-9"), { clusterId: asAgentsIdentifier<AgentClusterId>("c-else") }),
    );
    const created = await createCluster(context.dependencies, { authorization, name: "Frontline" });
    if (!created.ok) throw new Error("unreachable");
    expect(created.value.cluster.slug).toBe("frontline");
  });

  it("elects a named primary agent", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    const created = await createCluster(context.dependencies, {
      authorization,
      name: "Frontline",
      primaryAgentId: seeded.agent.agentId,
    });
    if (!created.ok) throw new Error("unreachable");
    expect(primaryAgentOf(created.value.cluster)).toBe(seeded.agent.agentId);
  });

  it("REFUSES a primary agent that is not bound here", async () => {
    const { context, authorization } = newContext();
    context.repository.seedAgent(
      testAgent(context.scope, { agentId: asAgentsIdentifier<AgentId>("agent-unbound") }),
    );
    const created = await createCluster(context.dependencies, {
      authorization,
      name: "Frontline",
      primaryAgentId: "agent-unbound",
    });
    if (created.ok) throw new Error("unreachable");
    expect(created.error.code).toBe("AGENTS_AGENT_NOT_BOUND");
  });

  it("refuses a blank name before it touches the store", async () => {
    const { context, authorization } = newContext();
    expect((await createCluster(context.dependencies, { authorization, name: "  " })).ok).toBe(false);
    expect(context.repository.writes).toEqual([]);
  });
});

describe("membership IS the binding", () => {
  it("joins an agent by writing its binding, and reports it as a member", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    const cluster = context.repository.seedCluster(testCluster(context.scope));
    const joined = await addAgentToCluster(context.dependencies, {
      authorization,
      clusterId: cluster.clusterId,
      agentId: seeded.agent.agentId,
    });
    if (!joined.ok) throw new Error("unreachable");
    expect(joined.value.members).toEqual([seeded.agent.agentId]);
    expect(context.repository.bindings.get(seeded.binding.agentBindingId)?.clusterId).toBe(cluster.clusterId);
  });

  it("elects the FIRST joiner as primary and leaves it alone on the second", async () => {
    const { context, authorization } = newContext();
    const first = seedBoundAgent(context);
    const second = seedBoundAgent(context, {
      agent: { agentId: asAgentsIdentifier<AgentId>("agent-2"), slug: asAgentsIdentifier<Slug>("second") },
      version: { agentVersionId: asAgentsIdentifier<AgentVersionId>("version-2") },
      binding: { agentBindingId: asAgentsIdentifier<AgentBindingId>("binding-2") },
    });
    const cluster = context.repository.seedCluster(testCluster(context.scope));

    const joined = await addAgentToCluster(context.dependencies, {
      authorization,
      clusterId: cluster.clusterId,
      agentId: first.agent.agentId,
    });
    if (!joined.ok) throw new Error("unreachable");
    expect(primaryAgentOf(joined.value.cluster)).toBe(first.agent.agentId);

    const second_ = await addAgentToCluster(context.dependencies, {
      authorization,
      clusterId: cluster.clusterId,
      agentId: second.agent.agentId,
    });
    if (!second_.ok) throw new Error("unreachable");
    expect(primaryAgentOf(second_.value.cluster)).toBe(first.agent.agentId);
  });

  it("re-elects a remaining member when the primary leaves", async () => {
    const { context, authorization } = newContext();
    const first = seedBoundAgent(context);
    const second = seedBoundAgent(context, {
      agent: { agentId: asAgentsIdentifier<AgentId>("agent-2"), slug: asAgentsIdentifier<Slug>("second") },
      version: { agentVersionId: asAgentsIdentifier<AgentVersionId>("version-2") },
      binding: { agentBindingId: asAgentsIdentifier<AgentBindingId>("binding-2") },
    });
    const cluster = context.repository.seedCluster(testCluster(context.scope));
    await addAgentToCluster(context.dependencies, {
      authorization,
      clusterId: cluster.clusterId,
      agentId: first.agent.agentId,
    });
    await addAgentToCluster(context.dependencies, {
      authorization,
      clusterId: cluster.clusterId,
      agentId: second.agent.agentId,
    });

    const left = await removeAgentFromCluster(context.dependencies, {
      authorization,
      clusterId: cluster.clusterId,
      agentId: first.agent.agentId,
    });
    if (!left.ok) throw new Error("unreachable");
    expect(primaryAgentOf(left.value.cluster)).toBe(second.agent.agentId);
    expect(left.value.members).toEqual([second.agent.agentId]);
  });

  it("CLEARS the primary when the last member leaves", async () => {
    const { context, authorization } = newContext();
    const only = seedBoundAgent(context);
    const cluster = context.repository.seedCluster(testCluster(context.scope));
    await addAgentToCluster(context.dependencies, {
      authorization,
      clusterId: cluster.clusterId,
      agentId: only.agent.agentId,
    });
    const left = await removeAgentFromCluster(context.dependencies, {
      authorization,
      clusterId: cluster.clusterId,
      agentId: only.agent.agentId,
    });
    if (!left.ok) throw new Error("unreachable");
    expect(primaryAgentOf(left.value.cluster)).toBeNull();
    expect(left.value.members).toEqual([]);
  });

  it("refuses to join an agent this environment cannot see", async () => {
    const { context, authorization } = newContext();
    const cluster = context.repository.seedCluster(testCluster(context.scope));
    expect(
      (
        await addAgentToCluster(context.dependencies, {
          authorization,
          clusterId: cluster.clusterId,
          agentId: asAgentsIdentifier<AgentId>("nope"),
        })
      ).ok,
    ).toBe(false);
  });

  it("refuses a cluster from another environment", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    const elsewhere = context.repository.seedCluster(
      testCluster(testEnvironmentScope("env-9"), { clusterId: asAgentsIdentifier<AgentClusterId>("c-else") }),
    );
    const joined = await addAgentToCluster(context.dependencies, {
      authorization,
      clusterId: elsewhere.clusterId,
      agentId: seeded.agent.agentId,
    });
    if (joined.ok) throw new Error("unreachable");
    expect(joined.error.code).toBe("AGENTS_CLUSTER_NOT_FOUND");
  });
});

describe("deleting a cluster", () => {
  it("DETACHES its members before it removes the row", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    const cluster = context.repository.seedCluster(testCluster(context.scope));
    await addAgentToCluster(context.dependencies, {
      authorization,
      clusterId: cluster.clusterId,
      agentId: seeded.agent.agentId,
    });
    const removed = await removeCluster(context.dependencies, { authorization, clusterId: cluster.clusterId });
    if (!removed.ok) throw new Error("unreachable");
    expect(removed.value).toBe(true);
    expect(context.repository.bindings.get(seeded.binding.agentBindingId)?.clusterId).toBeNull();
    expect(context.repository.clusters.size).toBe(0);
  });

  it("does both writes in ONE transaction", async () => {
    const { context, authorization } = newContext();
    const cluster = context.repository.seedCluster(testCluster(context.scope));
    context.repository.writes.length = 0;
    await removeCluster(context.dependencies, { authorization, clusterId: cluster.clusterId });
    const transactions = new Set(context.repository.writes.map((write) => write.split(":")[1]));
    expect(transactions.size).toBe(1);
  });

  it("answers false for a cluster this environment cannot see", async () => {
    const { context, authorization } = newContext();
    const removed = await removeCluster(context.dependencies, {
      authorization,
      clusterId: asAgentsIdentifier<AgentClusterId>("nope"),
    });
    if (!removed.ok) throw new Error("unreachable");
    expect(removed.value).toBe(false);
  });
});

describe("reading and patching", () => {
  it("lists in the newest-first order", async () => {
    const { context, authorization } = newContext();
    context.repository.seedCluster(testCluster(context.scope, { clusterId: asAgentsIdentifier<AgentClusterId>("a") }));
    context.repository.seedCluster(
      testCluster(context.scope, {
        clusterId: asAgentsIdentifier<AgentClusterId>("b"),
        slug: asAgentsIdentifier<Slug>("second"),
      }),
    );
    const listed = await listClusters(context.dependencies, { authorization });
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value.map((cluster) => cluster.clusterId)).toEqual(["b", "a"]);
  });

  it("describes a cluster with its members", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    const cluster = context.repository.seedCluster(testCluster(context.scope));
    await updateAgent(context.dependencies, {
      authorization,
      agentId: seeded.agent.agentId,
      updatedBy: "operator-1",
      clusterId: cluster.clusterId,
    });
    const described = await describeCluster(context.dependencies, {
      authorization,
      clusterId: cluster.clusterId,
    });
    if (!described.ok) throw new Error("unreachable");
    expect(described.value.members).toEqual([seeded.agent.agentId]);
  });

  it("renames without touching the primary", async () => {
    const { context, authorization } = newContext();
    const seeded = seedBoundAgent(context);
    const cluster = context.repository.seedCluster(
      testCluster(context.scope, { metadata: { primaryAgentId: seeded.agent.agentId } }),
    );
    const patched = await updateCluster(context.dependencies, {
      authorization,
      clusterId: cluster.clusterId,
      name: "Renamed",
    });
    if (!patched.ok) throw new Error("unreachable");
    expect(patched.value.cluster.name).toBe("Renamed");
    expect(primaryAgentOf(patched.value.cluster)).toBe(seeded.agent.agentId);
  });

  it("refuses a patch naming a primary that is not bound here", async () => {
    const { context, authorization } = newContext();
    const cluster = context.repository.seedCluster(testCluster(context.scope));
    expect(
      (
        await updateCluster(context.dependencies, {
          authorization,
          clusterId: cluster.clusterId,
          primaryAgentId: "agent-nope",
        })
      ).ok,
    ).toBe(false);
  });

  it("refuses to describe a cluster this environment cannot see", async () => {
    const { context, authorization } = newContext();
    expect(
      (await describeCluster(context.dependencies, { authorization, clusterId: asAgentsIdentifier("nope") })).ok,
    ).toBe(false);
  });
});
