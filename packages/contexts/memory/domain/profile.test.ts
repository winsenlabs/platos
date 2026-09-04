import { asIdentifier, environmentScope } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { EndUserId, MemoryId, ProfileKey } from "./identifiers.js";
import { NO_CONFIDENCE, NO_PROVENANCE, type Memory } from "./memory.js";
import {
  admitNarrative,
  decideSynthesis,
  DEFAULT_SYNTHESIS_THROTTLE_MS,
  isSynthesizedProfile,
  isWithinThrottle,
  MAX_SYNTHESIS_ATOMS,
  MIN_SYNTHESIS_ATOMS,
  projectProfile,
  renderAtoms,
  selectSynthesisAtoms,
  synthesisMetadata,
  synthesizedAt,
} from "./profile.js";
import { memorySubject } from "./scope.js";
import { SYNTHESIZED_PROFILE_KEY, type MemoryKind, type MemorySource } from "./taxonomy.js";

const ENVIRONMENT = environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1"));
const SUBJECT = memorySubject(ENVIRONMENT, asIdentifier<EndUserId>("user-1"));
const NOW = new Date("2026-09-03T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

let sequence = 0;
function memory(overrides: Partial<Memory> = {}): Memory {
  sequence += 1;
  return {
    memoryId: asIdentifier<MemoryId>(`mem-${sequence}`),
    subject: SUBJECT,
    ownership: { agentId: asIdentifier("agent-1"), clusterId: null },
    kind: "fact",
    profileKey: null,
    content: "prefers tea",
    metadata: null,
    visibility: "agent_visible",
    source: "manual",
    contentHash: null,
    provenance: NO_PROVENANCE,
    confidence: NO_CONFIDENCE,
    lifecycle: {
      lastAccessedAt: null,
      quarantinedAt: null,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    ...overrides,
  };
}

function atoms(count: number, kind: MemoryKind = "fact", source: MemorySource = "manual"): Memory[] {
  return Array.from({ length: count }, () => memory({ kind, source }));
}

function synthesized(at: string | null, updatedAt: Date = NOW): Memory {
  return memory({
    kind: "profile",
    profileKey: SYNTHESIZED_PROFILE_KEY,
    content: "You lead platform.",
    metadata: at === null ? { profileKey: SYNTHESIZED_PROFILE_KEY } : { profileKey: SYNTHESIZED_PROFILE_KEY, synthesizedAt: at },
    lifecycle: { ...memory().lifecycle, updatedAt },
  });
}

describe("recognising the maintained narrative", () => {
  it("is a profile row under the reserved key, and nothing else", () => {
    expect(isSynthesizedProfile(synthesized(NOW.toISOString()))).toBe(true);
    expect(isSynthesizedProfile(memory({ kind: "profile", profileKey: asIdentifier<ProfileKey>("role") }))).toBe(
      false,
    );
    expect(isSynthesizedProfile(memory())).toBe(false);
  });

  it("reads the stamp when it is a valid instant, and null otherwise", () => {
    expect(synthesizedAt(synthesized(NOW.toISOString()))?.getTime()).toBe(NOW.getTime());
    expect(synthesizedAt(synthesized(null))).toBeNull();
    expect(synthesizedAt(synthesized("last tuesday"))).toBeNull();
  });
});

describe("the throttle", () => {
  it("defaults to one hour", () => {
    expect(DEFAULT_SYNTHESIS_THROTTLE_MS).toBe(HOUR);
  });

  it("holds inside the window and releases outside it", () => {
    const prior = synthesized(new Date(NOW.getTime() - 30 * 60 * 1000).toISOString());
    expect(isWithinThrottle(prior, NOW, HOUR)).toBe(true);
    expect(isWithinThrottle(prior, NOW, 15 * 60 * 1000)).toBe(false);
  });

  it("releases exactly AT the window, not one tick early", () => {
    const prior = synthesized(new Date(NOW.getTime() - HOUR).toISOString());
    expect(isWithinThrottle(prior, NOW, HOUR)).toBe(false);
  });

  it("treats a row with NO readable stamp as stale, not as fresh", () => {
    expect(isWithinThrottle(synthesized(null), NOW, HOUR)).toBe(false);
  });

  it("treats an absent prior as stale", () => {
    expect(isWithinThrottle(null, NOW, HOUR)).toBe(false);
  });
});

describe("selectSynthesisAtoms", () => {
  it("keeps the four atom kinds and drops the profile output", () => {
    const held = [...atoms(2), memory({ kind: "profile", profileKey: SYNTHESIZED_PROFILE_KEY })];
    expect(selectSynthesisAtoms(held)).toHaveLength(2);
  });

  it("drops retrieval-augmented rows — they are documents, not things said", () => {
    const held = [...atoms(2), memory({ source: "rag" })];
    expect(selectSynthesisAtoms(held)).toHaveLength(2);
  });

  it("keeps extracted and imported rows", () => {
    const held = [memory({ source: "extracted" }), memory({ source: "imported" })];
    expect(selectSynthesisAtoms(held)).toHaveLength(2);
  });

  it("caps at the number the model is shown", () => {
    expect(selectSynthesisAtoms(atoms(MAX_SYNTHESIS_ATOMS + 20))).toHaveLength(MAX_SYNTHESIS_ATOMS);
  });
});

describe("decideSynthesis", () => {
  it("proceeds with enough atoms and no recent narrative", () => {
    const decision = decideSynthesis(atoms(MIN_SYNTHESIS_ATOMS), null, NOW);
    expect(decision.proceed).toBe(true);
    if (!decision.proceed) throw new Error("unreachable");
    expect(decision.atoms).toHaveLength(MIN_SYNTHESIS_ATOMS);
  });

  it("REFUSES under the atom floor", () => {
    const decision = decideSynthesis(atoms(MIN_SYNTHESIS_ATOMS - 1), null, NOW);
    expect(decision.proceed).toBe(false);
    if (decision.proceed) throw new Error("unreachable");
    expect(decision.reason).toBe("too-few-atoms");
  });

  it("REFUSES inside the throttle window, and reports it as throttled", () => {
    const prior = synthesized(NOW.toISOString());
    const decision = decideSynthesis([...atoms(10), prior], prior, NOW);
    expect(decision.proceed).toBe(false);
    if (decision.proceed) throw new Error("unreachable");
    expect(decision.reason).toBe("throttled");
  });

  it("checks the THROTTLE before the atom count, so a fresh profile is not `too-few`", () => {
    const prior = synthesized(NOW.toISOString());
    const decision = decideSynthesis([prior], prior, NOW);
    expect(decision.proceed).toBe(false);
    if (decision.proceed) throw new Error("unreachable");
    expect(decision.reason).toBe("throttled");
  });

  it("`force` bypasses the throttle but NOT the atom floor", () => {
    const prior = synthesized(NOW.toISOString());
    const forced = decideSynthesis([...atoms(10), prior], prior, NOW, { force: true });
    expect(forced.proceed).toBe(true);
    const starved = decideSynthesis([prior], prior, NOW, { force: true });
    expect(starved.proceed).toBe(false);
    if (starved.proceed) throw new Error("unreachable");
    expect(starved.reason).toBe("too-few-atoms");
  });

  it("honours an explicit throttle window", () => {
    const prior = synthesized(new Date(NOW.getTime() - 2 * HOUR).toISOString());
    expect(decideSynthesis([...atoms(10), prior], prior, NOW, { throttleMs: HOUR }).proceed).toBe(true);
    expect(decideSynthesis([...atoms(10), prior], prior, NOW, { throttleMs: 4 * HOUR }).proceed).toBe(
      false,
    );
  });
});

describe("rendering and stamping", () => {
  it("renders one atom per line, kind first", () => {
    expect(renderAtoms([memory({ kind: "preference", content: "tea over coffee" })])).toBe(
      "(preference) tea over coffee",
    );
  });

  it("stamps the reserved key, the instant and the atom count", () => {
    const metadata = synthesisMetadata(NOW, 12);
    expect(metadata?.["profileKey"]).toBe(SYNTHESIZED_PROFILE_KEY);
    expect(metadata?.["synthesizedAt"]).toBe(NOW.toISOString());
    expect(metadata?.["atomCount"]).toBe(12);
  });

  it("admits a trimmed narrative and refuses an empty one", () => {
    expect(admitNarrative("  You lead platform.  ")).toBe("You lead platform.");
    expect(admitNarrative("   \n ")).toBeNull();
    expect(admitNarrative("")).toBeNull();
  });
});

describe("projectProfile", () => {
  it("keys the projection by profile key", () => {
    const projection = projectProfile([
      memory({ kind: "profile", profileKey: asIdentifier<ProfileKey>("role"), content: "leads platform" }),
      memory({ kind: "profile", profileKey: asIdentifier<ProfileKey>("name"), content: "Sam" }),
    ]);
    expect(projection).toEqual({ role: "leads platform", name: "Sam" });
  });

  it("ignores rows that are not profiles", () => {
    expect(projectProfile([memory()])).toEqual({});
  });

  it("lets the NEWEST write win when a cluster read spans several owners", () => {
    const older = memory({
      kind: "profile",
      profileKey: asIdentifier<ProfileKey>("role"),
      content: "older",
      lifecycle: { ...memory().lifecycle, updatedAt: new Date(NOW.getTime() - HOUR) },
    });
    const newer = memory({
      kind: "profile",
      profileKey: asIdentifier<ProfileKey>("role"),
      content: "newer",
      lifecycle: { ...memory().lifecycle, updatedAt: NOW },
    });
    expect(projectProfile([newer, older])["role"]).toBe("newer");
  });
});
