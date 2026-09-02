import { asIdentifier, environmentScope } from "@platos/kernel";
import { requireAuthorization } from "@platos/context-tenancy";
import { describe, expect, it } from "vitest";

import {
  authorizeMemoryRuntime,
  type AgentId,
  type ClusterId,
  type EndUserId,
  type ThreadId,
} from "../domain/index.js";
import {
  authorizeRead,
  authorizeWrite,
  requireAccess,
  subjectFor,
  verifyGrant,
  verifyRuntime,
} from "./authorization.js";
import {
  AGENT,
  bindingFixture,
  CLUSTER,
  ENVIRONMENT_SCOPE,
  harness,
  OUTSIDE_AGENT,
  PEER_AGENT,
  runtimeGrant,
  SUBJECT_ID,
  THREAD,
} from "./testing/fixtures.js";

describe("verifyGrant", () => {
  it("recognises this context's own runtime grant WITHOUT asking tenancy", () => {
    const { dependencies, tenancy } = harness();
    const verified = verifyGrant(dependencies, runtimeGrant());
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("unreachable");
    expect(verified.value.kind).toBe("runtime");
    expect(tenancy.verifyCalls).toBe(0);
  });

  it("ASKS tenancy about anything else", () => {
    const { dependencies, tenancy } = harness();
    const verified = verifyGrant(dependencies, tenancy.grant());
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("unreachable");
    expect(verified.value.kind).toBe("operator");
    expect(tenancy.verifyCalls).toBe(1);
  });

  it("refuses a hand-written literal", () => {
    const { dependencies } = harness();
    expect(verifyGrant(dependencies, { scope: ENVIRONMENT_SCOPE, access: "secret:mutate" }).ok).toBe(
      false,
    );
    expect(verifyGrant(dependencies, null).ok).toBe(false);
  });

  it("takes the environment FROM the grant, never from a caller", () => {
    const { dependencies } = harness();
    const verified = verifyGrant(dependencies, runtimeGrant({ environmentId: "env-9" }));
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("unreachable");
    expect(verified.value.environment.environmentId).toBe("env-9");
  });
});

describe("the REAL published tenancy check", () => {
  it("rejects a structurally complete literal, so the seam cannot be unsound", () => {
    // The in-memory double recognises its own mark; this pins that the value the
    // composition root actually calls refuses anything it did not mint.
    const literal = {
      scope: ENVIRONMENT_SCOPE,
      access: "secret:mutate",
      actorUserId: "operator-1",
      effectiveUserId: "operator-1",
      principalType: "operator",
      tier: "OPERATOR",
    };
    expect(requireAuthorization(literal).ok).toBe(false);
  });
});

describe("verifyRuntime", () => {
  it("accepts only a runtime grant, never an operator one", () => {
    const { dependencies, tenancy } = harness();
    expect(verifyRuntime(dependencies, runtimeGrant()).ok).toBe(true);
    const refused = verifyRuntime(dependencies, tenancy.grant());
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error.code).toBe("MEMORY_SCOPE_MISMATCH");
  });
});

describe("requireAccess", () => {
  it("refuses a mutation under a `metadata` operator grant", () => {
    const { dependencies, tenancy } = harness();
    const granted = verifyGrant(dependencies, tenancy.grant("metadata"));
    expect(granted.ok).toBe(true);
    if (!granted.ok) throw new Error("unreachable");
    const required = requireAccess(granted.value, "secret:mutate");
    expect(required.ok).toBe(false);
    if (required.ok) throw new Error("unreachable");
    expect(required.error.code).toBe("MEMORY_SCOPE_MISMATCH");
  });

  it("permits a read under a `metadata` grant", () => {
    const { dependencies, tenancy } = harness();
    const granted = verifyGrant(dependencies, tenancy.grant("metadata"));
    if (!granted.ok) throw new Error("unreachable");
    expect(requireAccess(granted.value, "metadata").ok).toBe(true);
  });

  it("permits a mutation under the runtime grant, which extraction needs", () => {
    const { dependencies } = harness();
    const granted = verifyGrant(dependencies, runtimeGrant());
    if (!granted.ok) throw new Error("unreachable");
    expect(requireAccess(granted.value, "secret:mutate").ok).toBe(true);
  });
});

