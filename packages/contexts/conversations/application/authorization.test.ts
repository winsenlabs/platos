// The three ways in, and the two refusals that must differ.
//
// Mutations M-Z1 (`verifyAuthorization`), M-Z2 (the operator scope comparison),
// M-Z3 (the runtime ancestry comparison), M-Z4 (the ownership check).

import { describe, expect, it } from "vitest";
import { asIdentifier, type EnvironmentScope } from "@platos/kernel";

import { requireOwnedThread, requireVisibleThread, runtimeScope, verifyOperator, verifyRuntime } from "./authorization.js";
import { buildConversationsTestContext, END_USER_ID, runtimeGrant, threadFixture } from "./testing/index.js";
import type { EndUserId } from "../domain/index.js";

function scope(overrides: Partial<Record<string, string>> = {}): EnvironmentScope {
  return {
    level: "environment",
    organizationId: overrides.organizationId ?? "org-1",
    projectId: overrides.projectId ?? "proj-1",
    environmentId: overrides.environmentId ?? "env-1",
  } as EnvironmentScope;
}

describe("verifyOperator", () => {
  it("admits a MINTED grant for its own scope", () => {
    const context = buildConversationsTestContext();
    const verified = verifyOperator(context.dependencies, context.tenancy.grant(), context.scope);
    expect(verified.ok).toBe(true);
  });

  it("refuses a hand-built object with the right SHAPE — identity, not shape", () => {
    const context = buildConversationsTestContext();
    const forged = {
      principalType: "operator",
      tier: "OPERATOR",
      access: "metadata",
      scope: context.scope,
      actorUserId: "operator-1",
      effectiveUserId: "operator-1",
      organizationRole: "ADMIN",
      projectRole: null,
    };
    const refused = verifyOperator(context.dependencies, forged, context.scope);
    expect(refused.ok).toBe(false);
  });

  it("refuses a grant minted for ANOTHER environment, and never says not_found", () => {
    const context = buildConversationsTestContext();
    const elsewhere = context.tenancy.grant(scope({ environmentId: "env-2" }));
    const refused = verifyOperator(context.dependencies, elsewhere, context.scope);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CONVERSATIONS_SCOPE_MISMATCH");
    expect(refused.error.category).toBe("forbidden");
  });

  it("compares the WHOLE ancestry: a matching leaf under another project refuses", () => {
    const context = buildConversationsTestContext();
    const reparented = context.tenancy.grant(scope({ projectId: "proj-2" }));
    const refused = verifyOperator(context.dependencies, reparented, context.scope);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.details.grantedPath).toBe("org-1/proj-2/env-1");
    expect(refused.error.details.expectedPath).toBe("org-1/proj-1/env-1");
  });
});

describe("verifyRuntime", () => {
  it("admits a grant whose whole ancestry matches", () => {
    expect(verifyRuntime(runtimeGrant(), scope()).ok).toBe(true);
  });

  it("refuses on the ORGANIZATION, the PROJECT and the ENVIRONMENT independently", () => {
    for (const differing of ["organizationId", "projectId", "environmentId"] as const) {
      const refused = verifyRuntime(runtimeGrant(scope({ [differing]: "other" })), scope());
      expect(refused.ok).toBe(false);
      if (refused.ok) continue;
      expect(refused.error.code).toBe("CONVERSATIONS_SCOPE_MISMATCH");
    }
  });

  it("answers the SAME grant, so a caller cannot verify one and pass another on", () => {
    const grant = runtimeGrant();
    const verified = verifyRuntime(grant, scope());
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.value).toBe(grant);
  });

  it("renders a runtime grant's ancestry as a kernel scope", () => {
    const derived = runtimeScope(runtimeGrant());
    expect(derived.organizationId).toBe("org-1");
    expect(derived.projectId).toBe("proj-1");
    expect(derived.environmentId).toBe("env-1");
  });
});

describe("the two thread refusals, which MUST differ", () => {
  const other = asIdentifier<EndUserId>("end-user-2");

  it("shows an end user their own thread", () => {
    const thread = threadFixture();
    const owned = requireOwnedThread(thread, thread.threadId, END_USER_ID);
    expect(owned.ok).toBe(true);
    if (!owned.ok) return;
    expect(owned.value).toBe(thread);
  });

  it("hides ANOTHER end user's thread behind the SAME code as an absent one", () => {
    const thread = threadFixture();
    const foreign = requireOwnedThread(thread, thread.threadId, other);
    const absent = requireOwnedThread(null, thread.threadId, END_USER_ID);
    expect(foreign.ok).toBe(false);
    expect(absent.ok).toBe(false);
    if (foreign.ok || absent.ok) return;
    // Indistinguishable on purpose: an end user who could tell them apart could
    // enumerate a tenant's threads by id.
    expect(foreign.error.code).toBe(absent.error.code);
    expect(foreign.error.code).toBe("CONVERSATIONS_THREAD_NOT_FOUND");
  });

  it("tells an OPERATOR the two apart, because the grant already entitles them", () => {
    const thread = threadFixture();
    const foreign = requireVisibleThread(thread, thread.threadId, other);
    const absent = requireVisibleThread(null, thread.threadId, END_USER_ID);
    expect(foreign.ok).toBe(false);
    expect(absent.ok).toBe(false);
    if (foreign.ok || absent.ok) return;
    expect(foreign.error.code).toBe("CONVERSATIONS_THREAD_FORBIDDEN");
    expect(absent.error.code).toBe("CONVERSATIONS_THREAD_NOT_FOUND");
    expect(foreign.error.code).not.toBe(absent.error.code);
  });

  it("lets an operator read ANY end user's thread when it names none", () => {
    const thread = threadFixture();
    const seen = requireVisibleThread(thread, thread.threadId, null);
    expect(seen.ok).toBe(true);
  });

  it("answers the SAME thread on both paths, so a check cannot be swapped for a fetch", () => {
    const thread = threadFixture();
    const owned = requireOwnedThread(thread, thread.threadId, END_USER_ID);
    const visible = requireVisibleThread(thread, thread.threadId, null);
    if (!owned.ok || !visible.ok) throw new Error("expected both to admit");
    expect(owned.value).toBe(thread);
    expect(visible.value).toBe(thread);
  });
});
