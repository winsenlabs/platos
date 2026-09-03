import { describe, expect, it } from "vitest";

import { asAgentsIdentifier, type ActorId, type AgentId, type AgentVersionId } from "./identifiers.js";
import { DEFAULT_AGENTS_POLICY } from "./policy.js";
import { buildSnapshot } from "./snapshot.js";
import {
  admitNote,
  byVersionOrder,
  DAY_MS,
  featureFlagNote,
  INITIAL_VERSION_NOTE,
  MAX_VERSION_NOTE_LENGTH,
  nextVersionNumber,
  planPrune,
  rollbackNote,
  toolPolicyNote,
  windowFor,
  type AgentVersion,
} from "./version.js";

const AGENT = asAgentsIdentifier<AgentId>("agent-1");
const POLICY = DEFAULT_AGENTS_POLICY.versions;
const NOW = new Date("2026-06-01T00:00:00.000Z");

function version(number: number, overrides: Partial<AgentVersion> = {}): AgentVersion {
  return {
    agentVersionId: asAgentsIdentifier<AgentVersionId>(`version-${number}`),
    agentId: AGENT,
    versionNumber: number,
    toolDefaultPolicy: "ALL",
    note: null,
    createdBy: asAgentsIdentifier<ActorId>("operator-1"),
    createdAt: NOW,
    snapshot: buildSnapshot({}, DEFAULT_AGENTS_POLICY.defaults),
    ...overrides,
  };
}

describe("notes", () => {
  it("spells the first version's note exactly as the source does", () => {
    expect(INITIAL_VERSION_NOTE).toBe("Initial version");
  });

  it("spells a rollback note with the number it restored", () => {
    expect(rollbackNote(7)).toBe("Rollback to v7");
  });

  it("spells a tool flip both ways", () => {
    expect(toolPolicyNote("tool-1", true)).toBe("Enable Agent Tool tool-1");
    expect(toolPolicyNote("tool-1", false)).toBe("Disable Agent Tool tool-1");
  });

  it("gets the feature-flag note's singular and plural right", () => {
    expect(featureFlagNote(1)).toBe("Feature flags updated (1 key)");
    expect(featureFlagNote(2)).toBe("Feature flags updated (2 keys)");
    expect(featureFlagNote(0)).toBe("Feature flags updated (0 keys)");
  });

  it("reads an absent or blank note as no note", () => {
    for (const supplied of [undefined, null, "   "]) {
      const admitted = admitNote(supplied);
      if (!admitted.ok) throw new Error("unreachable");
      expect(admitted.value).toBeNull();
    }
  });

  it("trims a supplied note", () => {
    const admitted = admitNote("  tightened the prompt  ");
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value).toBe("tightened the prompt");
  });

  it("refuses a note past the ceiling", () => {
    expect(admitNote("a".repeat(MAX_VERSION_NOTE_LENGTH + 1)).ok).toBe(false);
    expect(admitNote("a".repeat(MAX_VERSION_NOTE_LENGTH)).ok).toBe(true);
  });
});

describe("numbering", () => {
  it("starts at 1 for an agent with no versions", () => {
    expect(nextVersionNumber([])).toBe(1);
  });

  it("takes the HIGHEST observed number plus one, not the count", () => {
    // A pruned history has gaps; counting rows would re-issue a used number.
    expect(nextVersionNumber([1, 2, 9])).toBe(10);
  });

  it("ignores a non-finite entry rather than propagating it", () => {
    expect(nextVersionNumber([1, Number.NaN, 3])).toBe(4);
  });

  it("does not go backwards for an unordered input", () => {
    expect(nextVersionNumber([9, 1, 5])).toBe(10);
  });
});

describe("the history order is total", () => {
  it("puts the highest number first", () => {
    expect([version(1), version(3)].sort(byVersionOrder).map((held) => held.versionNumber)).toEqual([3, 1]);
  });

  it("breaks a same-number tie on id, descending", () => {
    const left = version(1, { agentVersionId: asAgentsIdentifier<AgentVersionId>("a") });
    const right = version(1, { agentVersionId: asAgentsIdentifier<AgentVersionId>("b") });
    expect([left, right].sort(byVersionOrder).map((held) => held.agentVersionId)).toEqual(["b", "a"]);
    expect([right, left].sort(byVersionOrder).map((held) => held.agentVersionId)).toEqual(["b", "a"]);
  });

  it("reports a version as equal to itself", () => {
    expect(byVersionOrder(version(1), version(1))).toBe(0);
  });
});