describe("subjectFor", () => {
  it("takes the subject from a RUNTIME grant and ignores a matching claim", () => {
    const { dependencies } = harness();
    const granted = verifyGrant(dependencies, runtimeGrant());
    if (!granted.ok) throw new Error("unreachable");
    const subject = subjectFor(granted.value, { endUserId: SUBJECT_ID, actingAgentId: null });
    expect(subject.ok).toBe(true);
    if (!subject.ok) throw new Error("unreachable");
    expect(subject.value.endUserId).toBe(SUBJECT_ID);
    // The grant names the acting agent; the command's null does not win.
    expect(subject.value.actingAgentId).toBe(AGENT);
  });

  it("REFUSES a command that names a DIFFERENT subject than the runtime grant", () => {
    const { dependencies } = harness();
    const granted = verifyGrant(dependencies, runtimeGrant());
    if (!granted.ok) throw new Error("unreachable");
    const subject = subjectFor(granted.value, {
      endUserId: asIdentifier<EndUserId>("user-2"),
      actingAgentId: null,
    });
    expect(subject.ok).toBe(false);
    if (subject.ok) throw new Error("unreachable");
    expect(subject.error.code).toBe("MEMORY_SCOPE_MISMATCH");
  });

  it("takes the subject from the COMMAND under an operator grant", () => {
    const { dependencies, tenancy } = harness();
    const granted = verifyGrant(dependencies, tenancy.grant());
    if (!granted.ok) throw new Error("unreachable");
    const subject = subjectFor(granted.value, { endUserId: SUBJECT_ID, actingAgentId: AGENT });
    expect(subject.ok).toBe(true);
    if (!subject.ok) throw new Error("unreachable");
    expect(subject.value.actingAgentId).toBe(AGENT);
  });

  it("refuses an operator command with no subject", () => {
    const { dependencies, tenancy } = harness();
    const granted = verifyGrant(dependencies, tenancy.grant());
    if (!granted.ok) throw new Error("unreachable");
    const subject = subjectFor(granted.value, { endUserId: null, actingAgentId: null });
    expect(subject.ok).toBe(false);
    if (subject.ok) throw new Error("unreachable");
    expect(subject.error.code).toBe("MEMORY_END_USER_CONTEXT_REQUIRED");
  });

  it("refuses an operator command with a BLANK subject", () => {
    const { dependencies, tenancy } = harness();
    const granted = verifyGrant(dependencies, tenancy.grant());
    if (!granted.ok) throw new Error("unreachable");
    expect(
      subjectFor(granted.value, { endUserId: asIdentifier<EndUserId>("   "), actingAgentId: null }).ok,
    ).toBe(false);
  });
});

describe("authorizeRead", () => {
  it("resolves the agents a runtime grant may see", async () => {
    const { dependencies } = harness();
    const scope = await authorizeRead(dependencies, {
      authorization: runtimeGrant(),
      endUserId: null,
      actingAgentId: null,
      requestedAgentIds: [],
    });
    expect(scope.ok).toBe(true);
    if (!scope.ok) throw new Error("unreachable");
    expect(scope.value.agentIds).toEqual([AGENT]);
  });

  it("refuses an agent outside the acting agent's cluster", async () => {
    const { dependencies, repository } = harness();
    repository.setBindings([
      bindingFixture({ agentId: AGENT, clusterId: CLUSTER }),
      bindingFixture({ agentId: OUTSIDE_AGENT, clusterId: null }),
    ]);
    const scope = await authorizeRead(dependencies, {
      authorization: runtimeGrant(),
      endUserId: null,
      actingAgentId: null,
      requestedAgentIds: [OUTSIDE_AGENT],
    });
    expect(scope.ok).toBe(false);
    if (scope.ok) throw new Error("unreachable");
    expect(scope.error.code).toBe("MEMORY_AGENT_SCOPE_DENIED");
  });

  it("surfaces a repository failure rather than an empty agent set", async () => {
    const { dependencies, repository } = harness();
    repository.failWith("store down");
    const scope = await authorizeRead(dependencies, {
      authorization: runtimeGrant(),
      endUserId: null,
      actingAgentId: null,
      requestedAgentIds: [],
    });
    expect(scope.ok).toBe(false);
    if (scope.ok) throw new Error("unreachable");
    expect(scope.error.code).toBe("MEMORY_REPOSITORY_UNAVAILABLE");
  });
});

