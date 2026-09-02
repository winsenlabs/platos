import { describe, expect, it } from "vitest";

import {
  agentOpinion,
  decidePermission,
  effectFromState,
  isMutatingToolName,
  matchesPattern,
  mostRestrictive,
  organizationOpinion,
  PERMISSION_STATES,
  sessionOpinion,
  stateFromEffect,
  stateRank,
  type PermissionState,
  type TierOpinions,
} from "./permission.js";
import { PLATFORM_TIER_MINIMUMS, platformMinimumFor } from "./platform-baseline.js";

function opinions(overrides: Partial<TierOpinions> = {}): TierOpinions {
  return { platform: "auto_allow", organization: null, agent: null, session: null, ...overrides };
}

describe("the lattice", () => {
  it("declares exactly the three states, in increasing severity", () => {
    expect([...PERMISSION_STATES]).toEqual(["auto_allow", "require_approval", "block"]);
    expect(stateRank("auto_allow")).toBeLessThan(stateRank("require_approval"));
    expect(stateRank("require_approval")).toBeLessThan(stateRank("block"));
  });

  it("is a max, so tightening is the only direction any tier can move it", () => {
    expect(mostRestrictive("auto_allow", "require_approval")).toBe("require_approval");
    expect(mostRestrictive("block", "auto_allow")).toBe("block");
    expect(mostRestrictive("require_approval", "auto_allow", null)).toBe("require_approval");
  });

  it("is commutative, associative and idempotent, so tier order cannot change the answer", () => {
    const values: readonly PermissionState[] = ["auto_allow", "require_approval", "block"];
    for (const a of values) {
      for (const b of values) {
        expect(mostRestrictive(a, b)).toBe(mostRestrictive(b, a));
        expect(mostRestrictive(a, a)).toBe(a);
        for (const c of values) {
          expect(mostRestrictive(mostRestrictive(a, b), c)).toBe(mostRestrictive(a, mostRestrictive(b, c)));
        }
      }
    }
  });

  it("treats silence as no opinion, not as permission", () => {
    expect(mostRestrictive(null, null)).toBe("auto_allow");
    expect(mostRestrictive(null, "block")).toBe("block");
  });
});

describe("pattern matching", () => {
  it("supports exactly three forms and no general glob", () => {
    expect(matchesPattern("*", "anything.at.all")).toBe(true);
    expect(matchesPattern("gdpr.export", "gdpr.export")).toBe(true);
    expect(matchesPattern("gdpr.*", "gdpr.export")).toBe(true);
    expect(matchesPattern("gdpr*", "gdpr.export")).toBe(false);
    expect(matchesPattern("*.delete", "kg.delete")).toBe(false);
  });

  it("covers the namespace's own root, which is the tool the rule was written for", () => {
    expect(matchesPattern("gdpr.*", "gdpr")).toBe(true);
  });

  it("does not let a prefix leak into a sibling namespace", () => {
    expect(matchesPattern("agents.*", "agents_admin.delete")).toBe(false);
  });
});

describe("mapping a two-valued column onto a three-valued state", () => {
  it("round-trips the two states a column can hold", () => {
    expect(stateFromEffect("ALLOW")).toBe("auto_allow");
    expect(stateFromEffect("DENY")).toBe("block");
    expect(effectFromState("auto_allow")).toBe("ALLOW");
    expect(effectFromState("block")).toBe("DENY");
  });

  it("has no column for require_approval and says so rather than rounding", () => {
    expect(effectFromState("require_approval")).toBeNull();
  });
});

