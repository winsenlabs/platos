/**
 * Subagent-spawning guardrail unit tests (docs/subagent-spawning-spec.md §
 * "Guardrails (non-negotiable)").
 *
 * CLAUDE.md §9.11: Vitest only, never mock. Every guardrail here is a pure
 * function over server-held state, so no Prisma/Redis/Nest is needed — the
 * security properties (depth cap, children cap, tool-ACL subset, dedupe
 * determinism, budget floor, scope-inheritance shape) are asserted directly.
 */
import { describe, it, expect } from "vitest";
import {
  SUBAGENT_MAX_DEPTH,
  SUBAGENT_DEFAULT_CHILDREN_PER_TURN,
  SUBAGENT_DONE_MARKER,
  normalizeSpawnDepth,
  childSpawnDepth,
  isSpawnDepthAllowed,
  narrowSpawnToolAcl,
  resolveMaxChildrenPerTurn,
  spawnDedupeKey,
  budgetExhausted,
  isSubagentDoneSignal,
  buildSubagentReportMessage,
} from "./subagent-guardrails";

describe("depth cap ≤ 2 (grandchildren may not spawn)", () => {
  it("root (0) may spawn a depth-1 child", () => {
    expect(isSpawnDepthAllowed(0)).toBe(true);
    expect(childSpawnDepth(0)).toBe(1);
  });

  it("a depth-1 child may spawn once more (depth-2 grandchild)", () => {
    expect(isSpawnDepthAllowed(1)).toBe(true);
    expect(childSpawnDepth(1)).toBe(2);
  });

  it("a depth-2 grandchild may NOT spawn (depth-3 rejected)", () => {
    expect(isSpawnDepthAllowed(2)).toBe(false);
    expect(childSpawnDepth(2)).toBe(3);
    expect(childSpawnDepth(2)).toBeGreaterThan(SUBAGENT_MAX_DEPTH);
  });

  it("deeper depths stay rejected", () => {
    expect(isSpawnDepthAllowed(3)).toBe(false);
    expect(isSpawnDepthAllowed(99)).toBe(false);
  });

  it("absent / malformed depth is treated as root (fail-safe, not fail-open-deep)", () => {
    expect(normalizeSpawnDepth(undefined)).toBe(0);
    expect(normalizeSpawnDepth(null)).toBe(0);
    expect(normalizeSpawnDepth(-5)).toBe(0);
    expect(normalizeSpawnDepth(1.9)).toBe(1);
    expect(isSpawnDepthAllowed(undefined)).toBe(true); // undefined → depth 0 → child 1, allowed
  });
});

describe("children cap per turn", () => {
  it("defaults to 5 when neither override nor env is set", () => {
    expect(resolveMaxChildrenPerTurn(undefined, undefined)).toBe(SUBAGENT_DEFAULT_CHILDREN_PER_TURN);
    expect(SUBAGENT_DEFAULT_CHILDREN_PER_TURN).toBe(5);
  });

  it("per-agent override wins over env and default", () => {
    expect(resolveMaxChildrenPerTurn(3, "9")).toBe(3);
  });

  it("env value applies when no per-agent override", () => {
    expect(resolveMaxChildrenPerTurn(null, "8")).toBe(8);
    expect(resolveMaxChildrenPerTurn(undefined, 7)).toBe(7);
  });

  it("never resolves below 1 even if misconfigured to 0/negative", () => {
    expect(resolveMaxChildrenPerTurn(0, undefined)).toBe(1);
    expect(resolveMaxChildrenPerTurn(-4, undefined)).toBe(1);
    expect(resolveMaxChildrenPerTurn(undefined, "0")).toBe(1);
  });

  it("simulates the redis-incr cap: the Nth spawn past the cap is rejected", () => {
    // Mirrors the handler: incr a shared counter, reject once count > cap.
    const cap = resolveMaxChildrenPerTurn(undefined, undefined); // 5
    let counter = 0;
    const results: boolean[] = [];
    for (let i = 0; i < 7; i++) {
      counter += 1; // redis.incr
      results.push(counter <= cap); // allowed?
    }
    expect(results).toEqual([true, true, true, true, true, false, false]);
  });
});