describe("authorizeWrite", () => {
  it("resolves the one agent a write is attributed to", async () => {
    const { dependencies } = harness();
    const scope = await authorizeWrite(dependencies, {
      authorization: runtimeGrant(),
      endUserId: null,
      actingAgentId: null,
      requestedAgentId: null,
      sourceThreadId: null,
    });
    expect(scope.ok).toBe(true);
    if (!scope.ok) throw new Error("unreachable");
    expect(scope.value.binding.agentId).toBe(AGENT);
    expect(scope.value.bindings).toHaveLength(1);
  });

  it("REFUSES a write under a `metadata` operator grant", async () => {
    const { dependencies, tenancy } = harness();
    const scope = await authorizeWrite(dependencies, {
      authorization: tenancy.grant("metadata"),
      endUserId: SUBJECT_ID,
      actingAgentId: AGENT,
      requestedAgentId: null,
      sourceThreadId: null,
    });
    expect(scope.ok).toBe(false);
    if (scope.ok) throw new Error("unreachable");
    expect(scope.error.code).toBe("MEMORY_SCOPE_MISMATCH");
  });

  it("attributes a write to the SOURCE THREAD's agent when nothing was named", async () => {
    const { dependencies, repository, tenancy } = harness();
    repository.setBindings([
      bindingFixture({ agentId: AGENT, clusterId: CLUSTER }),
      bindingFixture({ agentId: PEER_AGENT, clusterId: CLUSTER }),
    ]);
    repository.seedThread(THREAD, { agentId: PEER_AGENT, clusterId: CLUSTER }, SUBJECT_ID);
    const scope = await authorizeWrite(dependencies, {
      authorization: tenancy.grant(),
      endUserId: SUBJECT_ID,
      actingAgentId: null,
      requestedAgentId: null,
      sourceThreadId: THREAD,
    });
    expect(scope.ok).toBe(true);
    if (!scope.ok) throw new Error("unreachable");
    expect(scope.value.binding.agentId).toBe(PEER_AGENT);
  });

  it("REFUSES a source thread that belongs to ANOTHER subject", async () => {
    const { dependencies, repository, tenancy } = harness();
    repository.seedThread(THREAD, { agentId: AGENT, clusterId: null }, asIdentifier<EndUserId>("user-2"));
    const scope = await authorizeWrite(dependencies, {
      authorization: tenancy.grant(),
      endUserId: SUBJECT_ID,
      actingAgentId: null,
      requestedAgentId: null,
      sourceThreadId: THREAD,
    });
    expect(scope.ok).toBe(false);
    if (scope.ok) throw new Error("unreachable");
    expect(scope.error.code).toBe("MEMORY_SCOPE_MISMATCH");
  });

  it("REFUSES a source thread that does not exist in this environment", async () => {
    const { dependencies, tenancy } = harness();
    const scope = await authorizeWrite(dependencies, {
      authorization: tenancy.grant(),
      endUserId: SUBJECT_ID,
      actingAgentId: null,
      requestedAgentId: null,
      sourceThreadId: asIdentifier<ThreadId>("thread-elsewhere"),
    });
    expect(scope.ok).toBe(false);
  });

  it("REFUSES when the writing agent is outside the source thread's scope", async () => {
    const { dependencies, repository, tenancy } = harness();
    repository.setBindings([
      bindingFixture({ agentId: AGENT, clusterId: null }),
      bindingFixture({ agentId: OUTSIDE_AGENT, clusterId: null }),
    ]);
    repository.seedThread(THREAD, { agentId: OUTSIDE_AGENT, clusterId: null }, SUBJECT_ID);
    const scope = await authorizeWrite(dependencies, {
      authorization: tenancy.grant(),
      endUserId: SUBJECT_ID,
      actingAgentId: null,
      requestedAgentId: AGENT,
      sourceThreadId: THREAD,
    });
    expect(scope.ok).toBe(false);
    if (scope.ok) throw new Error("unreachable");
    expect(scope.error.code).toBe("MEMORY_SCOPE_MISMATCH");
  });

  it("refuses an ambiguous multi-agent environment", async () => {
    const { dependencies, repository, tenancy } = harness();
    repository.setBindings([
      bindingFixture({ agentId: AGENT, clusterId: null }),
      bindingFixture({ agentId: PEER_AGENT, clusterId: null }),
    ]);
    const scope = await authorizeWrite(dependencies, {
      authorization: tenancy.grant(),
      endUserId: SUBJECT_ID,
      actingAgentId: null,
      requestedAgentId: null,
      sourceThreadId: null,
    });
    expect(scope.ok).toBe(false);
    if (scope.ok) throw new Error("unreachable");
    expect(scope.error.code).toBe("MEMORY_AGENT_AMBIGUOUS");
  });
});

describe("the runtime grant's environment is the one used", () => {
  it("a grant for another environment reads that environment, not the fixture's", async () => {
    const { dependencies } = harness();
    const elsewhere = authorizeMemoryRuntime({
      ancestry: {
        organizationId: asIdentifier("org-1"),
        projectId: asIdentifier("proj-1"),
        environmentId: asIdentifier("env-9"),
      },
      endUserId: SUBJECT_ID,
      actingAgentId: asIdentifier<AgentId>("agent-1"),
      actorId: asIdentifier("actor-1"),
    });
    const scope = await authorizeRead(dependencies, {
      authorization: elsewhere,
      endUserId: null,
      actingAgentId: null,
      requestedAgentIds: [],
    });
    expect(scope.ok).toBe(true);
    if (!scope.ok) throw new Error("unreachable");
    expect(scope.value.environment.environmentId).toBe("env-9");
    expect(scope.value.subject.environment).toEqual(
      environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-9")),
    );
    expect(ENVIRONMENT_SCOPE.environmentId).toBe("env-1");
    expect(CLUSTER).toBe("cluster-1");
  });
});
