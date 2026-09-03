import { asIdentifier, type EnvironmentId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  activateVersion,
  admitCanary,
  applyCanary,
  assignCluster,
  chooseVersion,
  clampCanaryPercent,
  MAX_CANARY_PERCENT,
  MIN_CANARY_PERCENT,
  promoteCanary,
  unbind,
  type AgentBinding,
} from "./binding.js";
import {
  asAgentsIdentifier,
  type AgentBindingId,
  type AgentClusterId,
  type AgentId,
  type AgentVersionId,
} from "./identifiers.js";

const ACTIVE = asAgentsIdentifier<AgentVersionId>("version-active");
const CANARY = asAgentsIdentifier<AgentVersionId>("version-canary");
const NOW = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-02-01T00:00:00.000Z");
const BOTH = (versionId: AgentVersionId) => versionId === ACTIVE || versionId === CANARY;
const ACTIVE_ONLY = (versionId: AgentVersionId) => versionId === ACTIVE;

function binding(overrides: Partial<AgentBinding> = {}): AgentBinding {
  return {
    agentBindingId: asAgentsIdentifier<AgentBindingId>("binding-1"),
    environmentId: asIdentifier<EnvironmentId>("env-1"),
    agentId: asAgentsIdentifier<AgentId>("agent-1"),
    activeVersionId: ACTIVE,
    canaryVersionId: null,
    clusterId: null,
    canaryPercent: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("the percentage clamp", () => {
  it("clamps below zero and above a hundred", () => {
    expect(clampCanaryPercent(-5)).toBe(MIN_CANARY_PERCENT);
    expect(clampCanaryPercent(150)).toBe(MAX_CANARY_PERCENT);
  });

  it("TRUNCATES rather than rounding", () => {
    // Rounding would move a canary's share on the first save made through a
    // surface that emits floats.
    expect(clampCanaryPercent(12.9)).toBe(12);
  });

  it("FAILS CLOSED on a request that is not a number", () => {
    // The source's own expression yields NaN here, which is written to the
    // column and makes every later comparison false: a canary that silently
    // never fires and cannot be dialled back.
    expect(clampCanaryPercent(Number.NaN)).toBe(MIN_CANARY_PERCENT);
  });

  it("clamps the infinities without a special case", () => {
    expect(clampCanaryPercent(Number.POSITIVE_INFINITY)).toBe(MAX_CANARY_PERCENT);
    expect(clampCanaryPercent(Number.NEGATIVE_INFINITY)).toBe(MIN_CANARY_PERCENT);
  });
});

describe("admitting a canary", () => {
  it("keeps the version at a non-zero percentage", () => {
    expect(admitCanary({ canaryVersionId: CANARY, canaryPercent: 10 })).toEqual({
      canaryVersionId: CANARY,
      canaryPercent: 10,
    });
  });

  it("CLEARS THE VERSION at zero percent", () => {
    // Dialling to zero is how a canary is cancelled, so cancelling it must also
    // forget which version it was — otherwise every listing keeps showing one.
    expect(admitCanary({ canaryVersionId: CANARY, canaryPercent: 0 })).toEqual({
      canaryVersionId: null,
      canaryPercent: 0,
    });
  });

  it("clears the version when a negative percentage clamps to zero", () => {
    expect(admitCanary({ canaryVersionId: CANARY, canaryPercent: -1 }).canaryVersionId).toBeNull();
  });

  it("stamps the instant when applied, leaving the active version alone", () => {
    const applied = applyCanary(binding(), admitCanary({ canaryVersionId: CANARY, canaryPercent: 5 }), LATER);
    expect(applied.canaryVersionId).toBe(CANARY);
    expect(applied.activeVersionId).toBe(ACTIVE);
    expect(applied.updatedAt).toEqual(LATER);
  });
});

describe("promotion", () => {
  it("moves the canary onto active and clears the split", () => {
    const promoted = promoteCanary(binding({ canaryVersionId: CANARY, canaryPercent: 25 }), LATER);
    if (!promoted.ok) throw new Error("unreachable");
    expect(promoted.value.activeVersionId).toBe(CANARY);
    expect(promoted.value.canaryVersionId).toBeNull();
    expect(promoted.value.canaryPercent).toBe(MIN_CANARY_PERCENT);
  });

  it("REFUSES when there is nothing in canary", () => {
    // Promoting the version that is already active would mint an audit record
    // saying a promotion happened when nothing moved.
    const promoted = promoteCanary(binding(), LATER);
    if (promoted.ok) throw new Error("unreachable");
    expect(promoted.error.code).toBe("AGENTS_CANARY_ABSENT");
  });

  it("does not mutate the binding it was given", () => {
    const held = binding({ canaryVersionId: CANARY, canaryPercent: 25 });
    promoteCanary(held, LATER);
    expect(held.canaryVersionId).toBe(CANARY);
  });
});

describe("version selection", () => {
  it("takes an existing lock before it looks at the split", () => {
    const chosen = chooseVersion(binding({ canaryVersionId: CANARY, canaryPercent: 100 }), {
      lockedVersionId: ACTIVE,
      draw: 0,
      loadable: BOTH,
    });
    if (!chosen.ok) throw new Error("unreachable");
    expect(chosen.value).toEqual({ versionId: ACTIVE, bucket: "locked" });
  });

  it("ignores a lock naming a version that cannot be loaded", () => {
    const chosen = chooseVersion(binding(), {
      lockedVersionId: asAgentsIdentifier<AgentVersionId>("version-gone"),
      draw: 0.5,
      loadable: ACTIVE_ONLY,
    });
    if (!chosen.ok) throw new Error("unreachable");
    expect(chosen.value.bucket).toBe("current");
  });

  it("NEVER takes the canary at zero percent, at any draw", () => {
    for (const draw of [0, 0.0001, 0.5, 0.999]) {
      const chosen = chooseVersion(binding({ canaryVersionId: CANARY, canaryPercent: 0 }), {
        lockedVersionId: null,
        draw,
        loadable: BOTH,
      });
      if (!chosen.ok) throw new Error("unreachable");
      expect(chosen.value.versionId).toBe(ACTIVE);
    }
  });

  it("ALWAYS takes the canary at a hundred percent, at any draw", () => {
    for (const draw of [0, 0.5, 0.999999]) {
      const chosen = chooseVersion(binding({ canaryVersionId: CANARY, canaryPercent: 100 }), {
        lockedVersionId: null,
        draw,
        loadable: BOTH,
      });
      if (!chosen.ok) throw new Error("unreachable");
      expect(chosen.value).toEqual({ versionId: CANARY, bucket: "canary" });
    }
  });

  it("splits exactly at the boundary: a draw below the share takes the canary", () => {
    const held = binding({ canaryVersionId: CANARY, canaryPercent: 25 });
    const below = chooseVersion(held, { lockedVersionId: null, draw: 0.2499, loadable: BOTH });
    const at = chooseVersion(held, { lockedVersionId: null, draw: 0.25, loadable: BOTH });
    if (!below.ok || !at.ok) throw new Error("unreachable");
    expect(below.value.bucket).toBe("canary");
    expect(at.value.bucket).toBe("current");
  });

  it("never takes a canary the binding does not name", () => {
    const chosen = chooseVersion(binding({ canaryVersionId: null, canaryPercent: 100 }), {
      lockedVersionId: null,
      draw: 0,
      loadable: BOTH,
    });
    if (!chosen.ok) throw new Error("unreachable");
    expect(chosen.value.bucket).toBe("current");
  });

  it("FALLS BACK to the active version when the canary cannot be loaded", () => {
    // A canary deleted underneath a live split must not fail the turn.
    const chosen = chooseVersion(binding({ canaryVersionId: CANARY, canaryPercent: 100 }), {
      lockedVersionId: null,
      draw: 0,
      loadable: ACTIVE_ONLY,
    });
    if (!chosen.ok) throw new Error("unreachable");
    expect(chosen.value).toEqual({ versionId: ACTIVE, bucket: "current" });
  });

  it("refuses only when even the ACTIVE version cannot be loaded", () => {
    const chosen = chooseVersion(binding(), { lockedVersionId: null, draw: 0, loadable: () => false });
    if (chosen.ok) throw new Error("unreachable");
    expect(chosen.error.code).toBe("AGENTS_VERSION_INVALID");
  });

  it("clamps a stored percentage that is out of range before it splits", () => {
    const chosen = chooseVersion(binding({ canaryVersionId: CANARY, canaryPercent: 900 }), {
      lockedVersionId: null,
      draw: 0.99,
      loadable: BOTH,
    });
    if (!chosen.ok) throw new Error("unreachable");
    expect(chosen.value.bucket).toBe("canary");
  });
});

describe("binding moves", () => {
  it("activates a new version without touching the canary", () => {
    const moved = activateVersion(binding({ canaryVersionId: CANARY, canaryPercent: 5 }), CANARY, LATER);
    expect(moved.activeVersionId).toBe(CANARY);
    expect(moved.canaryVersionId).toBe(CANARY);
    expect(moved.updatedAt).toEqual(LATER);
  });

  it("assigns and clears a cluster", () => {
    const cluster = asAgentsIdentifier<AgentClusterId>("cluster-1");
    expect(assignCluster(binding(), cluster, LATER).clusterId).toBe(cluster);
    expect(assignCluster(binding({ clusterId: cluster }), null, LATER).clusterId).toBeNull();
  });
});

describe("unbinding", () => {
  it("deactivates the agent when this was the LAST binding", () => {
    expect(unbind(binding(), 0)).toEqual({ removedBindingId: "binding-1", deactivatesAgent: true });
  });

  it("leaves the agent active while another environment still binds it", () => {
    expect(unbind(binding(), 1).deactivatesAgent).toBe(false);
  });

  it("reports the two facts separately, so neither is inferred from the other", () => {
    const outcome = unbind(binding(), 2);
    expect(outcome.removedBindingId).toBe("binding-1");
    expect(outcome.deactivatesAgent).toBe(false);
  });
});
