import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { OperatorSessionId } from "./identifiers.js";
import { userId } from "./record-builders.js";
import {
  childSessionsOf,
  closeSessionRevocation,
  revokeSessionsFor,
} from "./session-revocation.js";

const NOW = new Date("2026-08-08T00:00:00.000Z");
const session = (value: string) => asIdentifier<OperatorSessionId>(value);

describe("the privilege-change revocation rule", () => {
  it("always includes impersonated sessions", () => {
    const order = revokeSessionsFor(userId("u1"), "membership-role-changed", NOW);
    expect(order.userId).toBe("u1");
    expect(order.revokedAt).toEqual(NOW);
    // Both `userId` and `impersonatedUserId` are matched by the database rule.
    // Dropping the second half would leave a platform operator impersonating
    // the demoted user still holding the privileges the demotion removed.
    expect(order.includeImpersonatedSessions).toBe(true);
  });

  it("names why the sessions ended", () => {
    expect(revokeSessionsFor(userId("u1"), "membership-deactivated", NOW).cause).toBe(
      "membership-deactivated",
    );
    expect(revokeSessionsFor(userId("u1"), "membership-removed", NOW).cause).toBe(
      "membership-removed",
    );
  });
});

describe("the revocation cascade rule", () => {
  const links = [
    { id: session("root"), parentSessionId: null },
    { id: session("child-a"), parentSessionId: session("root") },
    { id: session("child-b"), parentSessionId: session("root") },
    { id: session("grandchild"), parentSessionId: session("child-a") },
    { id: session("unrelated"), parentSessionId: session("other-root") },
  ];

  it("finds the direct children of a session", () => {
    expect([...childSessionsOf(session("root"), links)]).toEqual(["child-a", "child-b"]);
    expect(childSessionsOf(session("child-b"), links)).toHaveLength(0);
  });

  it("closes over the whole descendant chain, excluding the root itself", () => {
    const revoked = [...closeSessionRevocation(session("root"), links)].sort();
    expect(revoked).toEqual(["child-a", "child-b", "grandchild"]);
    expect(revoked).not.toContain("root");
    expect(revoked).not.toContain("unrelated");
  });

  it("terminates on a cycle rather than looping forever", () => {
    const cyclic = [
      { id: session("a"), parentSessionId: session("b") },
      { id: session("b"), parentSessionId: session("a") },
    ];
    expect([...closeSessionRevocation(session("a"), cyclic)].sort()).toEqual(["a", "b"]);
  });
});
