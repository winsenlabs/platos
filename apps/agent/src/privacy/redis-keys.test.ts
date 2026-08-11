import { describe, it, expect } from "vitest";
import {
  toDeletableKey, toWireKey, subjectKeyPatterns, retainedAggregatePatterns,
  isRetainedAggregateKey, planDeletions, REDIS_KEY_PREFIX,
} from "./redis-keys";

const refs = {
  threadIds: ["t1"],
  legacyUserIds: ["u1"],
  platosEndUserIds: ["eu1"],
  scopes: [{ organizationId: "o", projectId: "p", environmentId: "e" }],
};

describe("the prefix asymmetry that already caused a live bug", () => {
  it("strips the prefix scan() returns so del() does not re-add it", () => {
    // scan gives "platos:trace:thread:x"; del re-prefixes -> "platos:platos:…"
    // which matches nothing and reports success. A double-prefixed key survives
    // on the live deployment today: platos:platos:dlq:spans:dead
    expect(toDeletableKey("platos:trace:thread:x")).toBe("trace:thread:x");
  });

  it("is idempotent — safe on an already-stripped key", () => {
    expect(toDeletableKey("trace:thread:x")).toBe("trace:thread:x");
    expect(toDeletableKey(toDeletableKey("platos:trace:thread:x"))).toBe("trace:thread:x");
  });

  it("round-trips to the on-wire form for verification", () => {
    expect(toWireKey("trace:thread:x")).toBe("platos:trace:thread:x");
    expect(toWireKey("platos:trace:thread:x")).toBe("platos:trace:thread:x");
  });

  it("emits scan patterns WITHOUT the prefix", () => {
    // ioredis prefixes scan patterns too; a prefixed pattern matches nothing.
    for (const p of subjectKeyPatterns(refs)) {
      expect(p.startsWith(REDIS_KEY_PREFIX)).toBe(false);
    }
  });
});

describe("subject key coverage", () => {
  it("covers per-thread traces — the keys the spec named", () => {
    expect(subjectKeyPatterns(refs)).toContain("trace:thread:t1");
  });

  it("covers per-user cost counters, which ARE deletable", () => {
    const p = subjectKeyPatterns(refs);
    expect(p).toContain("cost:user:o:p:e:u1:*");
  });

  it("covers working memory and session cursors that could rehydrate a thread", () => {
    const p = subjectKeyPatterns(refs);
    expect(p).toContain("wm:t1:*");
    expect(p.some((x) => x.startsWith("chatsess:cursor:"))).toBe(true);
  });

  it("produces a stable, de-duplicated plan", () => {
    const a = subjectKeyPatterns(refs);
    const b = subjectKeyPatterns({ ...refs, threadIds: ["t1", "t1"] });
    expect(a).toEqual(b);
  });
});

describe("aggregates are retained, never silently skipped", () => {
  it("classifies scope and agent rollups as retained", () => {
    expect(isRetainedAggregateKey("platos:cost:scope:o:p:e:2026-08-01")).toBe(true);
    expect(isRetainedAggregateKey("cost:agent:o:p:e:agent1:2026-08-01")).toBe(true);
  });

  it("does NOT classify per-user cost as an aggregate", () => {
    // The distinction that matters: this one is the subject's and must go.
    expect(isRetainedAggregateKey("platos:cost:user:o:p:e:u1:2026-08-01")).toBe(false);
  });

  it("reports retained patterns so the receipt can explain them", () => {
    const r = retainedAggregatePatterns(refs);
    expect(r).toContain("cost:scope:o:p:e:*");
    expect(r).toContain("cost:agent:o:p:e:*");
  });
});

describe("planDeletions — the last line of defence", () => {
  it("separates subject keys from aggregates and strips the prefix", () => {
    const { deletable, retained } = planDeletions([
      "platos:trace:thread:t1",
      "platos:cost:user:o:p:e:u1:2026-08-01",
      "platos:cost:scope:o:p:e:2026-08-01",
      "platos:cost:agent:o:p:e:a1:2026-08-01",
    ]);
    expect(deletable).toEqual(["cost:user:o:p:e:u1:2026-08-01", "trace:thread:t1"]);
    expect(retained).toEqual(["cost:agent:o:p:e:a1:2026-08-01", "cost:scope:o:p:e:2026-08-01"]);
  });

  it("would stop an over-broad pattern from taking the rollups", () => {
    // Asserting per concrete key, not trusting the pattern that produced it:
    // `cost:*` is one edit away and would destroy billing history.
    const { deletable } = planDeletions(["platos:cost:scope:o:p:e:2026-08-01"]);
    expect(deletable).toEqual([]);
  });

  it("never emits a prefixed key to the delete path", () => {
    const { deletable } = planDeletions(["platos:trace:thread:a", "platos:wm:b:1"]);
    for (const k of deletable) expect(k.startsWith(REDIS_KEY_PREFIX)).toBe(false);
  });

  it("ignores empty entries", () => {
    expect(planDeletions(["", "platos:trace:thread:a"]).deletable).toEqual(["trace:thread:a"]);
  });
});