describe("the page window", () => {
  it("clamps a request above the ceiling", () => {
    expect(windowFor({ take: 10_000 }, POLICY).take).toBe(POLICY.maxPageSize);
  });

  it("clamps a request at or below zero to one", () => {
    expect(windowFor({ take: 0 }, POLICY).take).toBe(1);
    expect(windowFor({ take: -5 }, POLICY).take).toBe(1);
  });

  it("uses the policy default when no size is asked for", () => {
    expect(windowFor({}, POLICY).take).toBe(POLICY.defaultPageSize);
  });

  it("floors a fractional size", () => {
    expect(windowFor({ take: 7.9 }, POLICY).take).toBe(7);
  });

  it("clamps a negative offset to zero", () => {
    expect(windowFor({ offset: -3 }, POLICY).offset).toBe(0);
  });

  it("REPORTS ZERO OFFSET whenever a cursor is supplied", () => {
    // A cursor and an offset are mutually exclusive and the cursor wins.
    // Reporting the requested offset alongside a cursor-paged result would tell
    // a client it is somewhere it is not.
    const window = windowFor({ cursor: "version-3", offset: 40 }, POLICY);
    expect(window.cursor).toBe("version-3");
    expect(window.offset).toBe(0);
  });
});

describe("the prune plan", () => {
  const live = {
    activeVersionId: asAgentsIdentifier<AgentVersionId>("version-10"),
    canaryVersionId: asAgentsIdentifier<AgentVersionId>("version-9"),
  };
  const old = new Date(NOW.getTime() - 200 * DAY_MS);
  const history = [
    version(10, { createdAt: old }),
    version(9, { createdAt: old }),
    version(8, { createdAt: old }),
    version(7, { createdAt: old }),
    version(6, { createdAt: NOW }),
  ];

  it("never touches the live version, however old", () => {
    const plan = planPrune(history, live, { keepNewest: 1, keepDays: 1 }, POLICY, NOW);
    expect(plan.eligible).not.toContain(live.activeVersionId);
  });

  it("never touches the canary version, however old", () => {
    const plan = planPrune(history, live, { keepNewest: 1, keepDays: 1 }, POLICY, NOW);
    expect(plan.eligible).not.toContain(live.canaryVersionId);
  });

  it("keeps the newest N whatever their age", () => {
    // version-8 is as old as version-7 and is kept purely because it is inside
    // the newest three; version-7 falls outside and is the only candidate.
    const plan = planPrune(history, live, { keepNewest: 3, keepDays: 1 }, POLICY, NOW);
    expect(plan.eligible).toEqual(["version-7"]);
  });

  it("lets the newest-N window widen to protect everything", () => {
    const plan = planPrune(history, live, { keepNewest: history.length, keepDays: 1 }, POLICY, NOW);
    expect(plan.eligible).toEqual([]);
  });

  it("keeps anything younger than the cutoff even when it is outside the newest N", () => {
    const plan = planPrune(history, live, { keepNewest: 1, keepDays: 90 }, POLICY, NOW);
    expect(plan.eligible).not.toContain("version-6");
  });

  it("reports what it kept, and that it deleted nothing", () => {
    const plan = planPrune(history, live, { keepNewest: 1, keepDays: 1 }, POLICY, NOW);
    expect(plan.kept).toBe(history.length - plan.eligible.length);
    expect(plan.dryRun).toBe(true);
  });

  it("clamps a keep-count below one, so a plan can never propose deleting everything", () => {
    const plan = planPrune(history, live, { keepNewest: 0, keepDays: 0 }, POLICY, NOW);
    expect(plan.keepNewest).toBe(1);
    expect(plan.keepDays).toBe(1);
    expect(plan.eligible).not.toContain("version-10");
  });

  it("falls back to the policy retention when the request names none", () => {
    const plan = planPrune(history, live, {}, POLICY, NOW);
    expect(plan.keepNewest).toBe(POLICY.keepNewest);
    expect(plan.keepDays).toBe(POLICY.keepDays);
  });

  it("dates the cutoff from the supplied instant, never the wall clock", () => {
    const plan = planPrune(history, live, { keepDays: 10 }, POLICY, NOW);
    expect(plan.cutoff).toEqual(new Date(NOW.getTime() - 10 * DAY_MS));
  });

  it("plans nothing for an agent with one version", () => {
    const plan = planPrune([version(1)], { activeVersionId: asAgentsIdentifier<AgentVersionId>("version-1"), canaryVersionId: null }, {}, POLICY, NOW);
    expect(plan.eligible).toEqual([]);
    expect(plan.kept).toBe(1);
  });
});