describe("tool-ACL narrowing (child ⊆ parent ∩ requested)", () => {
  const parent = ["search", "send_email", "read_file", "write_file"];

  it("intersects requested with the parent matrix", () => {
    expect(narrowSpawnToolAcl(parent, ["search", "read_file"])).toEqual(["search", "read_file"]);
  });

  it("drops requested tools the parent does NOT hold (no privilege escalation)", () => {
    // "delete_db" is not in the parent matrix — a child can never gain it.
    expect(narrowSpawnToolAcl(parent, ["search", "delete_db"])).toEqual(["search"]);
  });

  it("a requested superset collapses to exactly the parent set", () => {
    const requested = [...parent, "admin_wipe", "billing_export"];
    const result = narrowSpawnToolAcl(parent, requested);
    expect(result).toEqual(parent);
    // strict subset invariant: every child tool is a parent tool
    expect(result.every((t) => parent.includes(t))).toBe(true);
  });

  it("omitted/empty requested inherits the full parent matrix (still bounded)", () => {
    expect(narrowSpawnToolAcl(parent, undefined)).toEqual(parent);
    expect(narrowSpawnToolAcl(parent, [])).toEqual(parent);
  });

  it("an empty parent matrix yields an empty child regardless of request", () => {
    expect(narrowSpawnToolAcl([], ["search"])).toEqual([]);
    expect(narrowSpawnToolAcl(null, ["search"])).toEqual([]);
  });

  it("collapses duplicate parent entries", () => {
    expect(narrowSpawnToolAcl(["a", "a", "b"], undefined)).toEqual(["a", "b"]);
  });
});

describe("spawn dedupe key (parentTurnId, task-hash)", () => {
  const base = {
    organizationId: "org1",
    projectId: "proj1",
    environmentId: "env1",
    parentThreadId: "thread-abc",
    task: "research topic X",
    spec: { model: "haiku" },
  };

  it("is deterministic for identical (scope, parentThread, task, spec)", () => {
    expect(spawnDedupeKey(base)).toBe(spawnDedupeKey({ ...base }));
  });

  it("differs when the task changes", () => {
    expect(spawnDedupeKey(base)).not.toBe(spawnDedupeKey({ ...base, task: "research topic Y" }));
  });

  it("differs across parent threads (a retried turn on another thread can't cross-dedup)", () => {
    expect(spawnDedupeKey(base)).not.toBe(spawnDedupeKey({ ...base, parentThreadId: "thread-def" }));
  });

  it("differs across tenants (cuid collision can't cross-dedup)", () => {
    expect(spawnDedupeKey(base)).not.toBe(spawnDedupeKey({ ...base, organizationId: "org2" }));
  });

  it("produces a 32-char hex key (fits Trigger idempotencyKey conventions)", () => {
    expect(spawnDedupeKey(base)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("budget shared-pool floor", () => {
  it("not exhausted below the ceiling", () => {
    expect(budgetExhausted(10, 50)).toBe(false);
    expect(budgetExhausted(49, 50)).toBe(false);
  });

  it("exhausted at or above the ceiling (clean-stop condition)", () => {
    expect(budgetExhausted(50, 50)).toBe(true);
    expect(budgetExhausted(51, 50)).toBe(true);
  });

  it("no ceiling (absent / non-positive budget) never self-exhausts", () => {
    expect(budgetExhausted(9999, undefined)).toBe(false);
    expect(budgetExhausted(9999, null)).toBe(false);
    expect(budgetExhausted(9999, 0)).toBe(false);
  });

  it("simulates the accumulating turn loop stopping when the pool drains", () => {
    const budget = 30;
    const perTurn = [10, 10, 10, 10];
    let spent = 0;
    let turnsRun = 0;
    for (const c of perTurn) {
      if (budgetExhausted(spent, budget)) break;
      spent += c;
      turnsRun += 1;
    }
    // turn 1: spent 0<30 → run → 10; turn 2: 10<30 → 20; turn 3: 20<30 → 30;
    // turn 4: 30>=30 → stop. Three turns run, fourth blocked.
    expect(turnsRun).toBe(3);
    expect(spent).toBe(30);
  });
});

describe("done-signal detection", () => {
  it("detects the marker case-insensitively and mid-text", () => {
    expect(isSubagentDoneSignal(`${SUBAGENT_DONE_MARKER}: here is the answer`)).toBe(true);
    expect(isSubagentDoneSignal("all set. task_complete: done")).toBe(true);
  });

  it("returns false when the marker is absent", () => {
    expect(isSubagentDoneSignal("still working on it")).toBe(false);
    expect(isSubagentDoneSignal("")).toBe(false);
    expect(isSubagentDoneSignal(null)).toBe(false);
  });
});

describe("report-back synthetic message (scope-inheritance / wake shape)", () => {
  it("tags the report so the parent LLM recognises it and can reason over it", () => {
    const msg = buildSubagentReportMessage({
      task: "research X",
      status: "completed",
      result: "found three sources",
      costCents: 12,
      turnsUsed: 4,
      childThreadId: "child-1",
      childRunId: "run_1",
    });
    expect(msg).toContain("[subagent_report]");
    expect(msg).toContain("research X");
    expect(msg).toContain("completed");
    expect(msg).toContain("found three sources");
    expect(msg).toContain("child-1");
  });
});