describe("tier 2 — the organization", () => {
  const policies = [
    { pattern: "*", effect: "ALLOW" as const },
    { pattern: "channels.*", effect: "DENY" as const },
  ];

  it("lets the STRICTEST matching pattern win, not the most specific", () => {
    expect(organizationOpinion(policies, "channels.delete")).toBe("block");
  });

  it("cannot be punched through by a narrow allow under a broad block", () => {
    const inverted = [
      { pattern: "channels.*", effect: "DENY" as const },
      { pattern: "channels.list", effect: "ALLOW" as const },
    ];
    expect(organizationOpinion(inverted, "channels.list")).toBe("block");
  });

  it("says nothing when no pattern covers the name", () => {
    expect(organizationOpinion([{ pattern: "kg.*", effect: "DENY" }], "files.upload")).toBeNull();
  });
});

describe("tier 3 — the agent version", () => {
  it("lets an explicit row win over the version default", () => {
    expect(agentOpinion({ defaultPolicy: "NONE", explicitEffect: "ALLOW" })).toBe("auto_allow");
    expect(agentOpinion({ defaultPolicy: "ALL", explicitEffect: "DENY" })).toBe("block");
  });

  it("is DEFAULT-DENY on NONE, because silence there is an operator's decision", () => {
    expect(agentOpinion({ defaultPolicy: "NONE", explicitEffect: null })).toBe("block");
    expect(agentOpinion({ defaultPolicy: "ALL", explicitEffect: null })).toBe("auto_allow");
  });

  it("blocks an agent whose active version is not deployed in this scope", () => {
    expect(agentOpinion(null)).toBe("block");
  });
});

describe("tier 4 — the session", () => {
  it("prefers an exact key over a pattern", () => {
    expect(sessionOpinion({ "files.*": "block", "files.upload": "auto_allow" }, "files.upload")).toBe(
      "auto_allow",
    );
  });

  it("falls back to the first matching pattern in the author's own order", () => {
    expect(sessionOpinion({ "files.*": "require_approval" }, "files.upload")).toBe("require_approval");
  });

  it("says nothing when there are no overrides at all", () => {
    expect(sessionOpinion(null, "files.upload")).toBeNull();
    expect(sessionOpinion({}, "files.upload")).toBeNull();
  });
});

describe("composing a decision", () => {
  it("reports the tier that BLOCKED, not the composed severity", () => {
    expect(decidePermission("x", opinions({ organization: "block", session: "block" }))).toEqual({
      state: "block",
      tier: 2,
      reason: "org-policy block",
    });
  });

  it("reports the LAST tier holding the winning state, the one a caller can change", () => {
    const decided = decidePermission(
      "x",
      opinions({ platform: "require_approval", session: "require_approval" }),
    );
    expect(decided).toEqual({ state: "require_approval", tier: 4, reason: "tier-4 require_approval" });
  });

  it("lets a session override tighten but never loosen", () => {
    expect(
      decidePermission("x", opinions({ platform: "require_approval", session: "auto_allow" })).state,
    ).toBe("require_approval");
    expect(decidePermission("x", opinions({ session: "require_approval" })).state).toBe(
      "require_approval",
    );
  });

  it("defaults to auto_allow when every tier is silent", () => {
    expect(decidePermission("files.upload", opinions())).toEqual({
      state: "auto_allow",
      tier: 1,
      reason: "tier-1 auto_allow",
    });
  });
});

describe("the admin-token escalation", () => {
  it("adds friction to a mutating tool", () => {
    const decided = decidePermission("kg.create_node", opinions(), "admin");
    expect(decided.state).toBe("require_approval");
    expect(decided.reason).toContain("admin-token auto-escalate");
  });

  it("leaves a read alone, which is the regression it was revised to fix", () => {
    expect(decidePermission("platos.whoami", opinions(), "admin").state).toBe("auto_allow");
    expect(decidePermission("agents.list", opinions(), "admin").state).toBe("auto_allow");
    expect(decidePermission("entities.get", opinions(), "admin").state).toBe("auto_allow");
  });

  it("does not fire for a scope token", () => {
    expect(decidePermission("kg.create_node", opinions(), "scope").state).toBe("auto_allow");
  });

  it("cannot resurrect a blocked call", () => {
    expect(decidePermission("kg.create_node", opinions({ agent: "block" }), "admin").state).toBe("block");
  });
});

describe("the read/mutate heuristic", () => {
  it("treats an unknown name as mutating", () => {
    expect(isMutatingToolName("something.brand_new")).toBe(true);
  });

  it("recognises the read shapes it is anchored on", () => {
    for (const name of [
      "agents.list",
      "providers.list_keys",
      "entities.get",
      "entities.get_tools",
      "kg.search_entities".replace("_entities", ""),
      "agents.census",
      "platos.whoami",
      "providers.test_credentials",
      "alert_channels.test",
      "jobs.validate_handler",
      "monitoring.cost_daily",
      "events.recent",
      "tool_calls.list",
      "reflection.explain_turn",
    ]) {
      expect(isMutatingToolName(name), name).toBe(false);
    }
  });

  it("anchors rather than substring-matches, so a read word mid-name stays gated", () => {
    expect(isMutatingToolName("unlist.everything")).toBe(true);
    expect(isMutatingToolName("agents.listing")).toBe(true);
    expect(isMutatingToolName("agents.delete_list")).toBe(true);
  });

  it("does NOT catch a mutator whose name is spelled like a read, and that is the known gap", () => {
    // `.list_[a-z_]+$` covers `list_keys` and `list_members`, and it covers
    // `list_and_delete` with them. The heuristic is a SECOND line — the
    // platform baseline in `platform-baseline.ts` is the first, and it names
    // what is destructive explicitly rather than inferring it. Pinning the gap
    // here is what stops it being discovered as a surprise.
    expect(isMutatingToolName("agents.list_and_delete")).toBe(false);
  });
});

describe("the platform baseline", () => {
  it("gates every tool an entry names", () => {
    for (const rule of PLATFORM_TIER_MINIMUMS) {
      const probe = rule.pattern.endsWith(".*") ? `${rule.pattern.slice(0, -2)}.probe` : rule.pattern;
      expect(platformMinimumFor(probe), rule.pattern).toBe(rule.minimum);
    }
  });

  it("lets an unlisted tool through", () => {
    expect(platformMinimumFor("files.upload")).toBe("auto_allow");
    expect(platformMinimumFor("memories.archive")).toBe("auto_allow");
    expect(platformMinimumFor("oauth.revoke_token")).toBe("auto_allow");
  });

  it("keeps the reversible neighbour of every gated tool open", () => {
    expect(platformMinimumFor("memories.bulk_delete")).toBe("require_approval");
    expect(platformMinimumFor("memories.restore")).toBe("auto_allow");
    expect(platformMinimumFor("oauth.delete_client")).toBe("require_approval");
    expect(platformMinimumFor("channels.list")).toBe("auto_allow");
  });

  it("makes first-match and strictest-match agree, so the table's order is not load-bearing", () => {
    // The table DOES overlap: `gdpr.*` covers `gdpr.export_user_everywhere`,
    // which is listed separately under the cross-scope group. That is harmless
    // only while every overlapping pair agrees on its minimum — which is the
    // property pinned here, rather than the stronger and false claim that
    // nothing overlaps. A future entry that disagreed would make the answer
    // depend on where in the list it was written.
    for (const outer of PLATFORM_TIER_MINIMUMS) {
      for (const inner of PLATFORM_TIER_MINIMUMS) {
        if (outer === inner) continue;
        const probe = inner.pattern.endsWith(".*") ? `${inner.pattern.slice(0, -2)}.probe` : inner.pattern;
        if (!matchesPattern(outer.pattern, probe) || !matchesPattern(inner.pattern, probe)) continue;
        expect(outer.minimum, `${outer.pattern} disagrees with ${inner.pattern}`).toBe(inner.minimum);
      }
    }
  });

  it("names no pattern twice", () => {
    const patterns = PLATFORM_TIER_MINIMUMS.map((rule) => rule.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
  });
});
